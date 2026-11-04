import { log } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { downloadClientFromRow } from "../db/mappers.js";
import type { DownloadClient, QueueItem, SearchResult } from "../types/index.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decodeSlskdDownloadUrl, decodeSlskdFolderUrl, parseSlskdFolderDownloadId, slskdFolderDownloadId } from "./soulseek.js";
import { getSetting } from "./settingsStore.js";
import { MEDIA_TYPES } from "./mediaTypes.js";
import { categoryForType, clientCategories } from "./clientCategory.js";
import { clientBaseUrl, normalizeUrlBase } from "./urlBase.js";

/** Streams a fetch() body to disk with backpressure. The data goes to `partial` and is only renamed
 * to `dest` once complete: a file under its final name in downloadsDir is always a finished download,
 * so the importer's fuzzy filename match can't pick one up mid-write, and a process killed mid-download
 * leaves only a `.part` file behind. On any failure the partial is removed. */
async function saveBodyToFile(
  body: ReadableStream<Uint8Array>,
  dest: string,
  partial: string,
  onChunk?: (bytes: number) => void
): Promise<void> {
  const source = Readable.fromWeb(body as any);
  if (onChunk) source.on("data", (chunk: Buffer) => onChunk(chunk.length));
  const out = fs.createWriteStream(partial);
  try {
    await pipeline(source, out);
    await fs.promises.rename(partial, dest);
  } catch (err) {
    out.destroy();
    await fs.promises.unlink(partial).catch(() => {});
    throw err;
  }
}

/** Where an in-process job writes its `fileIndex`th file until it's complete: the downloads root
 * (the same filesystem as every job folder beneath it, so the final rename is atomic), named by the
 * job's id so a job lost to a restart can still have its leftover found and removed. */
function partialPath(downloadId: string, fileIndex: number): string {
  return path.join(config.downloadsDir, `.aonarr-${downloadId}-${fileIndex}.part`);
}

/** Bounds a download-client API call. A client that accepts the connection but never answers would
 * otherwise hold its own queue poll (and the health/test routes) for undici's 5-minute default. Not for file bodies: a large download can
 * legitimately run far longer. */
const CLIENT_API_TIMEOUT_MS = 30_000;

const NETWORK_CAUSE_TEXT: Record<string, string> = {
  ECONNREFUSED: "connection refused: nothing listens on that host and port",
  ENOTFOUND: "host name not found",
  EAI_AGAIN: "host name could not be looked up",
  ETIMEDOUT: "connection timed out",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  ECONNRESET: "connection reset by the other side",
  UND_ERR_SOCKET: "the client closed the connection (NZBGet does this for a few seconds after failed logins)",
  UND_ERR_CONNECT_TIMEOUT: "connection timed out",
  CERT_HAS_EXPIRED: "the certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed certificate",
  SELF_SIGNED_CERT_IN_CHAIN: "self-signed certificate in the chain",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the certificate cannot be verified",
};

/** undici reports every network failure as "fetch failed" and keeps the reason in `cause`; the Test button and the
 * logs showed only that. The reason is added to the message, and the original error stays as the cause (the
 * scheduler walks the cause chain to tell a client that is down from a release that is bad). */
function withNetworkCause(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
  const code = typeof cause?.code === "string" ? cause.code : null;
  const detail = code ? (NETWORK_CAUSE_TEXT[code] ?? code) : typeof cause?.message === "string" ? cause.message : null;
  if (!detail || err.message.includes(detail)) return err;
  const wrapped = new Error(`${err.message} (${detail})`, { cause: err });
  wrapped.name = err.name;
  return wrapped;
}

async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(CLIENT_API_TIMEOUT_MS) });
  } catch (err) {
    throw withNetworkCause(err);
  }
}

/** Debrid services can sit in a "waiting"/"queued" state indefinitely for a dead torrent — give
 * up after this long rather than polling forever with the queue row never resolving. */
const DEBRID_POLL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export interface GrabResult {
  downloadId: string;
}

export interface QueueStatusUpdate {
  downloadId: string;
  /** Set when `downloadId` is a provisional id the adapter could only resolve now (qBittorrent: a
   * magnet URL or a `tag:` placeholder standing in for a torrent hash it didn't have yet at add
   * time) — the scheduler rewrites queue.download_id to this so every later poll, reprioritize,
   * and remove call addresses the download by its real id. */
  resolvedDownloadId?: string;
  /** The download's own name at the client (qBittorrent's torrent name) — lets a queue row whose id
   * can't be resolved any other way be matched back to it by release title. */
  clientTitle?: string;
  progress: number; // 0-1
  status: "downloading" | "completed" | "failed";
  /** Seconds the client expects the download to take still; unset when it gives none (or "never"). */
  etaSeconds?: number | null;
  /** Bytes still to download, when the client says. */
  sizeLeft?: number | null;
  /** True when the client itself reports this download as active but receiving no data (no peers /
   * no metadata). Never set for a download waiting its turn in the client's own queue, paused, or
   * being checked — those are healthy, just not running yet. */
  stalled?: boolean;
  /** True when the client holds this download paused or waiting for its turn (qBittorrent paused,
   * stopped or queued; a SABnzbd job paused or queued). It is healthy and its age says nothing: the
   * stalled-download clock must not run on it, and it is never failed or blocklisted for it. */
  paused?: boolean;
  /** Set on a "downloading" update when the client reports a problem that is the client's or its
   * environment's, not the release's: a torrent in qBittorrent's error state or with missing files, a
   * SABnzbd job that failed because the disk is full or not writable. Sonarr/Radarr treat these as
   * warnings too: the download is kept (nothing deleted, nothing blocklisted, no group failure) and the
   * message is shown, because another release would fail the same way. */
  warning?: string;
  /** Set on a "failed" update when the adapter knows why. DOWNLOAD_INTERRUPTED_REASON means the
   * download was cut off by an AoNarr restart, not rejected at the client: the release did nothing
   * wrong, so it should be retried without being blocklisted. */
  failureReason?: string;
  /** The failure says nothing about the release (NZBGet dropped it as a duplicate of something it holds): no blocklist entry. */
  noBlame?: boolean;
  /** Absolute path this download's data lives at, in the CLIENT's own filesystem namespace — as
   * reported directly by the client's own API (qBittorrent's save_path/content_path, SABnzbd's
   * history "storage" field). Set whenever the adapter has one on hand, regardless of status —
   * qBittorrent reports it while still downloading, not only once "completed" — so the scheduler
   * stores whatever is present rather than gating on status; it's run through
   * applyRemotePathMapping() before storing it either way, so nothing downstream ever sees an
   * un-translated remote path. */
  remotePath?: string;
}

/** Common surface every download client backend implements. `releaseTitle` is only used by the
 * in-process adapters (http, ytdlp) that write the file into downloadsDir themselves — naming it
 * to match gives the importer's fuzzy-match a much better target than a raw URL basename would. */
export interface DownloadClientAdapter {
  /** `protocol` is the grabbed release's own SearchResult.protocol — only read by adapters whose
   * provider handles more than one protocol (currently just TorBoxAdapter, which branches between
   * its torrent and Usenet caching APIs); every other adapter ignores it. Undefined when the
   * caller has no SearchResult on hand (e.g. an Online Videos direct download). */
  addDownload(
    client: DownloadClient,
    downloadUrl: string,
    category: string | null,
    releaseTitle?: string,
    protocol?: SearchResult["protocol"],
    options?: AddOptions
  ): Promise<GrabResult>;
  getStatus(client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]>;
  /** Not every backend has a real queue to reorder (the in-process http/ytdlp adapters start each
   * download the moment it's grabbed, with no queue of their own) — implementing this is optional;
   * callers check for its presence before offering the UI action. */
  setPriority?(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void>;
  /** Torrent-specific health: seed ratio, upload/download totals, ratio-limit config. Only
   * meaningful for backends that actually seed (qBittorrent) — usenet clients have no equivalent
   * concept, so this is optional and callers check for its presence. */
  getHealthStats?(client: DownloadClient): Promise<ClientHealthStats>;
  /** Client settings that delete or move a download before AoNarr can import it (Sonarr's
   * DownloadClientRemovesCompletedDownloadsCheck and DownloadClientSortingCheck), one sentence each, for
   * Health. Optional: only clients with such settings and an API to read them have anything to say. */
  healthNotes?(client: DownloadClient): Promise<string[]>;
  /** Radarr/Sonarr-style seed-goal cleanup: removes a torrent *from the client* (never the
   * already-imported library file — AoNarr moved/hardlinked/copied it out before this ever runs)
   * once it's met a configured ratio and/or seed-time goal, freeing the client's slot instead of
   * seeding forever unless the client's own ratio-limit settings happen to be configured
   * separately. Only meaningful for backends that actually seed. */
  /** `skipIds`: download ids (lower case) the queue still tracks, which are not removed whatever their goals. */
  removeSeededTorrents?(client: DownloadClient, ratioGoal: number | null, seedTimeGoalMinutes: number | null, skipIds?: Set<string>): Promise<number>;
  /** Marks a download AoNarr has fully imported by hardlink (or by a copy where a hardlink was not possible),
   * so the client holds nothing the library does not also hold: its data may be deleted once seeding is
   * over. Optional: only a torrent client with tags has anything to mark. */
  markImported?(client: DownloadClient, downloadId: string, seedGoal?: SeedGoal | null, dataSafe?: boolean): Promise<void>;
  /** Removes one finished (or dead) download from the client itself — called once AoNarr is done
   * with it, either because it imported successfully or because it failed at the client and won't
   * be retried from that same task. `deleteFiles` also removes the client's own copy of the data;
   * false only makes sense for a torrent client where the data must keep existing (still seeding).
   * Optional: not every backend has anything to remove (the in-process http/ytdlp adapters, a
   * blackhole watch folder) or an API that supports it — callers check for its presence first. */
  removeDownload?(client: DownloadClient, downloadId: string, deleteFiles: boolean): Promise<void>;
}

export interface ClientHealthStats {
  uploadedTotalBytes: number;
  downloadedTotalBytes: number;
  globalRatio: number | null;
  ratioLimitEnabled: boolean;
  ratioLimit: number | null;
  torrentsOverRatioLimit: number;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").trim().slice(0, 180);
}

export type ResolvedDownloadSource = { kind: "magnet"; uri: string } | { kind: "torrent"; bytes: Buffer };

/**
 * Resolves an indexer's `downloadUrl` to something a debrid provider (Real-Debrid, AllDebrid) can
 * actually consume — a real `magnet:` URI or raw `.torrent` bytes. A literal magnet needs no
 * resolution; anything else is typically a Torznab "get"/proxy endpoint that either 302-redirects
 * to a magnet link or serves the `.torrent` file directly, neither of which is safe to hand to a
 * debrid provider's magnet-upload endpoint as-is (see the AllDebrid `MAGNET_INVALID_URI` reports
 * this fixed — passing the proxy URL itself, rather than what it resolves to, was rejected outright).
 * `fetch` is called with `redirect: "manual"` specifically so a redirect Location pointing at a
 * `magnet:` URI can be read directly — the platform fetch implementation can't follow a redirect to
 * a non-http(s) scheme at all (it would just fail the request), so redirects must be handled by hand
 * here rather than left to the default `redirect: "follow"` behavior.
 */
async function resolveDownloadSource(downloadUrl: string): Promise<ResolvedDownloadSource> {
  if (downloadUrl.startsWith("magnet:")) return { kind: "magnet", uri: downloadUrl };

  let url = downloadUrl;
  for (let redirects = 0; redirects < 5; redirects++) {
    // The indexer not answering is the indexer's failure, not the download client's: named so, it is not put on the client's back-off.
    const res = await apiFetch(url, { redirect: "manual" }).catch((err) => {
      throw new Error(`Failed to resolve download URL: the indexer did not answer (${err instanceof Error ? err.message : String(err)})`, { cause: err });
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect from "${url}" had no Location header`);
      if (location.startsWith("magnet:")) return { kind: "magnet", uri: location };
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Failed to resolve download URL: HTTP ${res.status}`);
    return { kind: "torrent", bytes: Buffer.from(await res.arrayBuffer()) };
  }
  throw new Error(`Too many redirects resolving download URL "${downloadUrl}"`);
}

export { normalizeUrlBase };

function baseUrl(client: DownloadClient): string {
  return clientBaseUrl(client);
}

export { categoryForType, clientCategories };

/**
 * SABnzbd answers a wrong or missing API key and a host name it does not accept with HTTP 403 and a plain-text body
 * ("API Key Incorrect", "Access denied - Hostname verification failed"); the body is what tells the admin which.
 */
async function sabnzbdHttpError(res: Response, prefix = ""): Promise<string> {
  let text = "";
  try {
    text = (await res.text()).replace(/<[^>]*>/g, " ").replace(/apikey=[^&\s]*/gi, "apikey=…").replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    // no readable body: the status is all there is
  }
  const hint = /hostname verification/i.test(text) ? " Add this host name to host_whitelist in SABnzbd (Config > Special), or use the address SABnzbd lists." : "";
  return `${prefix}HTTP ${res.status}${text ? ` (${text})` : ""}.${hint}`;
}

/** One SABnzbd API call. SABnzbd reports a bad or missing API key as HTTP 200 with
 * `{status: false, error}`, which reads like any other JSON body unless it's checked for. */
async function sabnzbdApi(client: DownloadClient, params: Record<string, string>): Promise<any> {
  const url = new URL(`${baseUrl(client)}/api`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("apikey", client.apiKey ?? "");
  url.searchParams.set("output", "json");
  const res = await apiFetch(url.toString());
  if (!res.ok) throw new Error(await sabnzbdHttpError(res));
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new Error("Unexpected (non-JSON) response — check host/port/API key.");
  }
  if (body?.error || body?.status === false) throw new Error(String(body.error ?? "Request rejected — check the API key."));
  return body;
}

/**
 * Radarr-style "Test" on the Download Client edit form — validates connectivity/credentials
 * against the already-saved row (same pattern as indexers' own POST /:id/test) without needing to
 * grab anything. Deliberately its own lightweight per-type check rather than reusing each
 * adapter's addDownload/getStatus, since those assume a real in-flight download and some (the
 * in-process http/ytdlp/blackhole "clients") have no remote service to reach at all.
 */
export async function testDownloadClientConnection(client: DownloadClient): Promise<void> {
  switch (client.type) {
    case "qbittorrent": {
      const res = await apiFetch(`${baseUrl(client)}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: client.username ?? "", password: client.password ?? "" }),
      });
      const text = await res.text();
      if (!res.ok || text.trim() === "Fails.") throw new Error("Login rejected — check host/port/username/password.");
      return;
    }
    case "sabnzbd": {
      const body = await sabnzbdApi(client, { mode: "version" });
      if (!body?.version) throw new Error("Unexpected response — check host/port/API key.");
      // SABnzbd answers "version" without checking the API key at all, so only a call that needs
      // the full key can tell a wrong one apart from a right one.
      await sabnzbdApi(client, { mode: "queue", limit: "1" });
      return;
    }
    case "realdebrid": {
      const res = await apiFetch("https://api.real-debrid.com/rest/1.0/user", {
        headers: { Authorization: `Bearer ${client.apiKey}` },
      });
      if (!res.ok) throw new Error(res.status === 401 ? "API token rejected." : `HTTP ${res.status}`);
      return;
    }
    case "alldebrid": {
      const url = new URL("https://api.alldebrid.com/v4/user");
      url.searchParams.set("agent", "aonarr");
      url.searchParams.set("apikey", client.apiKey ?? "");
      const res = await apiFetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      if (body.status === "error") throw new Error(body.error?.message ?? "API key rejected.");
      return;
    }
    case "torbox": {
      const res = await apiFetch("https://api.torbox.app/v1/api/user/me", {
        headers: { Authorization: `Bearer ${client.apiKey}` },
      });
      if (!res.ok) throw new Error(res.status === 401 ? "API key rejected." : `HTTP ${res.status}`);
      const body: any = await res.json();
      if (body.success === false) throw new Error(body.detail ?? "API key rejected.");
      return;
    }
    case "slskd": {
      const res = await apiFetch(`${baseUrl(client)}/api/v0/transfers/downloads`, {
        headers: client.apiKey ? { "X-API-Key": client.apiKey } : {},
      });
      if (!res.ok) throw new Error(res.status === 401 ? "API key rejected." : `HTTP ${res.status}`);
      return;
    }
    case "nzbget":
      return testNzbget(client);
    case "transmission":
      return testTransmission(client);
    case "deluge":
      return testDeluge(client);
    case "blackhole": {
      if (!client.host) throw new Error("No watch folder path configured.");
      try {
        fs.accessSync(client.host, fs.constants.W_OK);
      } catch {
        throw new Error(`"${client.host}" doesn't exist or isn't writable from inside the container.`);
      }
      return;
    }
    case "http":
    case "ytdlp":
      // No external service to reach — these download straight into downloadsDir themselves.
      return;
    default:
      throw new Error(`No connection test implemented for client type "${client.type}"`);
  }
}

const QBIT_TAG = "aonarr";
/** Set on a torrent once AoNarr has imported all of it by hardlink: its data is then safe to delete after seeding. */
const QBIT_IMPORTED_TAG = "aonarr-imported";
/** A torrent from an indexer with its own seed goal carries it as a tag: "aonarr-seed:<ratio>:<minutes>", either part may be empty. */
const QBIT_SEED_GOAL_PREFIX = "aonarr-seed:";

export interface SeedGoal {
  ratio: number | null;
  minutes: number | null;
}

/** What a grab tells the client beyond the release itself. */
export interface AddOptions {
  /** The seed goal that applies to the torrent (its indexer's, else the global one): sent to a client that can hold it. */
  seedGoal?: SeedGoal | null;
}

/** The tag that records an indexer's seed goal on a torrent, or null when the indexer sets none. */
export function seedGoalTag(goal: SeedGoal | null | undefined): string | null {
  if (!goal || (goal.ratio == null && goal.minutes == null)) return null;
  return `${QBIT_SEED_GOAL_PREFIX}${goal.ratio ?? ""}:${goal.minutes ?? ""}`;
}

/** The seed goal a torrent's tag list records, or null when it has none. */
export function parseSeedGoalTag(tags: string): SeedGoal | null {
  for (const raw of tags.split(",")) {
    const tag = raw.trim();
    if (!tag.startsWith(QBIT_SEED_GOAL_PREFIX)) continue;
    const [ratioText, minutesText] = tag.slice(QBIT_SEED_GOAL_PREFIX.length).split(":");
    const ratio = ratioText ? Number(ratioText) : NaN;
    const minutes = minutesText ? Number(minutesText) : NaN;
    return { ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : null, minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null };
  }
  return null;
}
const QBIT_PENDING_TAG_PREFIX = "aonarr-pending-";

/** States in which a torrent can already report progress 1 while its data isn't ready to import:
 * "moving" is qBittorrent relocating it out of the "Keep incomplete torrents in" folder (content_path
 * keeps naming the old location until the move ends, and a cross-filesystem move takes minutes), the
 * checking states are a recheck whose verdict isn't in yet, and missingFiles has no data at all. */
const QBIT_UNSETTLED_STATES = new Set(["moving", "checkingUP", "checkingDL", "checkingResumeData", "allocating", "metaDL", "missingFiles", "unknown"]);

/** The largest .torrent file uploaded to qBittorrent (a real one is well under a megabyte, a big multi-file pack a few). */
const QBIT_MAX_TORRENT_BYTES = 16 * 1024 * 1024;

/** Fetching the torrent's metadata from peers: size 0, no content_path, nothing to say about progress or location yet. */
const QBIT_NO_METADATA_STATES = new Set(["metaDL", "forcedMetaDL"]);

/** Started and allowed to run, but getting nothing: no metadata from any peer yet, or no peer
 * sending data. queuedDL (waiting for a slot) and the paused/checking states are not stalled. */
const QBIT_STALLED_STATES = new Set(["metaDL", "forcedMetaDL", "stalledDL"]);

/** Held by the user, waiting its turn in qBittorrent's own queue, or busy checking or moving its data: not a
 * download that has gone wrong, and its age says nothing. */
const QBIT_PAUSED_STATES = new Set(["pausedDL", "stoppedDL", "queuedDL", "checkingDL", "checkingResumeData", "allocating", "moving"]);

/** qBittorrent's own words for a torrent it can't run: the download folder is full or unwritable, or the
 * files it was using are gone. Whatever the release, another one would meet the same. */
const QBIT_WARNING_STATES: Record<string, string> = {
  error: "qBittorrent reports an error for this torrent (often a full or unwritable download folder); check the client",
  missingFiles: "qBittorrent reports that this torrent's files are missing; check the client",
};

/** SABnzbd's reasons for a failed job that are the disk's, not the NZB's ("Unpacking failed, write error
 * or disk is full?" and its relatives). */
const SABNZBD_ENVIRONMENT_FAILURE =
  /write error|disk is full|no space left|out of (?:disk )?space|permission denied|read-only file system|cannot create|unable to create|name too long|not enough (?:disk )?space/i;

function base32ToHex(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of value.toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  let hex = "";
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** A magnet link's v1 info-hash in the form qBittorrent reports it (40 lowercase hex chars) —
 * magnets carry it either as hex or as 32-char base32. Null for anything else. */
export function magnetInfoHash(url: string): string | null {
  const match = /^magnet:\?.*?\bxt=urn:btih:([a-z0-9]+)/i.exec(url);
  if (!match) return null;
  if (/^[0-9a-f]{40}$/i.test(match[1])) return match[1].toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(match[1])) return base32ToHex(match[1]);
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The v1 info-hash of a .torrent file: the SHA-1 of the bencoded "info" dictionary exactly as it sits in the file. Null for
 * anything that is not a torrent (or a v2-only one, which qBittorrent keys by a SHA-256 this does not compute).
 */
export function torrentInfoHash(bytes: Buffer): string | null {
  const skip = (at: number, depth: number): number => {
    if (depth > 64 || at >= bytes.length) throw new Error("bad bencode");
    const c = bytes[at];
    if (c === 0x69) {
      const end = bytes.indexOf(0x65, at);
      if (end < 0) throw new Error("bad bencode");
      return end + 1;
    }
    if (c === 0x6c || c === 0x64) {
      let i = at + 1;
      while (bytes[i] !== 0x65) {
        if (i >= bytes.length) throw new Error("bad bencode");
        i = skip(i, depth + 1);
      }
      return i + 1;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = bytes.indexOf(0x3a, at);
      if (colon < 0) throw new Error("bad bencode");
      const length = Number(bytes.subarray(at, colon).toString("ascii"));
      if (!Number.isInteger(length) || length < 0 || colon + 1 + length > bytes.length) throw new Error("bad bencode");
      return colon + 1 + length;
    }
    throw new Error("bad bencode");
  };
  try {
    if (bytes[0] !== 0x64) return null;
    let i = 1;
    while (i < bytes.length && bytes[i] !== 0x65) {
      const keyEnd = skip(i, 1);
      const colon = bytes.indexOf(0x3a, i);
      const key = bytes.subarray(colon + 1, keyEnd).toString("latin1");
      const valueEnd = skip(keyEnd, 1);
      if (key === "info") {
        const info = bytes.subarray(keyEnd, valueEnd);
        // A v2-only torrent has "meta version" 2 and no "pieces": qBittorrent keys it by a SHA-256 this does not compute.
        if (info.includes("12:meta versioni2e") && !info.includes("6:pieces")) return null;
        return crypto.createHash("sha1").update(info).digest("hex");
      }
      i = valueEnd;
    }
  } catch {
    return null;
  }
  return null;
}


/** qBittorrent Web API (v4.1+) adapter.
 *
 * qBittorrent's add call returns no hash, but every status/priority/remove call is keyed by one —
 * so the real info-hash is resolved at add time: parsed straight out of a magnet link, or (for a
 * .torrent URL, which qBittorrent fetches itself, asynchronously) found again through a unique
 * per-add tag. A torrent that still hasn't shown up by the end of that short wait keeps a
 * `tag:<tag>` placeholder id that getStatus reports alongside the real hash, so the next queue poll
 * rewrites it. Every add also carries a plain "aonarr" tag, which is what scopes seed-goal cleanup
 * to AoNarr's own torrents on a client shared with other apps. */
class QBittorrentAdapter implements DownloadClientAdapter {
  private cookieCache = new Map<number, string>();
  private listCache = new Map<number, { at: number; torrents: any[] }>();

  /** fetch() with the cached SID; on a 403 (qBittorrent restarted / session expired) the cookie
   * is dropped and the request retried once with a fresh login instead of failing every poll
   * until AoNarr itself restarts. */
  private async authedFetch(client: DownloadClient, url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async () => {
      const cookie = await this.login(client);
      return apiFetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Cookie: cookie } });
    };
    let res = await attempt();
    if (res.status === 403) {
      this.cookieCache.delete(client.id);
      res = await attempt();
    }
    return res;
  }

  private async login(client: DownloadClient): Promise<string> {
    const cached = this.cookieCache.get(client.id);
    if (cached) return cached;

    const res = await apiFetch(`${baseUrl(client)}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: client.username ?? "",
        password: client.password ?? "",
      }),
    });
    const cookie = res.headers.get("set-cookie");
    if (!res.ok || !cookie) {
      throw new Error(`Failed to authenticate with qBittorrent client "${client.name}"`);
    }
    const sid = cookie.split(";")[0];
    this.cookieCache.set(client.id, sid);
    return sid;
  }

  private async postForm(client: DownloadClient, endpoint: string, form: Record<string, string>): Promise<Response> {
    return this.authedFetch(client, `${baseUrl(client)}/api/v2/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
  }

  private async hashForTag(client: DownloadClient, tag: string): Promise<string | null> {
    const res = await this.authedFetch(client, `${baseUrl(client)}/api/v2/torrents/info?tag=${encodeURIComponent(tag)}`);
    if (!res.ok) return null;
    const torrents = (await res.json()) as any[];
    // Re-checked rather than trusting the filter: qBittorrent before 4.2 has no tags at all and
    // silently ignores ?tag=, returning every torrent — the first of which isn't this one.
    const match = torrents.find((t) =>
      String(t.tags ?? "")
        .split(",")
        .map((s: string) => s.trim())
        .includes(tag)
    );
    return typeof match?.hash === "string" ? match.hash : null;
  }

  /** The real hash behind whatever id a queue row holds — a hash as-is, a magnet's own btih, or a
   * pending tag looked up live. A legacy .torrent-URL id (from before hashes were resolved at add
   * time) has no way back to its torrent and comes back unchanged. */
  private async resolveHash(client: DownloadClient, downloadId: string): Promise<string> {
    if (downloadId.startsWith("tag:")) return (await this.hashForTag(client, downloadId.slice(4))) ?? downloadId;
    const hash = magnetInfoHash(downloadId) ?? downloadId;
    // A hybrid torrent is keyed by its truncated v2 hash: a row that still holds the v1 hash is mapped to it.
    return /^[0-9a-f]{40}$/i.test(hash) ? ((await this.findTorrentHash(client, hash)) ?? hash) : hash;
  }

  /**
   * The id qBittorrent keys a torrent by, given the one AoNarr holds, or null when it has no such torrent. They differ for a
   * hybrid v1+v2 torrent: qBittorrent keys it by the truncated v2 hash and lists the v1 hash as infohash_v1, and every call
   * that names a torrent by its v1 hash (info, addTags, topPrio, delete) answers 200 and does nothing.
   */
  private async findTorrentHash(client: DownloadClient, hash: string): Promise<string | null> {
    try {
      const direct = await this.authedFetch(client, `${baseUrl(client)}/api/v2/torrents/info?hashes=${encodeURIComponent(hash)}`);
      if (direct.ok) {
        const torrents = (await direct.json()) as any[];
        if (Array.isArray(torrents) && torrents.length > 0) return String(torrents[0].hash ?? hash);
      }
      // One listing serves every lookup of the next few seconds (a "remove all" asks once per row).
      const cached = this.listCache.get(client.id);
      let torrents: any[];
      if (cached && Date.now() - cached.at < 5_000) torrents = cached.torrents;
      else {
        const all = await this.authedFetch(client, `${baseUrl(client)}/api/v2/torrents/info`);
        if (!all.ok) return null;
        torrents = (await all.json()) as any[];
        this.listCache.set(client.id, { at: Date.now(), torrents });
      }
      const wanted = hash.toLowerCase();
      const match = Array.isArray(torrents) ? torrents.find((t) => String(t.infohash_v1 ?? "").toLowerCase() === wanted) : undefined;
      return match ? String(match.hash) : null;
    } catch {
      return null;
    }
  }

  async addDownload(client: DownloadClient, downloadUrl: string, category: string | null, _releaseTitle?: string, _protocol?: SearchResult["protocol"], options: AddOptions = {}): Promise<GrabResult> {
    // A release URL that is not a magnet is fetched here and uploaded as a file, like the other clients do. Handing qBittorrent the
    // URL made it fetch the link itself: a link it could not reach (an indexer on another network) was answered
    // 202 "pending" and never reported again, so the row waited for its timeout. An upload is answered at once (5.x names
    // the torrent in added_torrent_ids), and the hash is known either way (see torrentInfoHash).
    let magnet: string | null = downloadUrl.startsWith("magnet:") ? downloadUrl : null;
    let torrentFile: Buffer | null = null;
    if (!magnet) {
      const source = await resolveDownloadSource(downloadUrl);
      if (source.kind === "magnet") magnet = source.uri;
      else {
        // An indexer's rate-limit page or error document answers 200 like a torrent does: refused here, as the release's fault,
        // instead of uploaded for qBittorrent to refuse (and a body of any size is not held in memory for it).
        if (source.bytes.length > QBIT_MAX_TORRENT_BYTES) throw new Error("Failed to fetch release: the indexer's answer is too large to be a torrent file");
        if (source.bytes[0] !== 0x64) throw new Error("Failed to fetch release: the indexer's answer to the torrent download is not a torrent file");
        torrentFile = source.bytes;
      }
    }
    const knownHash = magnet ? magnetInfoHash(magnet) : torrentFile ? torrentInfoHash(torrentFile) : null;
    // A torrent whose hash cannot be computed (a v2-only one) is found again through a tag, as a magnet without a v1 hash is.
    const pendingTag = knownHash ? null : `${QBIT_PENDING_TAG_PREFIX}${crypto.randomBytes(6).toString("hex")}`;
    // paused (qBittorrent 4) and stopped (5) say "start it now": a client set to add torrents stopped would otherwise leave
    // every grab waiting for someone to press start (and be held in Health as paused). An older build ignores the one it does not know.
    const fields: Record<string, string> = { tags: pendingTag ? `${QBIT_TAG},${pendingTag}` : QBIT_TAG, paused: "false", stopped: "false" };
    if (category) fields.category = category;
    // The seed goal goes to qBittorrent with the torrent (API 2.8.1 and later; an older build ignores the fields), so
    // it stops seeding at the goal by itself, whatever AoNarr's own cleanup does later.
    if (options.seedGoal?.ratio) fields.ratioLimit = String(options.seedGoal.ratio);
    if (options.seedGoal?.minutes) fields.seedingTimeLimit = String(Math.round(options.seedGoal.minutes));

    let res: Response;
    if (torrentFile) {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      form.append("torrents", new Blob([torrentFile]), "release.torrent");
      res = await this.authedFetch(client, `${baseUrl(client)}/api/v2/torrents/add`, { method: "POST", body: form });
    } else {
      res = await this.postForm(client, "torrents/add", { urls: magnet ?? downloadUrl, ...fields });
    }
    // A torrent qBittorrent already holds, or a link it refuses, is answered 409 from 5.x on (and "Fails." with 200 before).
    if (res.status === 409) {
      if (knownHash) {
        const held = await this.findTorrentHash(client, knownHash);
        if (held) return { downloadId: held };
      }
      throw new Error("qBittorrent refused the torrent (the link is invalid, or it is already added)");
    }
    if (res.status === 415) throw new Error("qBittorrent refused the file: it is not a valid torrent");
    if (!res.ok) throw new Error(`qBittorrent add failed: HTTP ${res.status}`);
    // Older builds answer HTTP 200 with the body "Fails." when the link or file could not be added.
    // Taking that as success left a row waiting for a tag that never appeared, failed 30 minutes later.
    let answer = "";
    try {
      answer = await res.text();
    } catch {
      // No readable body (a stub, an empty answer): the HTTP status was all there was to go on.
    }
    if (/^\s*fails\.?\s*$/i.test(answer)) {
      // Builds before 5.3 also answer "Fails." for a torrent they already hold: that one is tracked, as a
      // duplicate add was before this check, instead of the next-best release being downloaded beside it.
      if (knownHash) {
        const held = await this.findTorrentHash(client, knownHash);
        if (held) return { downloadId: held };
      }
      throw new Error("qBittorrent did not add the torrent (it answered \"Fails.\": a dead link, an unsupported file, or one it already has)");
    }
    // 5.x names what it added (the id qBittorrent itself keys the torrent by: the truncated v2 hash for a hybrid one).
    try {
      const added = JSON.parse(answer) as { added_torrent_ids?: unknown };
      const id = Array.isArray(added.added_torrent_ids) ? added.added_torrent_ids[0] : null;
      if (typeof id === "string" && /^[0-9a-f]{40,64}$/i.test(id)) return { downloadId: id.toLowerCase() };
    } catch {
      // "Ok." from an older build
    }
    if (knownHash) return { downloadId: knownHash };

    for (let attempt = 0; attempt < 8 && pendingTag; attempt++) {
      await sleep(attempt === 0 ? 250 : 750);
      const hash = await this.hashForTag(client, pendingTag).catch(() => null);
      if (hash) {
        await this.postForm(client, "torrents/removeTags", { hashes: hash, tags: pendingTag }).catch(() => {});
        await this.postForm(client, "torrents/deleteTags", { tags: pendingTag }).catch(() => {});
        return { downloadId: hash };
      }
    }
    return { downloadId: `tag:${pendingTag}` };
  }

  async getStatus(client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    const res = await this.authedFetch(client, `${baseUrl(client)}/api/v2/torrents/info`);
    if (!res.ok) throw new Error(`qBittorrent status failed: HTTP ${res.status}`);
    const torrents = (await res.json()) as any[];

    const updates: QueueStatusUpdate[] = [];
    const byHash = new Map<string, QueueStatusUpdate>();
    // libtorrent-2.x builds report a hybrid v1+v2 torrent's `hash` as its truncated v2 id; the v1
    // hash a magnet's btih carries (and so a queue row keyed by it) only shows up as infohash_v1.
    const byV1Hash = new Map<string, QueueStatusUpdate>();
    for (const t of torrents) {
      // An "error" torrent is no longer failed: the error is the client's (a full disk), not the
      // release's, so deleting it and blocklisting the release would only burn the next ones too.
      const status = t.progress >= 1 && !QBIT_UNSETTLED_STATES.has(t.state) ? "completed" : "downloading";
      const update: QueueStatusUpdate = {
        downloadId: t.hash,
        progress: t.progress ?? 0,
        status,
        ...(status === "downloading" && QBIT_STALLED_STATES.has(t.state) ? { stalled: true } : {}),
        ...(status === "downloading" && QBIT_PAUSED_STATES.has(t.state) ? { paused: true } : {}),
        ...(status === "downloading" && QBIT_WARNING_STATES[t.state] ? { warning: QBIT_WARNING_STATES[t.state] } : {}),
        ...(status === "downloading" && !QBIT_NO_METADATA_STATES.has(t.state) ? qbitTimeAndSize(t) : {}),
        // content_path (API v2.8.4+) points straight at the torrent's actual file/folder; save_path
        // is only the download root it was saved under. Older qBittorrent builds lack content_path
        // entirely, so fall back to save_path rather than reporting no path at all.
        // A torrent without metadata has no content_path yet, and save_path is the whole download root: not a place to import from.
        remotePath: t.content_path || (QBIT_NO_METADATA_STATES.has(t.state) ? undefined : t.save_path) || undefined,
        clientTitle: typeof t.name === "string" ? t.name : undefined,
      };
      updates.push(update);
      byHash.set(String(t.hash).toLowerCase(), update);
      if (t.infohash_v1) byV1Hash.set(String(t.infohash_v1).toLowerCase(), update);
      for (const tag of String(t.tags ?? "").split(",").map((s) => s.trim())) {
        if (tag.startsWith(QBIT_PENDING_TAG_PREFIX)) updates.push({ ...update, downloadId: `tag:${tag}`, resolvedDownloadId: t.hash });
      }
    }
    // Queue rows still keyed by a magnet URL (grabbed before hashes were resolved at add time) are
    // matched through the magnet's own btih, and a v1 hash through infohash_v1.
    for (const id of downloadIds) {
      const hash = magnetInfoHash(id) ?? (/^[0-9a-f]{40}$/i.test(id) ? id.toLowerCase() : null);
      const update = hash ? (byHash.get(hash) ?? byV1Hash.get(hash)) : undefined;
      if (update && update.downloadId !== id) updates.push({ ...update, downloadId: id, resolvedDownloadId: update.downloadId });
    }
    return updates;
  }

  /** qBittorrent orders torrents by queue position; `topPrio`/`bottomPrio` move one to either end
   * (there's no direct "set numeric priority" call in the Web API). */
  async setPriority(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void> {
    const endpoint = priority === "top" ? "topPrio" : "bottomPrio";
    const res = await this.postForm(client, `torrents/${endpoint}`, { hashes: await this.resolveHash(client, downloadId) });
    if (!res.ok) throw new Error(`qBittorrent ${endpoint} failed: HTTP ${res.status}`);
  }

  /**
   * qBittorrent can be told to remove a torrent (or the torrent and its files) when it reaches its share
   * ratio or seeding time limit. For a download AoNarr has not imported yet that deletes it first.
   * max_ratio_act: 0 pause, 1 remove the torrent, 2 enable super seeding, 3 remove the torrent and its files.
   */
  async healthNotes(client: DownloadClient): Promise<string[]> {
    const res = await this.authedFetch(client, `${baseUrl(client)}/api/v2/app/preferences`);
    if (!res.ok) return [];
    const prefs: any = await res.json();
    const removes = Number(prefs.max_ratio_act) === 1 || Number(prefs.max_ratio_act) === 3;
    const limited = !!prefs.max_ratio_enabled || !!prefs.max_seeding_time_enabled || !!prefs.max_inactive_seeding_time_enabled;
    if (limited && removes) {
      return [
        "is set to remove torrents when they reach their ratio or seeding time limit. A download can be deleted before AoNarr imports it. Set the limit action to Pause, and let AoNarr's Seed Goal Cleanup do the removing.",
      ];
    }
    return [];
  }

  async getHealthStats(client: DownloadClient): Promise<ClientHealthStats> {
    const [transferRes, prefsRes, torrentsRes] = await Promise.all([
      this.authedFetch(client, `${baseUrl(client)}/api/v2/transfer/info`),
      this.authedFetch(client, `${baseUrl(client)}/api/v2/app/preferences`),
      this.authedFetch(client, `${baseUrl(client)}/api/v2/torrents/info`),
    ]);
    if (!transferRes.ok || !prefsRes.ok || !torrentsRes.ok) {
      throw new Error("qBittorrent health stats request failed");
    }

    const transfer: any = await transferRes.json();
    const prefs: any = await prefsRes.json();
    const torrents = (await torrentsRes.json()) as any[];

    const ratioLimitEnabled = !!prefs.max_ratio_enabled;
    const ratioLimit = ratioLimitEnabled ? Number(prefs.max_ratio) : null;
    const torrentsOverRatioLimit = ratioLimit !== null ? torrents.filter((t) => (t.ratio ?? 0) >= ratioLimit).length : 0;

    const uploadedTotalBytes = Number(transfer.up_info_data ?? 0);
    const downloadedTotalBytes = Number(transfer.dl_info_data ?? 0);

    return {
      uploadedTotalBytes,
      downloadedTotalBytes,
      globalRatio: downloadedTotalBytes > 0 ? uploadedTotalBytes / downloadedTotalBytes : null,
      ratioLimitEnabled,
      ratioLimit,
      torrentsOverRatioLimit,
    };
  }

  async removeSeededTorrents(client: DownloadClient, ratioGoal: number | null, seedTimeGoalMinutes: number | null, skipIds?: Set<string>): Promise<number> {
    const res = await this.authedFetch(client, `${baseUrl(client)}/api/v2/torrents/info`);
    if (!res.ok) throw new Error(`qBittorrent torrents/info failed: HTTP ${res.status}`);
    const torrents = (await res.json()) as any[];

    // Only a torrent that's actually finished downloading and seeding (never one still fetching,
    // "uploading"/"stalledUP"/"queuedUP"/"pausedUP" states) is eligible — same reasoning as
    // qBittorrent's own state machine, so this can't accidentally remove an in-progress download.
    // qBittorrent 5 renamed pausedUP to stoppedUP (which is also what its own "Stop torrent"
    // share-limit action leaves behind); both are listed for older and newer builds.
    const seedingStates = new Set(["uploading", "stalledUP", "queuedUP", "pausedUP", "stoppedUP", "forcedUP"]);
    // Only AoNarr's own torrents — its tag, or its configured category — never everything on a
    // qBittorrent shared with Sonarr/Radarr or the user's own manual torrents (removing those on
    // AoNarr's seed goal can mean hit-and-run penalties on their private trackers).
    const isOwn = (t: any) =>
      String(t.tags ?? "")
        .split(",")
        .map((s: string) => s.trim())
        .includes(QBIT_TAG) || (!!t.category && clientCategories(client).includes(t.category));
    const eligible = torrents.filter((t) => {
      if (!isOwn(t) || !seedingStates.has(t.state)) return false;
      // Still tracked by a queue row (not imported yet): not removed whatever its goal.
      if (skipIds?.has(String(t.hash).toLowerCase()) || skipIds?.has(String(t.infohash_v1 ?? "").toLowerCase())) return false;
      // A torrent from an indexer with its own goal is held to it (each part falls back to the global goal when the indexer leaves it empty).
      const own = parseSeedGoalTag(String(t.tags ?? ""));
      const ratio = own?.ratio ?? ratioGoal;
      const minutes = own?.minutes ?? seedTimeGoalMinutes;
      const ratioMet = ratio !== null && (t.ratio ?? 0) >= ratio;
      const timeMet = minutes !== null && (t.seeding_time ?? 0) / 60 >= minutes;
      return ratioMet || timeMet;
    });
    if (eligible.length === 0) return 0;

    // The data goes only with a torrent AoNarr imported by hardlink and tagged for it (markImported): the
    // library then holds the same bytes under its own link, or a copy. Any other torrent (one waiting for a
    // manual import, one mid-import, one the user added to the category, one imported by symlink) may hold
    // the only copy: it leaves the client with its data kept.
    const hasTag = (t: any, tag: string) =>
      String(t.tags ?? "")
        .split(",")
        .map((s: string) => s.trim())
        .includes(tag);
    const withData = eligible.filter((t) => hasTag(t, QBIT_IMPORTED_TAG));
    const withoutData = eligible.filter((t) => !hasTag(t, QBIT_IMPORTED_TAG));
    for (const [group, deleteFiles] of [[withData, true], [withoutData, false]] as const) {
      if (group.length === 0) continue;
      const removeRes = await this.authedFetch(client, `${baseUrl(client)}/api/v2/torrents/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ hashes: group.map((t) => t.hash).join("|"), deleteFiles: deleteFiles ? "true" : "false" }),
      });
      if (!removeRes.ok) throw new Error(`qBittorrent torrents/delete failed: HTTP ${removeRes.status}`);
    }
    return eligible.length;
  }

  async markImported(client: DownloadClient, downloadId: string, seedGoal?: SeedGoal | null, dataSafe = true): Promise<void> {
    // `dataSafe`: the library holds these bytes (a hardlink), so the data may go with the torrent. Without it only the seed goal is recorded.
    const tags = [dataSafe ? QBIT_IMPORTED_TAG : null, seedGoalTag(seedGoal)].filter(Boolean).join(",");
    if (!tags) return;
    const res = await this.postForm(client, "torrents/addTags", { hashes: await this.resolveHash(client, downloadId), tags });
    if (!res.ok) throw new Error(`qBittorrent torrents/addTags failed: HTTP ${res.status}`);
  }

  async removeDownload(client: DownloadClient, downloadId: string, deleteFiles: boolean): Promise<void> {
    const res = await this.postForm(client, "torrents/delete", {
      hashes: await this.resolveHash(client, downloadId),
      deleteFiles: deleteFiles ? "true" : "false",
    });
    if (!res.ok) throw new Error(`qBittorrent torrents/delete failed: HTTP ${res.status}`);
  }
}

/** An NZB can arrive gzip-compressed (an indexer that compresses its download without saying so) or as UTF-16 with a
 * byte order mark (some tools write that); neither reads as text to the checks below, and a client or watch folder
 * expects plain XML. This returns the plain UTF-8 bytes (the same buffer for the ordinary case). */
const NZB_MAX_INFLATED_BYTES = 128 * 1024 * 1024;

export function normalizeNzb(bytes: Buffer): Buffer {
  let out = bytes;
  if (out.length > 2 && out[0] === 0x1f && out[1] === 0x8b) {
    try {
      out = zlib.gunzipSync(out, { maxOutputLength: NZB_MAX_INFLATED_BYTES });
    } catch {
      throw new Error("Failed to fetch release: the indexer's NZB download is a damaged or oversized gzip file");
    }
  }
  if (out.length >= 2 && ((out[0] === 0xff && out[1] === 0xfe) || (out[0] === 0xfe && out[1] === 0xff))) {
    const body = out.subarray(2);
    if (body.length % 2 !== 0) throw new Error("Failed to fetch release: the indexer's NZB download is a damaged UTF-16 file");
    let text: string;
    if (out[0] === 0xff) text = body.toString("utf16le");
    else {
      const swapped = Buffer.from(body);
      swapped.swap16();
      text = swapped.toString("utf16le");
    }
    // The prolog still says the file is UTF-16 after the conversion, and a client's XML parser believes it.
    // Only the start of the document can hold the prolog (and the pattern stays cheap on a hostile file).
    return Buffer.from(text.slice(0, 2048).replace(/(<\?xml[^>]*\bencoding\s*=\s*["'])utf-?16(?:le|be)?(["'])/i, "$1utf-8$2") + text.slice(2048), "utf-8");
  }
  // A UTF-8 byte order mark would hide the opening "<" from a check that looks at the first characters.
  if (out.length >= 3 && out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf) return out.subarray(3);
  return out;
}

/**
 * Refuses what is not an NZB before a client or a watch folder gets it, as Sonarr's NzbValidationService
 * does: an indexer answers a download it will not serve (a rate limit, a bad key, a login page) with an
 * HTTP 200 document, and handing that on made a job that fails in the client, or garbage in the watch
 * folder, and left the indexer unaware. The error is a release refusal: the next release is tried. Returns the NZB as
 * plain UTF-8 bytes (see normalizeNzb), which is what is handed on.
 */
export function validateNzb(raw: Buffer): Buffer {
  const bytes = normalizeNzb(raw);
  const head = bytes.subarray(0, 8192).toString("utf-8");
  const error = /<error\b([^>]*)>/i.exec(head);
  if (error) {
    const code = /code="([^"]*)"/i.exec(error[1])?.[1];
    const description = /description="([^"]*)"/i.exec(error[1])?.[1];
    // "Failed to fetch release:" marks it as the indexer's answer, so an "Invalid API Key" in it is not
    // taken for the download client's login failing (isClientLevelError).
    throw new Error(`Failed to fetch release: the indexer answered the NZB download with an error${code ? ` ${code}` : ""}${description ? `: ${description}` : ""}`);
  }
  if (!/<nzb[\s>]/i.test(head)) throw new Error("Failed to fetch release: the indexer's answer to the NZB download is not an NZB file");
  if (bytes.indexOf("<file") < 0) throw new Error("Failed to fetch release: the NZB the indexer returned lists no files");
  return bytes;
}

/** SABnzbd adapter. */
class SabnzbdAdapter implements DownloadClientAdapter {
  /**
   * SABnzbd settings that take a finished download away from the folder AoNarr is told about: sorting
   * (it renames and moves the result into its own tree) and deleting finished jobs from its history at once
   * (AoNarr then never sees them complete). Keys are read from SABnzbd's `get_config`; a key it does not
   * return is left unjudged.
   */
  async healthNotes(client: DownloadClient): Promise<string[]> {
    const body: any = await sabnzbdApi(client, { mode: "get_config", section: "misc" });
    const misc = body?.config?.misc ?? body?.misc ?? {};
    const on = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";
    const notes: string[] = [];
    const sorting = ["enable_tv_sorting", "enable_movie_sorting", "enable_date_sorting"].filter((key) => on(misc[key]));
    // SABnzbd 5 moved the sorters out of "misc" into a section of their own, each with an is_active flag.
    try {
      const sorters: any = await sabnzbdApi(client, { mode: "get_config", section: "sorters" });
      const list = sorters?.config?.sorters ?? sorters?.sorters;
      const ours = new Set(clientCategories(client).map((c) => c.toLowerCase()));
      // A sorter applies to the categories in sort_cats (none listed: every category).
      const touchesUs = (sorter: any) => {
        const cats = Array.isArray(sorter?.sort_cats) ? sorter.sort_cats.map((c: unknown) => String(c).toLowerCase()) : [];
        return cats.length === 0 || cats.includes("*") || cats.some((c: string) => ours.has(c));
      };
      if (Array.isArray(list) && list.some((sorter) => on(sorter?.is_active) && touchesUs(sorter))) sorting.push("sorters");
    } catch {
      // an older SABnzbd has no such section: the keys above are its answer
    }
    if (sorting.length > 0) {
      notes.push("has sorting turned on. SABnzbd renames and moves finished downloads into its own folders, so the folder AoNarr is given no longer holds them. Turn off TV, movie and date sorting.");
    }
    if (misc.history_retention_option === "all-delete") {
      notes.push("deletes every finished job from its history at once, so AoNarr can lose sight of a completed download before it imports it. Keep the history (or a number of days).");
    }
    // A category SABnzbd does not have is not an error to it: the job is quietly filed under "*", in the default folder.
    try {
      const cats: any = await sabnzbdApi(client, { mode: "get_cats" });
      const known = new Set((Array.isArray(cats?.categories) ? cats.categories : []).map((c: unknown) => String(c).toLowerCase()));
      if (known.size > 0) {
        const missing = clientCategories(client).filter((c) => !known.has(c.toLowerCase()));
        if (missing.length > 0) {
          notes.push(`has no category ${missing.map((c) => `"${c}"`).join(", ")}. Downloads sent with it are filed without a category, in SABnzbd's default folder. Add ${missing.length === 1 ? "it" : "them"} under Config > Categories.`);
        }
      }
    } catch {
      // the category list is a courtesy check
    }
    return notes;
  }

  async addDownload(
    client: DownloadClient,
    downloadUrl: string,
    category: string | null,
    releaseTitle?: string
  ): Promise<GrabResult> {
    // Fetch the NZB here and upload it (mode=addfile) instead of handing SABnzbd the URL
    // (mode=addurl). With addurl the *client* performs the fetch, and a client that guards
    // against SSRF refuses any target resolving to a non-public address — which includes the
    // loopback indexer a local-only stack necessarily uses — so addurl can never work there.
    // Uploading sidesteps the client's fetch entirely. Real SABnzbd accepts addfile too, so
    // this is not specific to any one backend.
    const source = await resolveDownloadSource(downloadUrl);
    if (source.kind === "magnet") throw new Error("SABnzbd cannot accept a magnet link");
    const nzb = validateNzb(source.bytes);

    const url = new URL(`${baseUrl(client)}/api`);
    url.searchParams.set("apikey", client.apiKey ?? "");
    url.searchParams.set("output", "json");

    const form = new FormData();
    form.append("mode", "addfile");
    if (category) form.append("cat", category);
    // The multipart filename is what the client names the job; without it the release title is lost.
    form.append("name", new Blob([nzb]), `${sanitizeFilename(releaseTitle || "release")}.nzb`);

    const res = await apiFetch(url.toString(), { method: "POST", body: form });
    if (!res.ok) throw new Error(await sabnzbdHttpError(res, "SABnzbd add failed: "));
    const body: any = await res.json();
    // A rejected key comes back as HTTP 200 {status: false, error}; taking that as a grab would
    // leave a queue row polling for a job SABnzbd never created.
    if (body?.error || body?.status === false) {
      // An empty or invalid NZB is answered {status:false, nzo_ids:[]} with no error text.
      throw new Error(`SABnzbd add failed: ${body.error ?? "SABnzbd refused the NZB (it is empty or not valid)"}`);
    }
    // Without a job id nothing was added. Tracking the row by the release URL (which carries the
    // indexer's API key) left it polling for a job that never existed, then blocklisted the release.
    const downloadId = body?.nzo_ids?.[0];
    if (!downloadId) throw new Error("SABnzbd accepted the upload but returned no job id, so the NZB was not added");
    return { downloadId };
  }

  /**
   * SABnzbd reaches 100% progress well before a job is actually done — it still has to verify,
   * repair, extract, and move the result, all while sitting in the queue with `percentage: "100"`
   * and a `status` like "Verifying"/"Repairing"/"Extracting"/"Moving"/"Running" (a post-processing
   * script). Reporting "completed" the moment percentage hits 100 (the previous behavior) had the
   * importer race that post-processing and fail to find the final file — which surfaced as "grab
   * succeeded, import failed, marked as failed" for a download that, moments later, finished fine.
   * A job only truly finishes once it leaves the queue entirely and appears in SABnzbd's history,
   * so real completion (and real failure) is only detected there — the queue is checked first
   * since most active downloads are still there, and only the ids that have disappeared from it
   * get looked up in history.
   */
  async getStatus(client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    const queueUrl = new URL(`${baseUrl(client)}/api`);
    queueUrl.searchParams.set("mode", "queue");
    queueUrl.searchParams.set("apikey", client.apiKey ?? "");
    queueUrl.searchParams.set("output", "json");
    const queueRes = await apiFetch(queueUrl.toString());
    if (!queueRes.ok) throw new Error(`SABnzbd status failed: HTTP ${queueRes.status}`);
    const queueBody: any = await queueRes.json();
    if (queueBody?.error || queueBody?.status === false) throw new Error(`SABnzbd status failed: ${queueBody.error ?? "rejected"}`);
    const slots: any[] = queueBody?.queue?.slots ?? [];

    const updates: QueueStatusUpdate[] = [];
    const inQueueIds = new Set<string>();
    for (const s of slots) {
      inQueueIds.add(s.nzo_id);
      updates.push({
        downloadId: s.nzo_id,
        progress: s.percentage ? Number(s.percentage) / 100 : 0,
        status: s.status === "Failed" ? "failed" : "downloading",
        // A job the user paused, or one waiting for its turn, is healthy; its age says nothing.
        ...(s.status === "Paused" || s.status === "Queued" || s.status === "Propagating" ? { paused: true } : {}),
        ...sabTimeAndSize(s),
      });
    }

    const missingIds = downloadIds.filter((id) => !inQueueIds.has(id));
    if (missingIds.length > 0) {
      const historyUrl = new URL(`${baseUrl(client)}/api`);
      historyUrl.searchParams.set("mode", "history");
      historyUrl.searchParams.set("apikey", client.apiKey ?? "");
      historyUrl.searchParams.set("output", "json");
      historyUrl.searchParams.set("nzo_ids", missingIds.join(","));
      const historyRes = await apiFetch(historyUrl.toString());
      if (historyRes.ok) {
        const historyBody: any = await historyRes.json();
        const historySlots: any[] = historyBody?.history?.slots ?? [];
        for (const h of historySlots) {
          // A job moves to history BEFORE post-processing finishes — it sits there as QuickCheck/
          // Verifying/Repairing/Fetching/Extracting/Moving/Running/Queued until it's truly
          // Completed or Failed (Sonarr/Radarr treat every one of those as still downloading too).
          // Importing on any of them raced the extraction and either failed the grab or imported a
          // half-written file.
          if (h.status !== "Completed" && h.status !== "Failed") {
            updates.push({ downloadId: h.nzo_id, progress: 0.99, status: "downloading" });
            continue;
          }
          const failMessage = typeof h.fail_message === "string" ? h.fail_message.trim() : "";
          // A job that failed because the disk is full or not writable is the environment's failure, not
          // the NZB's: kept, with the message, rather than deleted and the release blocklisted.
          if (h.status === "Failed" && SABNZBD_ENVIRONMENT_FAILURE.test(failMessage)) {
            updates.push({ downloadId: h.nzo_id, progress: 0.99, status: "downloading", warning: `SABnzbd: ${failMessage}` });
            continue;
          }
          updates.push({
            downloadId: h.nzo_id,
            progress: 1,
            status: h.status === "Failed" ? "failed" : "completed",
            ...(h.status === "Failed" && failMessage ? { failureReason: `SABnzbd: ${failMessage}` } : {}),
            // "storage" is the final on-disk path of the completed job, in SABnzbd's own filesystem namespace. A failed job
            // has none that matters: SABnzbd 5 fills it with the incomplete folder, which is not a result.
            remotePath: h.status === "Failed" ? undefined : h.storage || undefined,
          });
        }
      }
      // An id found in neither the queue nor history (not indexed yet, or genuinely gone) is left
      // out of the result entirely — the caller leaves that queue row untouched until next poll,
      // same as it already does for any id this adapter simply doesn't report on.
    }

    return updates;
  }

  /** SABnzbd doesn't have a "move to top" call directly, but setting priority to Force (2, the
   * highest level) has SABnzbd fetch it ahead of any Normal/Low-priority item — the closest
   * equivalent available through its API. "normal" resets it back to the default (0). */
  async setPriority(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void> {
    const url = new URL(`${baseUrl(client)}/api`);
    url.searchParams.set("mode", "queue");
    url.searchParams.set("name", "priority");
    url.searchParams.set("value", downloadId);
    url.searchParams.set("value2", priority === "top" ? "2" : "0");
    url.searchParams.set("apikey", client.apiKey ?? "");
    url.searchParams.set("output", "json");
    const res = await apiFetch(url.toString());
    if (!res.ok) throw new Error(`SABnzbd priority change failed: HTTP ${res.status}`);
  }

  /** A job can be sitting in either the active queue (a client-level failure caught it before it
   * ever finished) or history (successfully completed, or failed during post-processing) —
   * SABnzbd's delete calls are per-location, and there's no single "delete regardless of where it
   * is" endpoint, so this tries both. Neither failing is unexpected (an id genuinely not in that
   * location returns a normal "not found" response, not an HTTP error) — only surfaced if both
   * requests themselves fail outright. */
  async removeDownload(client: DownloadClient, downloadId: string, deleteFiles: boolean): Promise<void> {
    let anyOk = false;
    let lastErr: Error | null = null;

    for (const mode of ["queue", "history"] as const) {
      try {
        const url = new URL(`${baseUrl(client)}/api`);
        url.searchParams.set("mode", mode);
        url.searchParams.set("name", "delete");
        url.searchParams.set("value", downloadId);
        // Both places take del_files: a queued job left its incomplete folder (with __ADMIN__) behind without it.
        url.searchParams.set("del_files", deleteFiles ? "1" : "0");
        url.searchParams.set("apikey", client.apiKey ?? "");
        url.searchParams.set("output", "json");
        const res = await apiFetch(url.toString());
        if (res.ok) anyOk = true;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    if (!anyOk && lastErr) throw lastErr;
  }
}

interface InProcessJob {
  progress: number;
  status: "downloading" | "completed" | "failed";
  remotePath?: string;
}

export const DOWNLOAD_INTERRUPTED_REASON = "Download was interrupted by an AoNarr restart";

/** Status of in-process jobs (http, yt-dlp, debrid), which live only in this process's memory. An id
 * the adapter doesn't know belongs to a job a previous process started and never finished: left out
 * of the result, its queue row would never be polled again and would block its target's searches
 * forever, so it's reported failed as interrupted, and whatever partial file it left is removed. */
function inProcessStatuses(jobs: Map<string, InProcessJob>, downloadIds: string[]): QueueStatusUpdate[] {
  const lost = downloadIds.filter((id) => !jobs.has(id));
  if (lost.length > 0) removeLostJobPartials(lost);
  return downloadIds.map((id) => {
    const job = jobs.get(id);
    return job
      ? { downloadId: id, ...job }
      : { downloadId: id, progress: 0, status: "failed", failureReason: DOWNLOAD_INTERRUPTED_REASON };
  });
}

function removeLostJobPartials(downloadIds: string[]): void {
  let names: string[];
  try {
    names = fs.readdirSync(config.downloadsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith(".part") && downloadIds.some((id) => name.startsWith(`.aonarr-${id}-`))) {
      fs.rmSync(path.join(config.downloadsDir, name), { force: true });
    }
  }
}

/** Final paths claimed by in-process jobs still running. A job's file only appears under its final
 * name once complete, so without this two concurrent jobs with the same title ("Trailer", a
 * same-titled podcast episode) both pick the same name and the second rename overwrites the first. */
const claimedFinalPaths = new Set<string>();

/** `name` inside `dir` — or, when something on disk or another running job already has that name,
 * the name with ` (<start of downloadId>)` before its extension. The path stays claimed until
 * releaseFinalPaths(); by then the finished file or folder exists on disk and is seen there. */
function claimFinalPath(dir: string, name: string, downloadId: string, isDir = false): string {
  const ext = isDir ? "" : path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  // A bare claimed stem is a running yt-dlp job's (claimFinalStem), whose file may get any extension.
  const taken = (candidateStem: string) => {
    const candidate = path.join(dir, candidateStem + ext);
    return claimedFinalPaths.has(candidate) || claimedFinalPaths.has(path.resolve(dir, candidateStem)) || fs.existsSync(candidate);
  };
  let candidateStem = stem;
  for (let n = 1; taken(candidateStem); n++) candidateStem = uniqueStem(stem, downloadId, n);
  const claimed = path.join(dir, candidateStem + ext);
  claimedFinalPaths.add(claimed);
  return claimed;
}

function uniqueStem(stem: string, downloadId: string, attempt: number): string {
  return `${stem} (${downloadId.slice(0, 8)}${attempt > 1 ? `-${attempt}` : ""})`;
}

/** claimFinalPath for a job whose extension is only known once it finishes (yt-dlp's merge and audio
 * conversion decide it): the stem is taken by any file or claimed path in `dir` named `<stem>.<ext>`.
 * Returns the claimed `dir/<stem>`, which releaseFinalPaths() releases like any other claim. */
function claimFinalStem(dir: string, stem: string, downloadId: string): string {
  // Claimed paths are normalized, so a configured "/downloads/" must compare as "/downloads".
  const base = path.resolve(dir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    // nothing saved there yet
  }
  for (const p of claimedFinalPaths) if (path.dirname(path.resolve(p)) === base) names.push(path.basename(p));
  const taken = (candidateStem: string) => names.some((n) => n === candidateStem || n.startsWith(`${candidateStem}.`));
  let candidateStem = stem;
  for (let n = 1; taken(candidateStem); n++) candidateStem = uniqueStem(stem, downloadId, n);
  const claimed = path.join(base, candidateStem);
  claimedFinalPaths.add(claimed);
  return claimed;
}

function releaseFinalPaths(paths: string[]): void {
  for (const p of paths) claimedFinalPaths.delete(p);
}

/** Where an in-process job saves its files. A multi-file job (an album, a season pack) gets a folder
 * of its own named for the release: loose in the downloads root, the importer can't tell its files
 * from every other download's and imports only the one it matched. A single file stays in the root.
 * A folder the job claims is added to `claimed`. */
function inProcessJobDir(fileCount: number, releaseTitle: string | undefined, downloadId: string, claimed: string[]): string {
  let dir = config.downloadsDir;
  if (fileCount > 1) {
    const name = sanitizeFilename(releaseTitle ?? "");
    dir = claimFinalPath(config.downloadsDir, /^\.*$/.test(name) ? downloadId : name, downloadId, true);
    claimed.push(dir);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The job's completed state, pointing the importer at its own folder when it has one, and at the
 * one file it saved when it doesn't — the downloads root holds every other job's files too. */
/**
 * Removes a finished download from the debrid account once AoNarr has saved its files (DL21): the account's torrent
 * list otherwise grows for ever. The provider keeps its cache, so the same release is not slower the next time.
 * Best effort and never a reason to fail the job; setting `debridCleanup` = "0" turns it off.
 */
async function cleanupAtProvider(provider: string, work: () => Promise<unknown>): Promise<void> {
  if (getSetting("debridCleanup") === "0") return;
  try {
    await work();
  } catch (err) {
    log.warn(`[${provider}] could not remove the finished download from the account:`, (err as Error).message);
  }
}

function completedJob(dir: string, savedFiles: string[]): InProcessJob {
  const remotePath = dir === config.downloadsDir ? savedFiles[0] : dir;
  return remotePath ? { progress: 1, status: "completed", remotePath } : { progress: 1, status: "completed" };
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "video/x-matroska": ".mkv",
  "video/mp4": ".mp4",
  "video/x-m4v": ".m4v",
  "video/x-msvideo": ".avi",
  "video/avi": ".avi",
  "video/quicktime": ".mov",
  "video/x-ms-wmv": ".wmv",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/x-m4b": ".m4b",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "application/epub+zip": ".epub",
  "application/x-mobipocket-ebook": ".mobi",
  "application/pdf": ".pdf",
  "application/vnd.comicbook+zip": ".cbz",
  "application/vnd.comicbook-rar": ".cbr",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  "application/vnd.rar": ".rar",
  "application/x-rar-compressed": ".rar",
  "application/x-7z-compressed": ".7z",
};

// Everything the importer can pick up: a media type's own extensions, plus the archives it unpacks.
const IMPORTABLE_EXTENSIONS = new Set([...Object.values(MEDIA_TYPES).flatMap((t) => t.extensions), ".zip", ".7z", ".rar"]);

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*(?:[\w-]+'[^']*')?"?([^";]+)"?/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      return encoded[1].trim();
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return plain ? (plain[1] ?? plain[2]).trim() : null;
}

/** A DDL link like ".../download/12345" or ".../get.php?id=9" says nothing about what it serves, and
 * the importer never looks at a ".bin"/".php" file — so an importable extension from the server's
 * own filename or a URL wins, then the content type, and only then whatever a URL ends in. Both the
 * final (post-redirect) URL and the requested one count: a named link commonly redirects to a signed
 * CDN URL with no extension at all. */
function downloadedFileExtension(res: Response, downloadUrl: string): string {
  const clean = (ext: string) => (/^\.[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : "");
  const named = [
    clean(path.extname(filenameFromContentDisposition(res.headers.get("content-disposition")) ?? "")),
    clean(path.extname(new URL(res.url || downloadUrl).pathname)),
    clean(path.extname(new URL(downloadUrl).pathname)),
  ];
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return named.find((ext) => IMPORTABLE_EXTENSIONS.has(ext)) ?? EXTENSION_BY_CONTENT_TYPE[contentType] ?? (named.find(Boolean) || ".bin");
}

/**
 * Direct HTTP download — no external client at all; AoNarr streams the URL straight into
 * downloadsDir itself and the existing queue-poll/import pipeline picks it up exactly like a
 * torrent/usenet client's completed download would. Used for DDL/RSS indexer results.
 */
class HttpDownloadAdapter implements DownloadClientAdapter {
  private jobs = new Map<string, InProcessJob>();

  async addDownload(
    _client: DownloadClient,
    downloadUrl: string,
    _category: string | null,
    releaseTitle?: string
  ): Promise<GrabResult> {
    // fetch() also reads data: URLs (and the URL comes from indexer results and podcast feeds).
    let protocol: string;
    try {
      protocol = new URL(downloadUrl).protocol;
    } catch {
      throw new Error("Invalid download URL");
    }
    if (protocol !== "http:" && protocol !== "https:") throw new Error(`Refusing to download a "${protocol}" URL — only http(s) links are supported`);

    const downloadId = crypto.randomUUID();
    this.jobs.set(downloadId, { progress: 0, status: "downloading" });

    (async () => {
      let dest: string | undefined;
      try {
        const res = await fetch(downloadUrl);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const ext = downloadedFileExtension(res, downloadUrl);
        const filename = sanitizeFilename(releaseTitle || path.basename(new URL(downloadUrl).pathname) || downloadId) + ext;
        fs.mkdirSync(config.downloadsDir, { recursive: true });
        dest = claimFinalPath(config.downloadsDir, filename, downloadId);

        const total = Number(res.headers.get("content-length") ?? 0);
        let received = 0;
        await saveBodyToFile(res.body, dest, partialPath(downloadId, 0), (bytes) => {
          received += bytes;
          if (total > 0) this.jobs.set(downloadId, { progress: Math.min(received / total, 0.99), status: "downloading" });
        });
        this.jobs.set(downloadId, { progress: 1, status: "completed", remotePath: dest });
        log.info(`[http-download] completed "${releaseTitle ?? downloadUrl}"`);
      } catch (err) {
        log.warn(`[http-download] failed for "${releaseTitle ?? downloadUrl}":`, (err as Error).message);
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      } finally {
        if (dest) releaseFinalPaths([dest]);
      }
    })();

    return { downloadId };
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return inProcessStatuses(this.jobs, downloadIds);
  }
}

/**
 * yt-dlp — spawns the `yt-dlp` binary (must be on PATH in the server image) to download a video
 * URL into downloadsDir. Used for Online Videos library downloads (YouTube etc.) rather than
 * indexer search results.
 */
class YtdlpAdapter implements DownloadClientAdapter {
  private jobs = new Map<string, InProcessJob>();

  async addDownload(
    client: DownloadClient,
    downloadUrl: string,
    _category: string | null,
    releaseTitle?: string
  ): Promise<GrabResult> {
    const downloadId = crypto.randomUUID();
    this.jobs.set(downloadId, { progress: 0, status: "downloading" });
    fs.mkdirSync(config.downloadsDir, { recursive: true });

    // Two same-titled videos (a channel's "Trailer" uploads) would otherwise share one output name
    // and .part files, and yt-dlp would skip the second as already downloaded.
    const title = sanitizeFilename(releaseTitle ?? "");
    const outputStem = claimFinalStem(config.downloadsDir, /^\.*$/.test(title) ? downloadId : title, downloadId);
    const outputTemplate = `${outputStem}.%(ext)s`;
    // Audio-only mode (e.g. ripping a music video / live set) extracts and transcodes to mp3
    // instead of saving the source video container — yt-dlp's own -x/--audio-format flags. Video
    // merges into mkv: separate best video+audio streams otherwise often merge into .webm.
    // `--print after_move:filepath` reports where the finished file really ended up (merging and
    // post-processing decide its extension), so the importer is pointed at it rather than guessing
    // by title; --print implies --quiet, so --progress keeps the progress lines coming.
    const args = [
      ...(client.audioOnly ? ["-x", "--audio-format", "mp3"] : ["--merge-output-format", "mkv"]),
      "-o",
      outputTemplate,
      "--newline",
      "--progress",
      "--print",
      "after_move:filepath",
      downloadUrl,
    ];

    // Youtarr-style extras, all opt-in via Settings so existing setups don't change behavior:
    // a persistent --download-archive means a video already grabbed once (by id) is never
    // re-downloaded even after this specific queue entry is long gone, surviving container
    // restarts (unlike AoNarr's own queue/sub_item bookkeeping, which yt-dlp knows nothing about);
    // SponsorBlock removes/marks sponsor segments; the subtitle flags ask yt-dlp itself to fetch
    // and burn in captions, independent of AoNarr's own subtitle-provider pipeline (which only
    // targets already-imported video files, not what yt-dlp fetches directly from YouTube).
    if (getSetting("ytdlpDownloadArchiveEnabled") === "1") {
      args.push("--download-archive", path.join(config.configDir, "ytdlp-archive.txt"));
    }
    const sponsorBlockCategories = getSetting("ytdlpSponsorBlockCategories");
    if (sponsorBlockCategories) {
      args.push("--sponsorblock-remove", sponsorBlockCategories);
    }
    if (getSetting("ytdlpEmbedSubtitles") === "1") {
      args.push("--write-subs", "--write-auto-subs", "--sub-langs", getSetting("ytdlpSubtitleLangs") || "en", "--embed-subs");
    }

    const proc = spawn("yt-dlp", args);

    let stderrTail = "";
    let stdoutLine = "";
    let finalPath: string | undefined;
    const readPrintedPath = (line: string) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("[")) finalPath = path.resolve(trimmed);
    };
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/(\d+(?:\.\d+)?)%/);
      if (match) this.jobs.set(downloadId, { progress: Math.min(Number(match[1]) / 100, 0.99), status: "downloading" });
      const lines = (stdoutLine + text).split(/\r?\n/);
      stdoutLine = lines.pop() ?? "";
      for (const line of lines) readPrintedPath(line);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    proc.on("error", (err) => {
      log.warn(`[ytdlp] failed to start for "${releaseTitle ?? downloadUrl}":`, err.message);
      this.jobs.set(downloadId, { progress: 0, status: "failed" });
      releaseFinalPaths([outputStem]);
    });
    // "close", not "exit": only "close" guarantees stdout has been fully read, and the file path is
    // the last thing yt-dlp prints.
    proc.on("close", (code) => {
      releaseFinalPaths([outputStem]);
      if (code === 0) {
        readPrintedPath(stdoutLine);
        this.jobs.set(downloadId, finalPath ? { progress: 1, status: "completed", remotePath: finalPath } : { progress: 1, status: "completed" });
        log.info(`[ytdlp] completed "${releaseTitle ?? downloadUrl}"`);
      } else {
        log.warn(`[ytdlp] failed for "${releaseTitle ?? downloadUrl}" (exit ${code}):`, stderrTail.trim().split("\n").pop());
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      }
    });

    return { downloadId };
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return inProcessStatuses(this.jobs, downloadIds);
  }
}

/**
 * Real-Debrid — a "debrid" torrent-caching service: instead of AoNarr peering directly, it hands
 * Real-Debrid a magnet/torrent, waits for RD's own servers to fetch it, then unrestricts the
 * resulting link(s) into plain HTTPS downloads AoNarr pulls into downloadsDir itself, same as
 * HttpDownloadAdapter's tail end. client.apiKey holds the RD API token (Settings -> Account on
 * real-debrid.com); there's no host/port, it's always their public API.
 */
class RealDebridAdapter implements DownloadClientAdapter {
  private jobs = new Map<string, InProcessJob>();
  private readonly base = "https://api.real-debrid.com/rest/1.0";

  private headers(client: DownloadClient): Record<string, string> {
    return { Authorization: `Bearer ${client.apiKey}` };
  }

  async addDownload(
    client: DownloadClient,
    downloadUrl: string,
    _category: string | null,
    releaseTitle?: string
  ): Promise<GrabResult> {
    const downloadId = crypto.randomUUID();
    this.jobs.set(downloadId, { progress: 0, status: "downloading" });

    (async () => {
      const claimed: string[] = [];
      try {
        const torrentId = await this.addToRealDebrid(client, downloadUrl);
        const selectRes = await apiFetch(`${this.base}/torrents/selectFiles/${torrentId}`, {
          method: "POST",
          headers: { ...this.headers(client), "Content-Type": "application/x-www-form-urlencoded" },
          body: "files=all",
        });
        // 202 = already selected (re-added torrent); anything else non-2xx leaves the torrent stuck
        // in waiting_files_selection forever, so fail fast instead of polling it.
        if (!selectRes.ok && selectRes.status !== 202) throw new Error(`Real-Debrid selectFiles failed: HTTP ${selectRes.status}`);

        // Poll RD's own caching/download progress until it's fully fetched on their end.
        let links: string[] = [];
        const deadline = Date.now() + DEBRID_POLL_TIMEOUT_MS;
        for (;;) {
          if (Date.now() > deadline) throw new Error("Real-Debrid did not finish within the polling window");
          const res = await apiFetch(`${this.base}/torrents/info/${torrentId}`, { headers: this.headers(client) });
          if (!res.ok) throw new Error(`Real-Debrid status check failed: HTTP ${res.status}`);
          const info: any = await res.json();
          if (info.status === "error" || info.status === "magnet_error" || info.status === "virus" || info.status === "dead") {
            throw new Error(`Real-Debrid reported "${info.status}"`);
          }
          if (info.status === "downloaded") {
            links = info.links ?? [];
            break;
          }
          this.jobs.set(downloadId, { progress: Math.min((info.progress ?? 0) / 100, 0.99), status: "downloading" });
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (links.length === 0) throw new Error("Real-Debrid reported no files");

        const dir = inProcessJobDir(links.length, releaseTitle, downloadId, claimed);
        const saved: string[] = [];
        for (const [index, link] of links.entries()) {
          const unrestrictRes = await apiFetch(`${this.base}/unrestrict/link`, {
            method: "POST",
            headers: { ...this.headers(client), "Content-Type": "application/x-www-form-urlencoded" },
            body: `link=${encodeURIComponent(link)}`,
          });
          if (!unrestrictRes.ok) throw new Error(`Real-Debrid unrestrict failed: HTTP ${unrestrictRes.status}`);
          const unrestricted: any = await unrestrictRes.json();

          const fileRes = await fetch(unrestricted.download);
          if (!fileRes.ok || !fileRes.body) throw new Error(`Downloading unrestricted link failed: HTTP ${fileRes.status}`);
          const filename = sanitizeFilename(unrestricted.filename || releaseTitle || downloadId);
          const dest = claimFinalPath(dir, filename, downloadId);
          claimed.push(dest);
          await saveBodyToFile(fileRes.body, dest, partialPath(downloadId, index));
          saved.push(dest);
        }

        this.jobs.set(downloadId, completedJob(dir, saved));
        log.info(`[real-debrid] completed "${releaseTitle ?? downloadUrl}"`);
        await cleanupAtProvider("real-debrid", async () => {
          const res = await apiFetch(`${this.base}/torrents/delete/${torrentId}`, { method: "DELETE", headers: this.headers(client) });
          if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
        });
      } catch (err) {
        log.warn(`[real-debrid] failed for "${releaseTitle ?? downloadUrl}":`, (err as Error).message);
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      } finally {
        releaseFinalPaths(claimed);
      }
    })();

    return { downloadId };
  }

  /** Magnet URIs go straight to addMagnet; anything else is resolved first (see
   * resolveDownloadSource — an indexer's proxy/"get" endpoint commonly redirects to a magnet or
   * serves .torrent bytes directly, neither of which addTorrent/addMagnet can be handed the raw
   * proxy URL for). */
  private async addToRealDebrid(client: DownloadClient, downloadUrl: string): Promise<string> {
    const source = await resolveDownloadSource(downloadUrl);

    if (source.kind === "magnet") {
      const res = await apiFetch(`${this.base}/torrents/addMagnet`, {
        method: "POST",
        headers: { ...this.headers(client), "Content-Type": "application/x-www-form-urlencoded" },
        body: `magnet=${encodeURIComponent(source.uri)}`,
      });
      if (!res.ok) throw new Error(`Real-Debrid addMagnet failed: HTTP ${res.status}`);
      const body: any = await res.json();
      return body.id;
    }

    const addRes = await apiFetch(`${this.base}/torrents/addTorrent`, {
      method: "PUT",
      headers: this.headers(client),
      body: source.bytes,
    });
    if (!addRes.ok) throw new Error(`Real-Debrid addTorrent failed: HTTP ${addRes.status}`);
    const addBody: any = await addRes.json();
    return addBody.id;
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return inProcessStatuses(this.jobs, downloadIds);
  }
}

/**
 * TorBox — the same "debrid" torrent-caching shape as Real-Debrid/AllDebrid, just a different
 * provider — and unlike Real-Debrid/AllDebrid, it also caches Usenet, via a separate `/usenet/...`
 * API namespace that otherwise mirrors the torrent one exactly (`usenet_id` in place of
 * `torrent_id`, same mylist/requestdl shape). Which of the two a given client instance is used for
 * is controlled by its `downloadTypes` setting (Settings -> Download Clients) — see
 * services/scheduler.ts's pickClientForProtocol; defaults to torrent-only when unconfigured.
 * client.apiKey holds the TorBox API key (Settings on torbox.app); no host/port, always their
 * public API. Every response is wrapped as `{ success, detail, data }`; `success: false` (or an
 * item-level error/dead state) is treated as a failure the same way RD's `status === "error"` is.
 */
class TorBoxAdapter implements DownloadClientAdapter {
  private jobs = new Map<string, InProcessJob>();
  private readonly base = "https://api.torbox.app/v1/api";

  private headers(client: DownloadClient): Record<string, string> {
    return { Authorization: `Bearer ${client.apiKey}` };
  }

  async addDownload(
    client: DownloadClient,
    downloadUrl: string,
    _category: string | null,
    releaseTitle?: string,
    protocol?: SearchResult["protocol"]
  ): Promise<GrabResult> {
    const downloadId = crypto.randomUUID();
    this.jobs.set(downloadId, { progress: 0, status: "downloading" });
    const isUsenet = protocol === "usenet";
    const kind = isUsenet ? "usenet" : "torrents";
    const idParam = isUsenet ? "usenet_id" : "torrent_id";

    (async () => {
      const claimed: string[] = [];
      try {
        const itemId = isUsenet ? await this.addToTorBoxUsenet(client, downloadUrl, releaseTitle) : await this.addToTorBox(client, downloadUrl);

        // Poll TorBox's own caching/download progress until the files are actually present on
        // their end. `progress` has been observed both as a 0-1 fraction and a 0-100 percentage
        // depending on state, so it's normalized defensively rather than assumed either way.
        let files: { id: number; name?: string }[] = [];
        const deadline = Date.now() + DEBRID_POLL_TIMEOUT_MS;
        for (;;) {
          if (Date.now() > deadline) throw new Error("TorBox did not finish within the polling window");
          const res = await apiFetch(`${this.base}/${kind}/mylist?id=${itemId}&bypass_cache=true`, { headers: this.headers(client) });
          if (!res.ok) throw new Error(`TorBox status check failed: HTTP ${res.status}`);
          const body: any = await res.json();
          if (body.success === false) throw new Error(`TorBox reported: ${body.detail ?? "unknown error"}`);
          const info: any = Array.isArray(body.data) ? body.data[0] : body.data;
          if (!info) throw new Error(`TorBox reported no ${isUsenet ? "usenet download" : "torrent"} info`);
          if (typeof info.download_state === "string" && /error|dead|fail/i.test(info.download_state)) {
            throw new Error(`TorBox reported "${info.download_state}"`);
          }
          if (info.download_finished === true || info.download_present === true) {
            files = info.files ?? [];
            break;
          }
          const rawProgress = Number(info.progress ?? 0);
          const progress = rawProgress > 1 ? rawProgress / 100 : rawProgress;
          this.jobs.set(downloadId, { progress: Math.min(progress, 0.99), status: "downloading" });
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (files.length === 0) throw new Error("TorBox reported no files");

        const dir = inProcessJobDir(files.length, releaseTitle, downloadId, claimed);
        const saved: string[] = [];
        for (const [index, file] of files.entries()) {
          const dlRes = await apiFetch(
            `${this.base}/${kind}/requestdl?token=${encodeURIComponent(client.apiKey ?? "")}&${idParam}=${itemId}&file_id=${file.id}`
          );
          if (!dlRes.ok) throw new Error(`TorBox requestdl failed: HTTP ${dlRes.status}`);
          const dlBody: any = await dlRes.json();
          const downloadLink = dlBody.data;
          if (!downloadLink) throw new Error("TorBox requestdl returned no link");

          const fileRes = await fetch(downloadLink);
          if (!fileRes.ok || !fileRes.body) throw new Error(`Downloading TorBox link failed: HTTP ${fileRes.status}`);
          const filename = sanitizeFilename(file.name || releaseTitle || downloadId);
          const dest = claimFinalPath(dir, filename, downloadId);
          claimed.push(dest);
          await saveBodyToFile(fileRes.body, dest, partialPath(downloadId, index));
          saved.push(dest);
        }

        this.jobs.set(downloadId, completedJob(dir, saved));
        log.info(`[torbox] completed "${releaseTitle ?? downloadUrl}"`);
        await cleanupAtProvider("torbox", async () => {
          const res = await apiFetch(`${this.base}/${kind}/${isUsenet ? "controlusenetdownload" : "controltorrent"}`, {
            method: "POST",
            headers: { ...this.headers(client), "Content-Type": "application/json" },
            body: JSON.stringify({ [idParam]: itemId, operation: "delete" }),
          });
          if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
        });
      } catch (err) {
        log.warn(`[torbox] failed for "${releaseTitle ?? downloadUrl}":`, (err as Error).message);
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      } finally {
        releaseFinalPaths(claimed);
      }
    })();

    return { downloadId };
  }

  /** Magnet URIs and raw .torrent bytes both go to createtorrent as multipart form-data (TorBox
   * has no separate magnet-only endpoint the way Real-Debrid does) — see resolveDownloadSource for
   * why an indexer's proxy/"get" URL can't just be handed over as-is. */
  private async addToTorBox(client: DownloadClient, downloadUrl: string): Promise<string> {
    const source = await resolveDownloadSource(downloadUrl);

    const form = new FormData();
    if (source.kind === "magnet") {
      form.append("magnet", source.uri);
    } else {
      form.append("file", new Blob([source.bytes]), "upload.torrent");
    }
    // "1" = TorBox's own auto seeding preference; allow_zip=false so multi-file torrents come back
    // as individual files (matching files[]) rather than one zip requestdl would otherwise offer.
    form.append("seed", "1");
    form.append("allow_zip", "false");

    const res = await apiFetch(`${this.base}/torrents/createtorrent`, {
      method: "POST",
      headers: this.headers(client),
      body: form,
    });
    if (!res.ok) throw new Error(`TorBox createtorrent failed: HTTP ${res.status}`);
    const body: any = await res.json();
    if (body.success === false) throw new Error(`TorBox createtorrent rejected: ${body.detail ?? "unknown error"}`);
    const torrentId = body.data?.torrent_id ?? body.data?.id;
    if (!torrentId) throw new Error("TorBox createtorrent returned no torrent id");
    return String(torrentId);
  }

  /** An NZB has no magnet-style redirect ambiguity to resolve up front the way a torrent release
   * does — createusenetdownload's `link` param has TorBox fetch the indexer's download URL itself,
   * the same "hand the provider a URL it fetches on its own" shape AllDebrid's magnet/upload
   * already uses for an http(s) magnet-pointing URL. */
  private async addToTorBoxUsenet(client: DownloadClient, downloadUrl: string, releaseTitle?: string): Promise<string> {
    const form = new FormData();
    form.append("link", downloadUrl);
    if (releaseTitle) form.append("name", releaseTitle);

    const res = await apiFetch(`${this.base}/usenet/createusenetdownload`, {
      method: "POST",
      headers: this.headers(client),
      body: form,
    });
    if (!res.ok) throw new Error(`TorBox createusenetdownload failed: HTTP ${res.status}`);
    const body: any = await res.json();
    if (body.success === false) throw new Error(`TorBox createusenetdownload rejected: ${body.detail ?? "unknown error"}`);
    const usenetId = body.data?.usenetdownload_id ?? body.data?.id;
    if (!usenetId) throw new Error("TorBox createusenetdownload returned no id");
    return String(usenetId);
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return inProcessStatuses(this.jobs, downloadIds);
  }
}

/**
 * AllDebrid — the same "debrid" torrent-caching shape as Real-Debrid, just a different provider:
 * hand it a magnet/torrent, wait for AllDebrid's own servers to fetch it, unlock the resulting
 * link(s) into plain HTTPS downloads AoNarr pulls into downloadsDir itself. client.apiKey holds
 * the AllDebrid API key (Account -> API keys on alldebrid.com); no host/port needed.
 */
class AllDebridAdapter implements DownloadClientAdapter {
  private jobs = new Map<string, InProcessJob>();
  private readonly base = "https://api.alldebrid.com/v4";
  private readonly agent = "aonarr";

  private async call(client: DownloadClient, path: string, params: Record<string, string> = {}, base = this.base): Promise<any> {
    const url = new URL(`${base}${path}`);
    url.searchParams.set("agent", this.agent);
    url.searchParams.set("apikey", client.apiKey ?? "");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await apiFetch(url.toString());
    if (!res.ok) throw new Error(`AllDebrid request failed: HTTP ${res.status}`);
    const body: any = await res.json();
    if (body.status === "error") throw new Error(`AllDebrid: ${body.error?.message ?? body.error?.code ?? "unknown error"}`);
    return body.data;
  }

  /**
   * `/magnet/status` on the v4.1 base URL (used below for polling caching progress) no longer
   * includes a `links` field at all as of AllDebrid's v4.1 API — file/link data was split out into
   * this dedicated endpoint. Reading `magnet.links` from the v4.1 status response (the previous
   * bug — statusCode reached 4/"Ready" correctly, but `links` was always empty since it doesn't
   * exist there anymore) is what produced "AllDebrid reported no files" on every single grab
   * despite AllDebrid having genuinely finished caching the magnet.
   *
   * Response entries are a tree: a file has `n` (name)/`s` (size)/`l` (direct link); a folder has
   * `n`/`e` (child entries, files or nested folders) and no `l` — recursed here into one flat list.
   */
  private async callFiles(client: DownloadClient, magnetId: string): Promise<{ link: string; filename: string }[]> {
    const url = new URL(`${this.base}/magnet/files`);
    url.searchParams.set("agent", this.agent);
    url.searchParams.set("apikey", client.apiKey ?? "");
    const res = await apiFetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "id[]": magnetId }),
    });
    if (!res.ok) throw new Error(`AllDebrid request failed: HTTP ${res.status}`);
    const body: any = await res.json();
    if (body.status === "error") throw new Error(`AllDebrid: ${body.error?.message ?? body.error?.code ?? "unknown error"}`);

    const entries: any[] = body.data?.magnets?.[0]?.files ?? [];
    const flat: { link: string; filename: string }[] = [];
    function walk(nodes: any[]) {
      for (const node of nodes) {
        if (node.l) flat.push({ link: node.l, filename: node.n });
        else if (Array.isArray(node.e)) walk(node.e);
      }
    }
    walk(entries);
    return flat;
  }

  /** .torrent bytes go through the multipart file-upload endpoint rather than /magnet/upload —
   * AllDebrid's magnets[] param only accepts a magnet URI or an http(s) URL it fetches itself, not
   * raw file bytes AoNarr already has in hand. */
  private async callUploadFile(client: DownloadClient, bytes: Buffer, filename: string): Promise<any> {
    const url = new URL(`${this.base}/magnet/upload/file`);
    url.searchParams.set("agent", this.agent);
    url.searchParams.set("apikey", client.apiKey ?? "");
    const form = new FormData();
    form.append("files[]", new Blob([bytes]), filename);
    const res = await apiFetch(url.toString(), { method: "POST", body: form });
    if (!res.ok) throw new Error(`AllDebrid request failed: HTTP ${res.status}`);
    const body: any = await res.json();
    if (body.status === "error") throw new Error(`AllDebrid: ${body.error?.message ?? body.error?.code ?? "unknown error"}`);
    return body.data;
  }

  async addDownload(
    client: DownloadClient,
    downloadUrl: string,
    _category: string | null,
    releaseTitle?: string
  ): Promise<GrabResult> {
    const downloadId = crypto.randomUUID();
    this.jobs.set(downloadId, { progress: 0, status: "downloading" });

    (async () => {
      const claimed: string[] = [];
      try {
        // The indexer's downloadUrl is commonly a Torznab "get"/proxy endpoint, not a magnet or
        // .torrent itself — resolveDownloadSource follows redirects (a Location pointing at a
        // magnet: URI) and fetches raw bytes otherwise, since AllDebrid's magnets[] param rejects
        // a bare proxy URL outright (this was the MAGNET_INVALID_URI bug reports).
        const source = await resolveDownloadSource(downloadUrl);
        const uploadData =
          source.kind === "magnet"
            ? await this.call(client, "/magnet/upload", { "magnets[]": source.uri })
            : await this.callUploadFile(client, source.bytes, sanitizeFilename(releaseTitle || downloadId) + ".torrent");
        // /magnet/upload's response nests its result under `magnets[]`; /magnet/upload/file — a
        // different endpoint entirely, used for the .torrent-bytes case above — nests the exact
        // same shape under `files[]` instead. Reading `magnets[]` unconditionally here meant every
        // single .torrent upload was treated as a rejection even when AllDebrid had accepted it
        // fine, since `magnets` simply doesn't exist in that endpoint's response at all — this was
        // the reopened https://github.com/aon082910/AoNarr/issues/1 report ("the error has changed"
        // after the redirect/torrent-bytes resolution fix: real per-item errors like
        // MAGNET_INVALID_URI stopped surfacing, replaced by the generic fallback message below,
        // because `entry` was always undefined for a torrent-file upload).
        const entry = source.kind === "magnet" ? uploadData?.magnets?.[0] : uploadData?.files?.[0];
        const magnetId = entry?.id;
        if (!magnetId) throw new Error(entry?.error?.message ?? "AllDebrid rejected the magnet");

        // Poll AllDebrid's own caching progress until it's fully fetched on their end.
        let links: { link: string; filename: string }[] = [];
        const deadline = Date.now() + DEBRID_POLL_TIMEOUT_MS;
        for (;;) {
          if (Date.now() > deadline) throw new Error("AllDebrid did not finish within the polling window");
          const statusData = await this.call(client, "/magnet/status", { id: String(magnetId) }, "https://api.alldebrid.com/v4.1");
          // `data.magnets` is always an array — even filtered down to one id — never a bare object.
          // Reading it as a single object meant `magnet.statusCode` was always undefined, so neither
          // the failure check nor the "Ready" check ever fired: the loop just polled forever without
          // ever erroring or completing, which is exactly the "grab started but stuck" symptom
          // reported after the previous fix (that one was real too — this is a second, independent
          // bug in the same polling loop, not a regression from it).
          const magnet = Array.isArray(statusData?.magnets) ? statusData.magnets[0] : statusData?.magnets;
          if (!magnet) throw new Error("AllDebrid returned no status for this magnet");
          if (magnet.statusCode >= 5) throw new Error(`AllDebrid reported "${magnet.status}"`);
          if (magnet.statusCode === 4) {
            links = await this.callFiles(client, String(magnetId));
            break;
          }
          const total = magnet.size || 1;
          this.jobs.set(downloadId, { progress: Math.min((magnet.downloaded ?? 0) / total, 0.99), status: "downloading" });
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (links.length === 0) throw new Error("AllDebrid reported no files");

        const dir = inProcessJobDir(links.length, releaseTitle, downloadId, claimed);
        const saved: string[] = [];
        for (const [index, { link, filename: remoteFilename }] of links.entries()) {
          const unlockData = await this.call(client, "/link/unlock", { link });
          const directLink = unlockData?.link;
          if (!directLink) throw new Error("AllDebrid link/unlock returned no direct link");

          const fileRes = await fetch(directLink);
          if (!fileRes.ok || !fileRes.body) throw new Error(`Downloading unlocked link failed: HTTP ${fileRes.status}`);
          const filename = sanitizeFilename(unlockData.filename || remoteFilename || releaseTitle || downloadId);
          const dest = claimFinalPath(dir, filename, downloadId);
          claimed.push(dest);
          await saveBodyToFile(fileRes.body, dest, partialPath(downloadId, index));
          saved.push(dest);
        }

        this.jobs.set(downloadId, completedJob(dir, saved));
        log.info(`[alldebrid] completed "${releaseTitle ?? downloadUrl}"`);
        await cleanupAtProvider("alldebrid", () => this.call(client, "/magnet/delete", { id: String(magnetId) }));
      } catch (err) {
        log.warn(`[alldebrid] failed for "${releaseTitle ?? downloadUrl}":`, (err as Error).message);
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      } finally {
        releaseFinalPaths(claimed);
      }
    })();

    return { downloadId };
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return inProcessStatuses(this.jobs, downloadIds);
  }
}

/**
 * Blackhole — the oldest, most universal *Starr integration pattern, for a torrent/usenet client
 * with no usable HTTP API (or one AoNarr just hasn't written an adapter for yet): instead of
 * talking to the client at all, AoNarr drops the release into a folder the client is separately
 * configured to watch (`client.host` holds that folder's path, reusing the field the same way
 * Real-Debrid reuses `apiKey` for its token). A magnet link is written as a `.magnet` file
 * (content is just the URI — most watch-folder setups that support magnets at all expect this),
 * including one an indexer's download proxy redirects to (see resolveDownloadSource: Jackett and
 * Prowlarr answer magnet-only trackers that way); anything else is fetched and sniffed by content
 * (XML → `.nzb`, otherwise `.torrent`) since the shared adapter interface doesn't carry the result's
 * protocol through to here.
 *
 * AoNarr has no way to ask an unknown external client how a download is progressing, so there is no
 * real progress. It finds the result instead: configure the client to move COMPLETED downloads into
 * AoNarr's downloads folder (the same expectation Sonarr's Blackhole clients have of their completed
 * folder), named after the release. getStatus then reports the release complete once that entry has
 * been still for five minutes and holds no partial file, and the normal import takes it. A release
 * that never shows up there is failed after `blackholeTimeoutHours` (default 168), without blame.
 */
class BlackholeAdapter implements DownloadClientAdapter {
  async addDownload(client: DownloadClient, downloadUrl: string, _category: string | null, releaseTitle?: string, protocol?: SearchResult["protocol"]): Promise<GrabResult> {
    if (!client.host) throw new Error("Blackhole client has no watch folder path configured");
    fs.mkdirSync(client.host, { recursive: true });
    const uuid = crypto.randomUUID();
    const base = sanitizeFilename(releaseTitle || uuid);
    // The name rides in the id, because the only way to tell this download is done is to find what the
    // external client wrote under that name in the downloads folder (see getStatus).
    const downloadId = `${uuid}${BLACKHOLE_ID_SEPARATOR}${base}`;

    const source = await resolveDownloadSource(downloadUrl);
    if (source.kind === "magnet") {
      fs.writeFileSync(path.join(client.host, `${base}.magnet`), source.uri, "utf-8");
    } else {
      // A torrent file is bencoded (starts with "d"); an NZB is XML, plain, gzip-compressed or UTF-16 (normalizeNzb).
      const head = source.bytes;
      // The release's protocol settles it when known; a gzip-compressed .torrent is not mistaken for an NZB.
      const mayBeNzb =
        protocol === "torrent"
          ? false
          : protocol === "usenet" ||
            head.subarray(0, 20).toString("utf-8").trimStart().startsWith("<") ||
            (head[0] === 0x1f && head[1] === 0x8b) ||
            (head[0] === 0xff && head[1] === 0xfe) ||
            (head[0] === 0xfe && head[1] === 0xff) ||
            (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf);
      const nzb = mayBeNzb ? validateNzb(source.bytes) : null;
      fs.writeFileSync(path.join(client.host, `${base}${nzb ? ".nzb" : ".torrent"}`), nzb ?? source.bytes);
    }

    return { downloadId };
  }

  /**
   * A watch folder has no API to ask. What the external client downloads is expected in AoNarr's
   * downloads folder, named after the release, and only once it is complete (as Sonarr's Torrent/Usenet
   * Blackhole expect the client's completed folder): once an entry of that name is there and nothing in it
   * has changed for five minutes and nothing is still a partial file, the download is complete, reported with the
   * path found so the normal import takes it. Before that it reads as downloading. An id from before
   * the name was kept in it can't be looked up and stays downloading (it ages out instead, see
   * cleanupStalledDownloads).
   */
  /** What the external client wrote for this release into the downloads folder goes (DL21), and nothing outside that folder ever does. */
  async removeDownload(_client: DownloadClient, downloadId: string, deleteFiles: boolean): Promise<void> {
    if (!deleteFiles) return;
    const at = downloadId.indexOf(BLACKHOLE_ID_SEPARATOR);
    const found = at > 0 ? findBlackholeOutput(downloadId.slice(at + 1)) : null;
    if (!found) return;
    const root = path.resolve(config.downloadsDir);
    const target = path.resolve(found.path);
    if (target === root || !target.startsWith(root + path.sep)) return;
    fs.rmSync(target, { recursive: true, force: true });
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return downloadIds.map((id) => {
      const at = id.indexOf(BLACKHOLE_ID_SEPARATOR);
      const found = at > 0 ? findBlackholeOutput(id.slice(at + 1)) : null;
      if (!found) return { downloadId: id, progress: 0, status: "downloading" as const };
      if (found.partial || Date.now() - found.newestMtimeMs < BLACKHOLE_SETTLE_MS) {
        return { downloadId: id, progress: 0.99, status: "downloading" as const, remotePath: found.path };
      }
      return { downloadId: id, progress: 1, status: "completed" as const, remotePath: found.path };
    });
  }
}

const BLACKHOLE_ID_SEPARATOR = "|";
/** Nothing in the output may have changed for this long before it counts as complete. */
const BLACKHOLE_SETTLE_MS = 5 * 60_000;
/** What a watch folder holds itself or an external client writes beside a release: never the release. */
const BLACKHOLE_NON_OUTPUT = /\.(?:nzb|torrent|magnet|added|queued|loaded|nfo|jpg|jpeg|png|txt|sfv|srr|srt)$/i;
const PARTIAL_FILE = /\.(?:part|!qb|!ut|crdownload|aria2|tmp|downloading)$/i;

function comparableName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The entry in the downloads folder a Blackhole release was written to: a file or folder named after
 * the release (a file's extension aside), with the newest change time inside it and whether any
 * partial file is still there. */
export function findBlackholeOutput(releaseName: string): { path: string; newestMtimeMs: number; partial: boolean } | null {
  const wanted = comparableName(releaseName);
  if (!wanted) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(config.downloadsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  // A folder first, else a file that is not a drop of ours or a sidecar (an .nzb in the watch folder when
  // that is the downloads folder, a .jpg or .nfo beside the video).
  const named = entries.filter((entry) => {
    const stem = entry.isDirectory() ? entry.name : path.basename(entry.name, path.extname(entry.name));
    return comparableName(stem) === wanted && (entry.isDirectory() || !BLACKHOLE_NON_OUTPUT.test(entry.name));
  });
  named.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()));
  for (const entry of named.slice(0, 1)) {
    const full = path.join(config.downloadsDir, entry.name);
    let newest = 0;
    let partial = false;
    const visit = (p: string, depth: number) => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(p);
      } catch {
        return;
      }
      newest = Math.max(newest, stat.mtimeMs);
      if (PARTIAL_FILE.test(p)) partial = true;
      if (stat.isDirectory() && depth < 3) {
        let names: string[] = [];
        try {
          names = fs.readdirSync(p);
        } catch {
          // unreadable: treated as having nothing more in it
        }
        for (const name of names.slice(0, 2000)) visit(path.join(p, name), depth + 1);
      }
    };
    visit(full, 0);
    return { path: full, newestMtimeMs: newest, partial };
  }
  return null;
}

/** Whether the output of a Blackhole release is still being written: something in it changed within `withinMs`. A
 * release in that state is not expired, whatever its age. */
export function blackholeOutputBusy(downloadId: string, withinMs = 60 * 60_000): boolean {
  const at = downloadId.indexOf(BLACKHOLE_ID_SEPARATOR);
  const found = at > 0 ? findBlackholeOutput(downloadId.slice(at + 1)) : null;
  // Only a recent change counts: a growing partial file keeps changing, and one left behind by a client that gave up does not.
  return !!found && Date.now() - found.newestMtimeMs < withinMs;
}

/**
 * Soulseek, via a slskd daemon (client.host/port point at slskd's own web API, client.apiKey is
 * slskd's configured API key). Unlike the debrid clients, AoNarr doesn't pull the file down itself
 * — slskd performs the actual peer-to-peer transfer and saves into its own configured downloads
 * directory, the same "real external client, AoNarr just tracks its progress" shape as qBittorrent/
 * SABnzbd. Point slskd's download directory at one of AoNarr's root folders (or a path the importer
 * can reach) the same way you would for any other external client.
 *
 * `downloadUrl` here is always the `slskd://username/filename` pseudo-URI services/soulseek.ts's
 * searchSlskd() produces — Soulseek has no real download URL, only a (user, file) pair, so this is
 * how that pair rides through AoNarr's existing "grab posts a downloadUrl back" contract without
 * needing a special case throughout the rest of the search/grab pipeline.
 */
/** slskd's downloads directory per client, read once in a while: it changes with its configuration, not per poll. */
const SLSKD_DOWNLOADS_DIRECTORY = new Map<string, { dir: string | null; at: number }>();

class SlskdAdapter implements DownloadClientAdapter {
  private baseUrl(client: DownloadClient): string {
    return baseUrl(client);
  }

  private headers(client: DownloadClient): Record<string, string> {
    return client.apiKey ? { "X-API-Key": client.apiKey } : {};
  }

  async addDownload(client: DownloadClient, downloadUrl: string): Promise<GrabResult> {
    // A whole shared folder: every track is enqueued at once, and the folder is tracked as one download.
    const folder = decodeSlskdFolderUrl(downloadUrl);
    if (folder) {
      const res = await apiFetch(`${this.baseUrl(client)}/api/v0/transfers/downloads/${encodeURIComponent(folder.username)}`, {
        method: "POST",
        headers: { ...this.headers(client), "Content-Type": "application/json" },
        body: JSON.stringify(folder.files.map((f) => ({ filename: f.filename, size: f.size }))),
      });
      if (!res.ok) throw new Error(`slskd enqueue failed: HTTP ${res.status}`);
      // slskd answers 2xx even when some of the files could not be enqueued: a folder missing tracks is no album.
      const answer = (await res.json().catch(() => null)) as { failed?: unknown[] } | null;
      if (Array.isArray(answer?.failed) && answer!.failed!.length > 0) {
        throw new Error(`slskd could not enqueue ${answer!.failed!.length} of the ${folder.files.length} tracks`);
      }
      return { downloadId: slskdFolderDownloadId(folder) };
    }
    const { username, filename, size } = decodeSlskdDownloadUrl(downloadUrl);
    const res = await apiFetch(`${this.baseUrl(client)}/api/v0/transfers/downloads/${encodeURIComponent(username)}`, {
      method: "POST",
      headers: { ...this.headers(client), "Content-Type": "application/json" },
      body: JSON.stringify([{ filename, size }]),
    });
    if (!res.ok) throw new Error(`slskd enqueue failed: HTTP ${res.status}`);
    // slskd tracks transfers by (username, filename), not a generated id — encode both into the
    // downloadId so getStatus can look this specific transfer back up later.
    return { downloadId: `${username} ${filename}` };
  }

  /** The folder slskd saves downloads in (its own `directories.downloads` option), or null when it will not say. */
  private async downloadsDirectory(client: DownloadClient): Promise<string | null> {
    const key = `${client.id}:${client.host}:${client.port}`;
    const known = SLSKD_DOWNLOADS_DIRECTORY.get(key);
    if (known && Date.now() - known.at < 10 * 60 * 1000) return known.dir;
    const dir = await this.fetchDownloadsDirectory(client);
    SLSKD_DOWNLOADS_DIRECTORY.set(key, { dir, at: Date.now() });
    return dir;
  }

  private async fetchDownloadsDirectory(client: DownloadClient): Promise<string | null> {
    try {
      const res = await apiFetch(`${this.baseUrl(client)}/api/v0/options`, { headers: this.headers(client) });
      if (!res.ok) return null;
      const options = (await res.json()) as { directories?: { downloads?: unknown } };
      const dir = options?.directories?.downloads;
      return typeof dir === "string" && dir.trim() ? dir.trim().replace(/[\\/]+$/, "") : null;
    } catch {
      return null;
    }
  }

  /**
   * Takes the finished transfers out of slskd's list (DL21), which otherwise holds every download for ever and makes each
   * poll slower. A folder download is every transfer inside that folder; a file is the one transfer.
   */
  async removeDownload(client: DownloadClient, downloadId: string): Promise<void> {
    const res = await apiFetch(`${this.baseUrl(client)}/api/v0/transfers/downloads`, { headers: this.headers(client) });
    if (!res.ok) throw new Error(`slskd transfer list failed: HTTP ${res.status}`);
    const users = (await res.json()) as { username: string; directories?: { files?: any[] }[] }[];
    const folder = parseSlskdFolderDownloadId(downloadId);
    for (const u of users) {
      for (const dir of u.directories ?? []) {
        for (const f of dir.files ?? []) {
          const name = String(f.filename ?? "");
          const matches = folder
            ? u.username === folder.username && (name.startsWith(folder.directory + "\\") || name.startsWith(folder.directory + "/"))
            : `${u.username} ${name}` === downloadId;
          if (!matches || !f.id) continue;
          const del = await apiFetch(`${this.baseUrl(client)}/api/v0/transfers/downloads/${encodeURIComponent(u.username)}/${encodeURIComponent(String(f.id))}?remove=true`, {
            method: "DELETE",
            headers: this.headers(client),
          });
          if (!del.ok && del.status !== 404) throw new Error(`slskd remove failed: HTTP ${del.status}`);
        }
      }
    }
  }

  async getStatus(client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    const wanted = new Set(downloadIds);
    const res = await apiFetch(`${this.baseUrl(client)}/api/v0/transfers/downloads`, { headers: this.headers(client) });
    if (!res.ok) throw new Error(`slskd status failed: HTTP ${res.status}`);
    const users = (await res.json()) as { username: string; directories?: { files?: any[] }[] }[];

    const updates: QueueStatusUpdate[] = [];
    // A folder download is the sum of its tracks: done when all of them are, failed when any is.
    for (const id of downloadIds) {
      const folder = parseSlskdFolderDownloadId(id);
      if (!folder) continue;
      const prefix = folder.directory;
      const tracks: any[] = [];
      for (const u of users) {
        if (u.username !== folder.username) continue;
        // Files of the folder itself: a sibling folder that begins with the same name is another album.
        for (const dir of u.directories ?? []) {
          for (const f of dir.files ?? []) {
            const name = String(f.filename ?? "");
            if (name.startsWith(prefix + "\\") || name.startsWith(prefix + "/")) tracks.push(f);
          }
        }
      }
      if (tracks.length === 0) continue;
      const states = tracks.map((f) => String(f.state ?? ""));
      const failed = states.some((state) => /Errored|Cancelled|Rejected|TimedOut|Aborted/.test(state) || (state.includes("Completed") && !state.includes("Succeeded")));
      const done = states.every((state) => state.includes("Succeeded")) && tracks.length >= folder.count;
      const total = tracks.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
      const moved = tracks.reduce((sum, f) => sum + Math.min(Number(f.bytesTransferred) || 0, Number(f.size) || 0), 0);
      const stalled = !done && !failed && states.every((state) => state === "Queued, Remotely" || state === "Requested");
      // slskd saves a folder under the name of the remote folder, in its downloads directory.
      const downloads = await this.downloadsDirectory(client);
      const folderName = folder.directory.split(/[\\/]/).filter(Boolean).pop();
      updates.push({
        downloadId: id,
        ...(downloads && folderName ? { remotePath: `${downloads}${downloads.includes("\\") && !downloads.includes("/") ? "\\" : "/"}${folderName}` } : {}),
        progress: done ? 1 : total > 0 ? Math.min(moved / total, 1) : 0,
        status: failed ? "failed" : done ? "completed" : "downloading",
        ...(stalled ? { stalled: true } : {}),
      });
    }
    for (const u of users) {
      for (const dir of u.directories ?? []) {
        for (const f of dir.files ?? []) {
          const downloadId = `${u.username} ${f.filename}`;
          if (!wanted.has(downloadId)) continue;
          const state = String(f.state ?? "");
          // slskd's terminal states are all "Completed, <reason>" — only Succeeded is a real
          // completion; Rejected (peer not sharing it / queue full), TimedOut, Aborted, Errored and
          // Cancelled are all terminal failures that used to fall through to "downloading" forever,
          // never reaching stalled cleanup (no progress change) and blocking any re-search.
          const failed = /Errored|Cancelled|Rejected|TimedOut|Aborted/.test(state) || (state.includes("Completed") && !state.includes("Succeeded"));
          const status = state.includes("Succeeded") ? "completed" : failed ? "failed" : "downloading";
          const progress = f.size > 0 ? Math.min((f.bytesTransferred ?? 0) / f.size, 1) : 0;
          // Waiting on the peer, who may never serve it; "Queued, Locally" is slskd's own queue.
          const stalled = status === "downloading" && (state === "Queued, Remotely" || state === "Requested");
          updates.push({ downloadId, progress, status, ...(stalled ? { stalled: true } : {}) });
        }
      }
    }
    return updates;
  }
}

/**
 * NZBGet (Round 27, DL14). JSON-RPC over HTTP at <base>/jsonrpc with basic auth. The NZB is fetched here and
 * sent as base64 (the same reasoning as SABnzbd's upload: a client that guards against SSRF refuses a
 * loopback indexer when it fetches the URL itself).
 */
async function nzbgetRpc(client: DownloadClient, method: string, params: unknown[] = []): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (client.username || client.password) {
    headers.Authorization = `Basic ${Buffer.from(`${client.username ?? ""}:${client.password ?? ""}`).toString("base64")}`;
  }
  const res = await apiFetch(`${baseUrl(client)}/jsonrpc`, { method: "POST", headers, body: JSON.stringify({ method, params, id: 1 }) });
  if (res.status === 401 || res.status === 403) throw new Error("NZBGet rejected the login — check the username and password.");
  if (!res.ok) throw new Error(`NZBGet ${method} failed: HTTP ${res.status}`);
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new Error("NZBGet answered with something that is not JSON — check host, port and URL base.");
  }
  if (body?.error) throw new Error(`NZBGet ${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body?.result;
}

/** NZBGet queue states that mean the group is not running: held or waiting its turn. */
const NZBGET_IDLE_STATES = new Set(["PAUSED", "QUEUED"]);
/** Post-processing states: the group has left the download queue but is not finished yet. */
const NZBGET_POSTPROCESSING = /^(PP_|LOADING_PARS|VERIFYING|REPAIRING|RENAMING|UNPACKING|MOVING|EXECUTING_SCRIPT)/;

/** A size NZBGet reports as two 32-bit halves (`<name>Lo`, `<name>Hi`); the whole-megabyte field is the fallback for an old build. */
function nzbgetBytes(group: any, name: string): number {
  const lo = group?.[`${name}Lo`];
  const hi = group?.[`${name}Hi`];
  if (lo !== undefined || hi !== undefined) return (Number(hi ?? 0) >>> 0) * 2 ** 32 + (Number(lo ?? 0) >>> 0);
  return (Number(group?.[`${name}MB`]) || 0) * 1024 * 1024;
}

/** NZBGet's history status as words: "FAILURE/HEALTH" alone does not say that articles were missing. */
function nzbgetFailureReason(status: string, history: any): string {
  const health = Number(history?.Health);
  const critical = Number(history?.CriticalHealth);
  const words: Record<string, string> = {
    "FAILURE/HEALTH": Number.isFinite(health) && Number.isFinite(critical) && critical > 0 ? `too many articles missing (health ${health / 10}%, below the critical ${critical / 10}%)` : "too many articles missing",
    "FAILURE/SCAN": "the NZB could not be read or lists no files",
    "FAILURE/PAR": "par repair failed",
    "FAILURE/UNPACK": "unpacking failed",
    "FAILURE/MOVE": "the result could not be moved to its folder",
    "FAILURE/BAD": "marked bad by a script",
    "DELETED/MANUAL": "deleted in NZBGet",
    "DELETED/DUPE": "dropped as a duplicate",
    "DELETED/COPY": "dropped as a copy of another download",
    "DELETED/GOOD": "deleted in NZBGet",
  };
  return words[status] ? `NZBGet: ${words[status]} (${status})` : `NZBGet: ${status}`;
}

export class NzbgetAdapter implements DownloadClientAdapter {
  async addDownload(client: DownloadClient, downloadUrl: string, category: string | null, releaseTitle?: string): Promise<GrabResult> {
    const source = await resolveDownloadSource(downloadUrl);
    if (source.kind === "magnet") throw new Error("NZBGet cannot accept a magnet link");
    const nzb = validateNzb(source.bytes);
    // append(NZBFilename, NZBContent, Category, Priority, AddToTop, AddPaused, DupeKey, DupeScore, DupeMode, PPParameters)
    const id = await nzbgetRpc(client, "append", [
      `${sanitizeFilename(releaseTitle || "release")}.nzb`,
      nzb.toString("base64"),
      category ?? "",
      0,
      false,
      false,
      "",
      0,
      // FORCE turns NZBGet's duplicate handling off, as Sonarr does for a grab: a release found again (after its file was
      // deleted, or while its first copy is still in the history) must download. "ALL" only means "check against every
      // group", and NZBGet then discards the repeat as DELETED/COPY while still answering with an id.
      "FORCE",
      [],
    ]);
    // NZBGet answers an id of 0 or less when it refused the file.
    if (typeof id !== "number" || id <= 0) throw new Error("NZBGet did not add the NZB (it answered with no id)");
    return { downloadId: String(id) };
  }

  /** NZBGet's global status (post-processing paused, the current download rate), asked once per poll. */
  private async globalStatus(client: DownloadClient, cache: { value?: { postPaused: boolean; downloadRate: number } | null }) {
    if (cache.value === undefined) {
      try {
        const status: any = await nzbgetRpc(client, "status");
        cache.value = { postPaused: status?.PostPaused === true, downloadRate: Number(status?.DownloadRate) || 0 };
      } catch {
        cache.value = null;
      }
    }
    return cache.value;
  }

  async getStatus(client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    const wanted = new Set(downloadIds);
    const updates: QueueStatusUpdate[] = [];
    const globalCache: { value?: { postPaused: boolean; downloadRate: number } | null } = {};
    const groups: any[] = (await nzbgetRpc(client, "listgroups", [0])) ?? [];
    const seen = new Set<string>();
    for (const g of groups) {
      const id = String(g.NZBID);
      if (!wanted.has(id)) continue;
      seen.add(id);
      const status = String(g.Status ?? "");
      // Bytes, not the whole megabytes of FileSizeMB/RemainingSizeMB (a 150 kB NZB reads as 0 there).
      const total = nzbgetBytes(g, "FileSize");
      const left = nzbgetBytes(g, "RemainingSize");
      const progress = total > 0 ? Math.min(Math.max((total - left) / total, 0), 0.99) : 0;
      const postProcessing = NZBGET_POSTPROCESSING.test(status);
      // Taken from NZBGet's global status, once per poll and only when a group needs it.
      const globals = status === "PP_QUEUED" || status === "DOWNLOADING" ? await this.globalStatus(client, globalCache) : null;
      updates.push({
        downloadId: id,
        progress: postProcessing ? 0.99 : progress,
        status: "downloading",
        ...(NZBGET_IDLE_STATES.has(status) ? { paused: true } : {}),
        // Pausing the download in NZBGet 26 also pauses post-processing: groups then wait in PP_QUEUED for good, and look
        // like downloads at 99%. They are paused, not stuck.
        ...(status === "PP_QUEUED" && globals?.postPaused ? { paused: true } : {}),
        ...(left > 0 ? { sizeLeft: left } : {}),
        ...(status === "DOWNLOADING" && left > 0 && globals && globals.downloadRate > 0 ? { etaSeconds: Math.round(left / globals.downloadRate) } : {}),
      });
    }
    const missing = downloadIds.filter((id) => !seen.has(id));
    if (missing.length > 0) {
      const history: any[] = (await nzbgetRpc(client, "history", [false])) ?? [];
      for (const h of history) {
        const id = String(h.NZBID);
        if (!missing.includes(id)) continue;
        const status = String(h.Status ?? "");
        // NZBGet's history statuses: SUCCESS/ALL|UNPACK|PAR|HEALTH|GOOD|MARK, WARNING/SCRIPT|SPACE|PASSWORD|DAMAGED|REPAIRABLE|HEALTH,
        // DELETED/MANUAL|DUPE|COPY|GOOD, FAILURE/PAR|UNPACK|MOVE|SCAN|BAD|HEALTH.
        if (status === "WARNING/SPACE") {
          // Not enough disk space is the client's problem, not the release's: kept with the message, nothing blocklisted.
          updates.push({ downloadId: id, progress: 0.99, status: "downloading", warning: "NZBGet: not enough disk space" });
        } else if (/^WARNING\/(?:PASSWORD|DAMAGED|HEALTH|REPAIRABLE)/.test(status)) {
          // Unpacked data cannot be trusted: a failure of the release.
          updates.push({ downloadId: id, progress: 1, status: "failed", failureReason: nzbgetFailureReason(status, h) });
        } else if (/^(SUCCESS|WARNING)/.test(status)) {
          updates.push({ downloadId: id, progress: 1, status: "completed", remotePath: h.FinalDir || h.DestDir || undefined });
        } else if (/^(FAILURE|DELETED)/.test(status)) {
          updates.push({
            downloadId: id,
            progress: 1,
            status: "failed",
            failureReason: nzbgetFailureReason(status, h),
            ...(/^DELETED\/(?:COPY|DUPE)/.test(status) ? { noBlame: true } : {}),
          });
        } else {
          updates.push({ downloadId: id, progress: 0.99, status: "downloading" });
        }
      }
    }
    return updates;
  }

  async setPriority(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void> {
    const command = priority === "top" ? "GroupMoveTop" : "GroupMoveBottom";
    const ok = await nzbgetRpc(client, "editqueue", [command, "", [Number(downloadId)]]);
    if (ok === false) throw new Error(`NZBGet ${command} did not apply`);
  }

  /** A group is in the queue (a client-level failure caught it) or in history: the delete is tried in both places. */
  async removeDownload(client: DownloadClient, downloadId: string, deleteFiles: boolean): Promise<void> {
    const id = Number(downloadId);
    if (!Number.isFinite(id)) return;
    await nzbgetRpc(client, "editqueue", [deleteFiles ? "GroupFinalDelete" : "GroupDelete", "", [id]]);
    await nzbgetRpc(client, "editqueue", [deleteFiles ? "HistoryFinalDelete" : "HistoryDelete", "", [id]]);
  }
}

/**
 * Transmission (Round 27, DL14). RPC at <base>/transmission/rpc (the URL base is "/transmission" unless set):
 * a request without the session id is answered 409 with the id to send, and the request is repeated. A
 * torrent is addressed by its hash. Categories become labels (Transmission 3.0 and later); a torrent that
 * AoNarr imported by hardlink gets the label "aonarr-imported" and an indexer's seed goal a label too, like
 * qBittorrent's tags.
 */
const TRANSMISSION_SESSION_IDS = new Map<number, string>();
const TRANSMISSION_LABEL = "aonarr";

function transmissionUrl(client: DownloadClient): string {
  const url = new URL(baseUrl(client));
  if (!client.urlBase || client.urlBase === "/") url.pathname = "/transmission";
  return `${url.toString().replace(/\/+$/, "")}/rpc`;
}

async function transmissionRpc(client: DownloadClient, method: string, args: Record<string, unknown> = {}): Promise<any> {
  const attempt = async (): Promise<Response> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const session = TRANSMISSION_SESSION_IDS.get(client.id);
    if (session) headers["X-Transmission-Session-Id"] = session;
    if (client.username || client.password) {
      headers.Authorization = `Basic ${Buffer.from(`${client.username ?? ""}:${client.password ?? ""}`).toString("base64")}`;
    }
    return apiFetch(transmissionUrl(client), { method: "POST", headers, body: JSON.stringify({ method, arguments: args }) });
  };
  let res = await attempt();
  if (res.status === 409) {
    const session = res.headers.get("x-transmission-session-id");
    if (!session) throw new Error("Transmission answered 409 without a session id — check host, port and URL base.");
    TRANSMISSION_SESSION_IDS.set(client.id, session);
    res = await attempt();
  }
  if (res.status === 401 || res.status === 403) throw new Error("Transmission rejected the login — check the username and password.");
  if (!res.ok) throw new Error(`Transmission ${method} failed: HTTP ${res.status}`);
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new Error("Transmission answered with something that is not JSON — check host, port and URL base.");
  }
  if (body?.result !== "success") throw new Error(`Transmission ${method} failed: ${body?.result ?? "no result"}`);
  return body.arguments ?? {};
}

/** Transmission's torrent status numbers. */
const TRANSMISSION_STOPPED = 0;
const TRANSMISSION_CHECKING = new Set([1, 2]);
const TRANSMISSION_QUEUED = new Set([3, 5]);

export class TransmissionAdapter implements DownloadClientAdapter {
  async addDownload(client: DownloadClient, downloadUrl: string, category: string | null): Promise<GrabResult> {
    const source = await resolveDownloadSource(downloadUrl);
    // paused: false starts it even when Transmission is set to add torrents stopped.
    const args: Record<string, unknown> = { labels: category ? [TRANSMISSION_LABEL, category] : [TRANSMISSION_LABEL], paused: false };
    if (source.kind === "magnet") args.filename = source.uri;
    else args.metainfo = source.bytes.toString("base64");
    const added = await transmissionRpc(client, "torrent-add", args);
    // A duplicate is answered as "torrent-duplicate": tracked, as qBittorrent's duplicate add is.
    const torrent = added["torrent-added"] ?? added["torrent-duplicate"];
    if (!torrent?.hashString) throw new Error("Transmission did not add the torrent (it answered with no torrent)");
    const hash = String(torrent.hashString).toLowerCase();
    // Before Transmission 4.0 `torrent-add` ignores `labels` (3.0 added them to torrent-set only): set them again, best effort.
    await transmissionRpc(client, "torrent-set", { ids: [hash], labels: args.labels }).catch(() => undefined);
    return { downloadId: hash };
  }

  private async torrents(client: DownloadClient, ids?: string[]): Promise<any[]> {
    const answer = await transmissionRpc(client, "torrent-get", {
      ...(ids ? { ids } : {}),
      fields: [
        "id", "hashString", "name", "status", "percentDone", "totalSize", "leftUntilDone", "eta", "error", "errorString",
        "downloadDir", "labels", "uploadRatio", "secondsSeeding", "isStalled", "peersConnected", "sizeWhenDone", "metadataPercentComplete",
      ],
    });
    return Array.isArray(answer.torrents) ? answer.torrents : [];
  }

  async getStatus(client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    const wanted = new Set(downloadIds.map((id) => id.toLowerCase()));
    const updates: QueueStatusUpdate[] = [];
    // Only the torrents asked about (a client with thousands of torrents answered all of them at every poll); with none
    // asked about, the call is just a reachability check.
    if (wanted.size === 0) {
      await transmissionRpc(client, "session-get", { fields: ["version"] });
      return updates;
    }
    for (const t of await this.torrents(client, [...wanted])) {
      const hash = String(t.hashString ?? "").toLowerCase();
      if (!wanted.has(hash)) continue;
      const done = Number(t.percentDone) >= 1 && Number(t.leftUntilDone) === 0;
      const status = Number(t.status);
      // error 1 and 2 are tracker warnings and errors (the torrent still downloads); 3 is a local error
      // (a full disk, a permission): the client's, not the release's.
      const localError = Number(t.error) === 3 ? String(t.errorString || "local error") : null;
      const sizeLeft = Number(t.leftUntilDone);
      updates.push({
        downloadId: downloadIds.find((id) => id.toLowerCase() === hash) ?? hash,
        progress: Math.min(Number(t.percentDone) || 0, 1),
        status: done && !TRANSMISSION_CHECKING.has(status) ? "completed" : "downloading",
        ...(!done && status === TRANSMISSION_STOPPED ? { paused: true } : {}),
        ...(!done && TRANSMISSION_QUEUED.has(status) ? { paused: true } : {}),
        ...(!done && t.isStalled && status === 4 ? { stalled: true } : {}),
        ...(!done && localError ? { warning: `Transmission: ${localError}` } : {}),
        ...(!done && Number(t.eta) > 0 ? { etaSeconds: Number(t.eta) } : {}),
        ...(!done && Number.isFinite(sizeLeft) && sizeLeft > 0 ? { sizeLeft } : {}),
        // Before the metadata is in, "name" is the magnet's dn (or the hash): not a path anything will ever be at.
        remotePath: t.downloadDir && t.name && !(Number(t.metadataPercentComplete) < 1) ? `${String(t.downloadDir).replace(/[\\/]+$/, "")}/${t.name}` : undefined,
        clientTitle: typeof t.name === "string" ? t.name : undefined,
      });
    }
    return updates;
  }

  async setPriority(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void> {
    await transmissionRpc(client, priority === "top" ? "queue-move-top" : "queue-move-bottom", { ids: [downloadId.toLowerCase()] });
  }

  async removeDownload(client: DownloadClient, downloadId: string, deleteFiles: boolean): Promise<void> {
    await transmissionRpc(client, "torrent-remove", { ids: [downloadId.toLowerCase()], "delete-local-data": deleteFiles });
  }

  /** The labels a torrent has now, so a label can be added without dropping the others. */
  private async labelsOf(client: DownloadClient, hash: string): Promise<string[]> {
    const answer = await transmissionRpc(client, "torrent-get", { ids: [hash], fields: ["labels"] });
    const labels = answer.torrents?.[0]?.labels;
    return Array.isArray(labels) ? labels.map(String) : [];
  }

  async markImported(client: DownloadClient, downloadId: string, seedGoal?: SeedGoal | null, dataSafe = true): Promise<void> {
    const additions = [dataSafe ? QBIT_IMPORTED_TAG : null, seedGoalTag(seedGoal)].filter((label): label is string => !!label);
    if (additions.length === 0) return;
    const hash = downloadId.toLowerCase();
    // AoNarr's own label comes with the mark, so a torrent added before labels worked in torrent-add is found by the cleanup.
    const labels = await this.labelsOf(client, hash);
    await transmissionRpc(client, "torrent-set", { ids: [hash], labels: [...new Set([...labels, TRANSMISSION_LABEL, ...additions])] });
  }

  async removeSeededTorrents(client: DownloadClient, ratioGoal: number | null, seedTimeGoalMinutes: number | null, skipIds?: Set<string>): Promise<number> {
    const eligible = (await this.torrents(client)).filter((t) => {
      const labels: string[] = Array.isArray(t.labels) ? t.labels.map(String) : [];
      if (skipIds?.has(String(t.hashString).toLowerCase())) return false;
      // Seeding (status 6), waiting to seed (5), or stopped by Transmission's own limit after finishing (status 0 at 100%), and only AoNarr's own.
      const stoppedAtLimit = Number(t.status) === 0 && Number(t.percentDone) >= 1;
      if (!labels.includes(TRANSMISSION_LABEL) || !([5, 6].includes(Number(t.status)) || stoppedAtLimit)) return false;
      const own = parseSeedGoalTag(labels.join(","));
      const ratio = own?.ratio ?? ratioGoal;
      const minutes = own?.minutes ?? seedTimeGoalMinutes;
      const ratioMet = ratio !== null && Number(t.uploadRatio) >= ratio;
      const timeMet = minutes !== null && Number(t.secondsSeeding) / 60 >= minutes;
      return ratioMet || timeMet;
    });
    for (const t of eligible) {
      const labels: string[] = Array.isArray(t.labels) ? t.labels.map(String) : [];
      // The data goes only with a torrent AoNarr imported by hardlink; any other keeps its data.
      await transmissionRpc(client, "torrent-remove", { ids: [String(t.hashString).toLowerCase()], "delete-local-data": labels.includes(QBIT_IMPORTED_TAG) });
    }
    return eligible.length;
  }
}

/**
 * Deluge (Round 27, DL14). The web UI's JSON-RPC at <base>/json: a login with the web password gives a session
 * cookie, and the web UI has to be connected to a daemon (the first listed host is connected when it is not).
 * Deluge has no categories without its Label plugin; the label is set when that plugin is enabled.
 */
const DELUGE_COOKIES = new Map<number, string>();

/** The Python traceback wrapper Deluge puts around an error ("Failure: [Failure instance: Traceback ...: <class ...>: text"). */
function tidyDelugeError(text: string): string {
  return text
    .replace(/^Failure:\s*\[Failure instance:\s*Traceback \(failure with no frames\):\s*<class '[^']*'>:\s*/i, "")
    .replace(/\s*\]\s*$/, "")
    .trim();
}

/** A core call that gets no answer within this long is taken for a web UI that lost its daemon (see delugeRpc). */
const DELUGE_CORE_TIMEOUT_MS = 10_000;

async function delugeRpc(client: DownloadClient, method: string, params: unknown[] = [], retried = false): Promise<any> {
  const cookie = DELUGE_COOKIES.get(client.id);
  const isCore = /^(?:core|label)\./.test(method);
  // Only the poll (a status query for some torrents) gives up after 10 s; an add or a listing of everything may take longer.
  const shortCeiling = method === "core.get_torrents_status" && Array.isArray(params[0] ? Object.values(params[0] as object)[0] : null);
  let res: Response;
  try {
    res = await apiFetch(`${baseUrl(client)}/json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ method, params, id: 1 }),
      ...(shortCeiling ? { signal: AbortSignal.timeout(DELUGE_CORE_TIMEOUT_MS) } : {}),
    });
  } catch (err) {
    // After deluged restarts, the web UI stays logged in but is no longer connected to the daemon, and answers every
    // core call with silence instead of an error: only a connect brings it back, so a silent core call checks for that.
    if (!retried && isCore && ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError")) {
      const connected = await delugeRpc(client, "web.connected", [], true).catch(() => null);
      if (connected === false) {
        await delugeLogin(client);
        return delugeRpc(client, method, params, true);
      }
    }
    throw err;
  }
  if (!res.ok) throw new Error(`Deluge ${method} failed: HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) DELUGE_COOKIES.set(client.id, setCookie.split(";")[0]);
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new Error("Deluge answered with something that is not JSON — check host, port and URL base.");
  }
  if (body?.error) {
    // An expired session is answered with an error (code 1): log in again once.
    if (!retried && method !== "auth.login" && Number(body.error.code) === 1) {
      DELUGE_COOKIES.delete(client.id);
      await delugeLogin(client);
      return delugeRpc(client, method, params, true);
    }
    // The web UI lost its daemon (deluged restarted while deluge-web kept running): a core call fails with another code,
    // and the session is still good. Connected again if it is not, and the call repeated once.
    if (!retried && /^(?:core|label)\./.test(method) && (await delugeRpc(client, "web.connected", [], true).catch(() => true)) === false) {
      await delugeLogin(client);
      return delugeRpc(client, method, params, true);
    }
    throw new Error(`Deluge ${method} failed: ${tidyDelugeError(String(body.error.message ?? JSON.stringify(body.error)))}`);
  }
  return body?.result;
}

async function delugeLogin(client: DownloadClient): Promise<void> {
  const ok = await delugeRpc(client, "auth.login", [client.password ?? ""]);
  if (ok !== true) throw new Error("Deluge rejected the login — check the web UI password.");
  // The web UI needs a daemon connection before it answers anything about torrents.
  if ((await delugeRpc(client, "web.connected")) !== true) {
    const hosts: any[] = (await delugeRpc(client, "web.get_hosts")) ?? [];
    if (hosts.length === 0) throw new Error("Deluge's web UI knows no daemon to connect to.");
    await delugeRpc(client, "web.connect", [hosts[0][0]]);
  }
}

async function delugeCall(client: DownloadClient, method: string, params: unknown[] = []): Promise<any> {
  if (!DELUGE_COOKIES.has(client.id)) await delugeLogin(client);
  return delugeRpc(client, method, params);
}

const DELUGE_PAUSED_STATES = new Set(["Paused", "Queued"]);

export class DelugeAdapter implements DownloadClientAdapter {
  async addDownload(client: DownloadClient, downloadUrl: string, category: string | null, _releaseTitle?: string, _protocol?: SearchResult["protocol"], addOptions: AddOptions = {}): Promise<GrabResult> {
    const source = await resolveDownloadSource(downloadUrl);
    // The seed ratio goal goes to Deluge with the torrent (it then stops seeding at the goal by itself, whatever AoNarr's own
    // cleanup does later); Deluge has no per-torrent seed time.
    const options: Record<string, unknown> = { add_paused: false, ...(addOptions.seedGoal?.ratio ? { stop_at_ratio: true, stop_ratio: addOptions.seedGoal.ratio, remove_at_ratio: false } : {}) };
    let hash: unknown;
    try {
      if (source.kind === "magnet") hash = await delugeCall(client, "core.add_torrent_magnet", [source.uri, options]);
      else hash = await delugeCall(client, "core.add_torrent_file", ["release.torrent", source.bytes.toString("base64"), options]);
    } catch (err) {
      // Deluge refuses a torrent it already holds: that one is tracked, as qBittorrent's and Transmission's duplicate adds are.
      const message = (err as Error).message;
      // The error names the torrent it already holds, for a file as well as a magnet ("Torrent already in session (<hash>)").
      const named = /already in session \(([0-9a-f]{40,64})\)/i.exec(message)?.[1];
      if (named) return { downloadId: named.slice(0, 40).toLowerCase() };
      const known = source.kind === "magnet" ? magnetInfoHash(source.uri) : null;
      if (known && /already (?:in|added)/i.test(message)) return { downloadId: known.toLowerCase() };
      throw err;
    }
    if (typeof hash !== "string" || !hash) throw new Error("Deluge did not add the torrent (it answered with no hash)");
    const id = hash.toLowerCase();
    if (category) {
      // The Label plugin is optional: a torrent without a label is still tracked.
      try {
        const plugins: string[] = (await delugeCall(client, "core.get_enabled_plugins")) ?? [];
        if (plugins.includes("Label")) {
          // The Label plugin keeps ids in lower case, with letters, digits and "_.-" only.
          const label = category.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
          const labels: string[] = (await delugeCall(client, "label.get_labels")) ?? [];
          if (!labels.includes(label)) await delugeCall(client, "label.add", [label]);
          await delugeCall(client, "label.set_torrent", [id, label]);
        }
      } catch (err) {
        log.warn(`[downloadClient] Deluge label "${category}" was not set:`, (err as Error).message);
      }
    }
    return { downloadId: id };
  }

  async getStatus(client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    const wanted = new Set(downloadIds.map((id) => id.toLowerCase()));
    const keys = ["name", "state", "progress", "total_size", "total_done", "eta", "save_path", "message", "is_finished", "download_payload_rate"];
    const updates: QueueStatusUpdate[] = [];
    // Only the torrents asked about; with none asked about, the call is just a reachability check.
    if (wanted.size === 0) {
      // Logged in but not connected to the daemon is not reachable: a connect is made (the login does it).
      if ((await delugeCall(client, "web.connected")) !== true) await delugeLogin(client);
      return updates;
    }
    const torrents: Record<string, any> = (await delugeCall(client, "core.get_torrents_status", [{ id: [...wanted] }, keys])) ?? {};
    for (const [hash, t] of Object.entries(torrents)) {
      if (!wanted.has(hash.toLowerCase())) continue;
      const state = String(t.state ?? "");
      const progress = Math.min((Number(t.progress) || 0) / 100, 1);
      const done = progress >= 1 && state !== "Checking" && state !== "Moving";
      // Deluge's "Error" state carries the daemon's message (a full disk, a missing file): the client's, not the release's.
      const warning = state === "Error" ? `Deluge: ${t.message || "error"}` : null;
      const left = Math.max((Number(t.total_size) || 0) - (Number(t.total_done) || 0), 0);
      updates.push({
        downloadId: downloadIds.find((id) => id.toLowerCase() === hash.toLowerCase()) ?? hash,
        progress,
        status: done ? "completed" : "downloading",
        ...(!done && DELUGE_PAUSED_STATES.has(state) ? { paused: true } : {}),
        ...(!done && state === "Downloading" && Number(t.download_payload_rate) === 0 && Number(t.eta) === 0 ? { stalled: true } : {}),
        ...(!done && warning ? { warning } : {}),
        ...(!done && Number(t.eta) > 0 ? { etaSeconds: Number(t.eta) } : {}),
        ...(!done && left > 0 ? { sizeLeft: left } : {}),
        remotePath: t.save_path && t.name ? `${String(t.save_path).replace(/[\\/]+$/, "")}/${t.name}` : undefined,
        clientTitle: typeof t.name === "string" ? t.name : undefined,
      });
    }
    return updates;
  }

  async setPriority(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void> {
    await delugeCall(client, priority === "top" ? "core.queue_top" : "core.queue_bottom", [[downloadId.toLowerCase()]]);
  }

  async removeDownload(client: DownloadClient, downloadId: string, deleteFiles: boolean): Promise<void> {
    try {
      await delugeCall(client, "core.remove_torrent", [downloadId.toLowerCase(), deleteFiles]);
    } catch (err) {
      // Removing what is not there is done: qBittorrent and Transmission answer success for it too.
      if (/not in session/i.test((err as Error).message)) return;
      throw err;
    }
  }

  /**
   * Deluge has no tags, only the Label plugin's one label per torrent, so AoNarr's own torrents are the ones carrying its
   * category as a label. Without that plugin nothing can be told apart from the user's own torrents, and nothing is removed.
   * A torrent that finished and reached the goal (the ratio set on it at add, else the global ratio goal, or the global
   * seeding time) is removed from Deluge with its data kept: no mark says the library holds the same bytes.
   */
  async removeSeededTorrents(client: DownloadClient, ratioGoal: number | null, seedTimeGoalMinutes: number | null, skipIds?: Set<string>): Promise<number> {
    const plugins: string[] = (await delugeCall(client, "core.get_enabled_plugins")) ?? [];
    if (!plugins.includes("Label")) return 0;
    const labels = new Set(clientCategories(client).map((c) => c.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")));
    if (labels.size === 0) return 0;
    const torrents: Record<string, any> =
      (await delugeCall(client, "core.get_torrents_status", [{}, ["state", "progress", "ratio", "seeding_time", "label", "stop_at_ratio", "stop_ratio"]])) ?? {};
    let removed = 0;
    for (const [hash, t] of Object.entries(torrents)) {
      if (!labels.has(String(t.label ?? "").toLowerCase())) continue;
      // A torrent AoNarr still has a queue row for (not imported yet) is not its to remove.
      if (skipIds?.has(hash.toLowerCase())) continue;
      // Finished, and still seeding or stopped at its goal; a download in progress is never touched. A paused one is only
      // taken when Deluge itself paused it at the ratio set on it at add: a torrent parked by hand stays.
      const state = String(t.state);
      if (!((Number(t.progress) || 0) >= 100 && (state === "Seeding" || state === "Queued" || (state === "Paused" && t.stop_at_ratio)))) continue;
      const ratio = t.stop_at_ratio && Number(t.stop_ratio) > 0 ? Number(t.stop_ratio) : ratioGoal;
      const ratioMet = ratio !== null && Number(t.ratio) >= ratio;
      const timeMet = seedTimeGoalMinutes !== null && Number(t.seeding_time) / 60 >= seedTimeGoalMinutes;
      if (!ratioMet && !timeMet) continue;
      try {
        await delugeCall(client, "core.remove_torrent", [hash, false]);
        removed++;
      } catch (err) {
        // One that cannot be removed does not stop the rest.
        log.warn(`[downloadClient] Deluge torrent ${hash} was not removed:`, (err as Error).message);
      }
    }
    return removed;
  }
}

/** Connection tests for the clients above. */
export async function testNzbget(client: DownloadClient): Promise<void> {
  const version = await nzbgetRpc(client, "version");
  if (!version) throw new Error("Unexpected response — check host, port and URL base.");
  // `version` needs no login on some setups; `status` does.
  await nzbgetRpc(client, "status");
}

export async function testTransmission(client: DownloadClient): Promise<void> {
  await transmissionRpc(client, "session-get", { fields: ["version"] });
}

export async function testDeluge(client: DownloadClient): Promise<void> {
  DELUGE_COOKIES.delete(client.id);
  await delugeLogin(client);
}

const adapters: Record<DownloadClient["type"], DownloadClientAdapter> = {
  qbittorrent: new QBittorrentAdapter(),
  sabnzbd: new SabnzbdAdapter(),
  http: new HttpDownloadAdapter(),
  ytdlp: new YtdlpAdapter(),
  realdebrid: new RealDebridAdapter(),
  alldebrid: new AllDebridAdapter(),
  torbox: new TorBoxAdapter(),
  blackhole: new BlackholeAdapter(),
  slskd: new SlskdAdapter(),
  nzbget: new NzbgetAdapter(),
  transmission: new TransmissionAdapter(),
  deluge: new DelugeAdapter(),
};

export function getDownloadClientAdapter(type: DownloadClient["type"]): DownloadClientAdapter {
  return adapters[type];
}

/** Strips a trailing slash (either style) so a stored mapping of "/downloads/" and one of
 * "/downloads" behave identically, and comparisons below don't have to special-case it. */
function stripTrailingSlash(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

/**
 * Radarr/Sonarr-style remote path mapping: a download client that doesn't share AoNarr's exact
 * filesystem layout (different host, different container, an SMB/NFS share mounted at a different
 * point on each side) reports its own completed-download path in ITS OWN namespace — qBittorrent's
 * content_path/save_path, SABnzbd's history "storage" field (see QueueStatusUpdate.remotePath).
 * That path is useless to AoNarr as-is; this rewrites whichever configured remote_path prefix it
 * starts with to the matching local_path, so services/scheduler.ts's pollQueue can store a path
 * AoNarr can actually open. Case-insensitive prefix match and mixed-slash tolerant (a Windows
 * qBittorrent box reporting "C:\Downloads\..." against a mapping typed with forward slashes should
 * still match) since the two sides of a mapping are typically different operating systems.
 * Returns the input unchanged when no mapping applies — every existing single-host setup (the
 * overwhelming majority, where the client already writes straight into the shared downloadsDir)
 * keeps working exactly as before with zero mappings configured.
 */
export async function applyRemotePathMapping(downloadClientId: number, remotePath: string): Promise<string> {
  const mappings = (await db
    .prepare("SELECT remote_path, local_path FROM remote_path_mappings WHERE download_client_id = ?")
    .all(downloadClientId)) as { remote_path: string; local_path: string }[];
  if (mappings.length === 0) return remotePath;

  const normalizedRemote = stripTrailingSlash(remotePath).replace(/\\/g, "/").toLowerCase();
  // Longest prefix wins, so a more specific mapping (e.g. "/downloads/movies") takes priority over
  // a broader one covering the same root (e.g. "/downloads") when both are configured.
  let best: { remote_path: string; local_path: string } | null = null;
  for (const m of mappings) {
    const candidate = stripTrailingSlash(m.remote_path).replace(/\\/g, "/").toLowerCase();
    if (normalizedRemote === candidate || normalizedRemote.startsWith(candidate + "/")) {
      if (!best || candidate.length > stripTrailingSlash(best.remote_path).replace(/\\/g, "/").length) best = m;
    }
  }
  if (!best) return remotePath;

  const remotePrefixLen = stripTrailingSlash(best.remote_path).length;
  const suffix = remotePath.slice(remotePrefixLen).replace(/^[/\\]+/, "");
  const localBase = stripTrailingSlash(best.local_path);
  return suffix ? `${localBase}/${suffix.replace(/\\/g, "/")}` : localBase;
}

/**
 * Best-effort removal of a queue item's download at its originating client, once AoNarr is done
 * with it (imported, or failed and won't be retried from that task) — shared by the success path
 * (services/importer.ts) and the client-level-failure path (services/scheduler.ts) so both follow
 * the same "look up the client, check the adapter supports it, don't throw on failure" shape.
 * `deleteFiles` should be true whenever the client's own copy of the data is safe to lose — not
 * true for a torrent still expected to seed (the "hardlink"/"symlink" import strategies exist
 * specifically to keep that data around; callers pass deleteFiles accordingly).
 */
export async function removeQueueItemDownload(queueItem: Pick<QueueItem, "downloadClientId" | "downloadId" | "title">, deleteFiles: boolean): Promise<void> {
  if (!queueItem.downloadClientId || !queueItem.downloadId) return;
  try {
    const clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(queueItem.downloadClientId);
    if (!clientRow) return;
    const client = downloadClientFromRow(clientRow as any);
    const adapter = getDownloadClientAdapter(client.type);
    if (!adapter.removeDownload) return;
    await adapter.removeDownload(client, queueItem.downloadId, deleteFiles);
  } catch (err) {
    log.warn(`[downloadClient] failed to remove completed download for "${queueItem.title}" from its client:`, (err as Error).message);
  }
}

/** Marks a queue row's download as fully imported (see DownloadClientAdapter.markImported). Never throws. */
export async function markDownloadImported(queueItem: Pick<QueueItem, "downloadClientId" | "downloadId" | "title"> & { indexerId?: number | null }, dataSafe = true): Promise<void> {
  if (!queueItem.downloadClientId || !queueItem.downloadId) return;
  try {
    // The queue row goes with the import, but the torrent keeps seeding: the indexer's own seed goal is recorded on it.
    const indexer = queueItem.indexerId
      ? ((await db.prepare("SELECT seed_ratio, seed_time_minutes FROM indexers WHERE id = ?").get(queueItem.indexerId)) as
          | { seed_ratio: number | null; seed_time_minutes: number | null }
          | undefined)
      : undefined;
    const seedGoal: SeedGoal | null = indexer ? { ratio: indexer.seed_ratio == null ? null : Number(indexer.seed_ratio), minutes: indexer.seed_time_minutes == null ? null : Number(indexer.seed_time_minutes) } : null;
    const clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(queueItem.downloadClientId);
    if (!clientRow) return;
    const client = downloadClientFromRow(clientRow as any);
    const adapter = getDownloadClientAdapter(client.type);
    if (adapter.markImported) await adapter.markImported(client, queueItem.downloadId, seedGoal, dataSafe);
  } catch (err) {
    log.warn(`[downloadClient] couldn't mark "${queueItem.title}" as imported at its client:`, (err as Error).message);
  }
}

/** Each running import's queue row, with a promise that resolves (never rejects) once it settles. */
const queueImportsInFlight = new Map<number, Promise<void>>();

/**
 * Runs `importFn` as the only import of queue row `queueId` in flight, or returns false without
 * running it when another one already is. Two imports of the same row race on the same source files:
 * whichever finishes first deletes the row and the client's copy of the data while the other is
 * still copying from it. Taken by importQueueItem's callers, not by importQueueItem itself, and by
 * the Activity page's Remove, which deletes the client's copy too.
 */
export async function withQueueImportLock(queueId: number, importFn: () => Promise<void>): Promise<boolean> {
  if (queueImportsInFlight.has(queueId)) return false;
  let settle!: () => void;
  queueImportsInFlight.set(queueId, new Promise<void>((resolve) => (settle = resolve)));
  try {
    await importFn();
    return true;
  } finally {
    queueImportsInFlight.delete(queueId);
    settle();
  }
}

/** How often waitForQueueImports rechecks `moreMayStart` while nothing is importing. */
const MORE_IMPORTS_RECHECK_MS = 100;

/**
 * Waits for every import running under withQueueImportLock — including ones that start while it
 * waits — to settle, so shutdown and restore don't close the database under an import mid-copy.
 * While `moreMayStart` returns true it keeps waiting even with nothing importing: the queue poller
 * imports its completed rows one after another, and cancelling it doesn't stop a run already going.
 * Resolves true once none is left, false when `timeoutMs` passes first; never rejects.
 */
export async function waitForQueueImports(timeoutMs: number, moreMayStart: () => boolean = () => false): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const idle = queueImportsInFlight.size === 0;
    if (idle && !moreMayStart()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, idle ? Math.min(MORE_IMPORTS_RECHECK_MS, remaining) : remaining)));
    await (idle ? timeout : Promise.race([Promise.all(queueImportsInFlight.values()), timeout]));
    clearTimeout(timer);
  }
}

/** qBittorrent's `eta` (seconds; 8640000 means never) and `amount_left` (bytes) for a download in progress. */
export function qbitTimeAndSize(t: { eta?: unknown; amount_left?: unknown }): Pick<QueueStatusUpdate, "etaSeconds" | "sizeLeft"> {
  const eta = typeof t.eta === "number" && Number.isFinite(t.eta) && t.eta >= 0 && t.eta < 8_640_000 ? Math.round(t.eta) : null;
  const left = typeof t.amount_left === "number" && Number.isFinite(t.amount_left) && t.amount_left >= 0 ? Math.round(t.amount_left) : null;
  return { ...(eta != null ? { etaSeconds: eta } : {}), ...(left != null ? { sizeLeft: left } : {}) };
}

/** SABnzbd's `timeleft` ("0:10:30" or "1:02:03:04" with days) and `mbleft` (MiB, as text) for a queue slot. */
export function sabTimeAndSize(slot: { timeleft?: unknown; mbleft?: unknown }): Pick<QueueStatusUpdate, "etaSeconds" | "sizeLeft"> {
  let eta: number | null = null;
  if (typeof slot.timeleft === "string" && /^\d+(:\d{1,2}){1,3}$/.test(slot.timeleft)) {
    const parts = slot.timeleft.split(":").map(Number);
    eta = parts.reduce((total, part) => total * 60 + part, 0);
    // With a day part ("1:02:03:04") the first number is days, not hours.
    if (parts.length === 4) eta = (parts[0] * 24 + parts[1]) * 3600 + parts[2] * 60 + parts[3];
  }
  const mb = Number(slot.mbleft);
  const left = typeof slot.mbleft === "string" || typeof slot.mbleft === "number" ? (Number.isFinite(mb) && mb >= 0 ? Math.round(mb * 1048576) : null) : null;
  // SABnzbd reports 0:00:00 for a slot that is not moving (paused, queued): that is no estimate for data still to come.
  if (eta === 0 && left != null && left > 0) eta = null;
  return { ...(eta != null ? { etaSeconds: eta } : {}), ...(left != null ? { sizeLeft: left } : {}) };
}
