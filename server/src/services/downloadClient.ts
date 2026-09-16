import { log } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { downloadClientFromRow } from "../db/mappers.js";
import type { DownloadClient, QueueItem } from "../types/index.js";
import { decodeSlskdDownloadUrl } from "./soulseek.js";
import { getSetting } from "./settingsStore.js";

export interface GrabResult {
  downloadId: string;
}

export interface QueueStatusUpdate {
  downloadId: string;
  progress: number; // 0-1
  status: "downloading" | "completed" | "failed";
}

/** Common surface every download client backend implements. `releaseTitle` is only used by the
 * in-process adapters (http, ytdlp) that write the file into downloadsDir themselves — naming it
 * to match gives the importer's fuzzy-match a much better target than a raw URL basename would. */
export interface DownloadClientAdapter {
  addDownload(
    client: DownloadClient,
    downloadUrl: string,
    category: string | null,
    releaseTitle?: string
  ): Promise<GrabResult>;
  getStatus(client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]>;
  /** Not every backend has a real queue to reorder (the in-process http/ytdlp adapters download
   * sequentially with nothing to prioritize) — implementing this is optional; callers check for
   * its presence before offering the UI action. */
  setPriority?(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void>;
  /** Torrent-specific health: seed ratio, upload/download totals, ratio-limit config. Only
   * meaningful for backends that actually seed (qBittorrent) — usenet clients have no equivalent
   * concept, so this is optional and callers check for its presence. */
  getHealthStats?(client: DownloadClient): Promise<ClientHealthStats>;
  /** Radarr/Sonarr-style seed-goal cleanup: removes a torrent *from the client* (never the
   * already-imported library file — AoNarr moved/hardlinked/copied it out before this ever runs)
   * once it's met a configured ratio and/or seed-time goal, freeing the client's slot instead of
   * seeding forever unless the client's own ratio-limit settings happen to be configured
   * separately. Only meaningful for backends that actually seed. */
  removeSeededTorrents?(client: DownloadClient, ratioGoal: number | null, seedTimeGoalMinutes: number | null): Promise<number>;
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
    const res = await fetch(url, { redirect: "manual" });
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

function baseUrl(client: DownloadClient): string {
  const scheme = client.useSsl ? "https" : "http";
  return `${scheme}://${client.host}:${client.port}`;
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
      const res = await fetch(`${baseUrl(client)}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: client.username ?? "", password: client.password ?? "" }),
      });
      const text = await res.text();
      if (!res.ok || text.trim() === "Fails.") throw new Error("Login rejected — check host/port/username/password.");
      return;
    }
    case "sabnzbd": {
      const url = new URL(`${baseUrl(client)}/api`);
      url.searchParams.set("mode", "version");
      url.searchParams.set("apikey", client.apiKey ?? "");
      url.searchParams.set("output", "json");
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      if (body?.error) throw new Error(body.error);
      if (!body?.version) throw new Error("Unexpected response — check host/port/API key.");
      return;
    }
    case "realdebrid": {
      const res = await fetch("https://api.real-debrid.com/rest/1.0/user", {
        headers: { Authorization: `Bearer ${client.apiKey}` },
      });
      if (!res.ok) throw new Error(res.status === 401 ? "API token rejected." : `HTTP ${res.status}`);
      return;
    }
    case "alldebrid": {
      const url = new URL("https://api.alldebrid.com/v4/user");
      url.searchParams.set("agent", "aonarr");
      url.searchParams.set("apikey", client.apiKey ?? "");
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      if (body.status === "error") throw new Error(body.error?.message ?? "API key rejected.");
      return;
    }
    case "torbox": {
      const res = await fetch("https://api.torbox.app/v1/api/user/me", {
        headers: { Authorization: `Bearer ${client.apiKey}` },
      });
      if (!res.ok) throw new Error(res.status === 401 ? "API key rejected." : `HTTP ${res.status}`);
      const body: any = await res.json();
      if (body.success === false) throw new Error(body.detail ?? "API key rejected.");
      return;
    }
    case "slskd": {
      const res = await fetch(`${baseUrl(client)}/api/v0/transfers/downloads`, {
        headers: client.apiKey ? { "X-API-Key": client.apiKey } : {},
      });
      if (!res.ok) throw new Error(res.status === 401 ? "API key rejected." : `HTTP ${res.status}`);
      return;
    }
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

/** qBittorrent Web API (v4.1+) adapter. */
class QBittorrentAdapter implements DownloadClientAdapter {
  private cookieCache = new Map<number, string>();

  private async login(client: DownloadClient): Promise<string> {
    const cached = this.cookieCache.get(client.id);
    if (cached) return cached;

    const res = await fetch(`${baseUrl(client)}/api/v2/auth/login`, {
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

  async addDownload(client: DownloadClient, downloadUrl: string, category: string | null): Promise<GrabResult> {
    const cookie = await this.login(client);
    const form = new URLSearchParams({ urls: downloadUrl });
    if (category) form.set("category", category);

    const res = await fetch(`${baseUrl(client)}/api/v2/torrents/add`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: form,
    });
    if (!res.ok) throw new Error(`qBittorrent add failed: HTTP ${res.status}`);

    // qBittorrent doesn't return a hash on add; the caller tracks by downloadUrl until
    // the next queue poll resolves it against /torrents/info.
    return { downloadId: downloadUrl };
  }

  async getStatus(client: DownloadClient, _downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    const cookie = await this.login(client);
    const res = await fetch(`${baseUrl(client)}/api/v2/torrents/info`, {
      headers: { Cookie: cookie },
    });
    if (!res.ok) throw new Error(`qBittorrent status failed: HTTP ${res.status}`);
    const torrents = (await res.json()) as any[];

    return torrents.map((t) => ({
      downloadId: t.hash,
      progress: t.progress ?? 0,
      status: t.progress >= 1 ? "completed" : t.state === "error" ? "failed" : "downloading",
    }));
  }

  /** qBittorrent orders torrents by queue position; `topPrio`/`bottomPrio` move one to either end
   * (there's no direct "set numeric priority" call in the Web API). */
  async setPriority(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void> {
    const cookie = await this.login(client);
    const endpoint = priority === "top" ? "topPrio" : "bottomPrio";
    const res = await fetch(`${baseUrl(client)}/api/v2/torrents/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ hashes: downloadId }),
    });
    if (!res.ok) throw new Error(`qBittorrent ${endpoint} failed: HTTP ${res.status}`);
  }

  async getHealthStats(client: DownloadClient): Promise<ClientHealthStats> {
    const cookie = await this.login(client);

    const [transferRes, prefsRes, torrentsRes] = await Promise.all([
      fetch(`${baseUrl(client)}/api/v2/transfer/info`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl(client)}/api/v2/app/preferences`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl(client)}/api/v2/torrents/info`, { headers: { Cookie: cookie } }),
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

  async removeSeededTorrents(client: DownloadClient, ratioGoal: number | null, seedTimeGoalMinutes: number | null): Promise<number> {
    if (ratioGoal === null && seedTimeGoalMinutes === null) return 0;
    const cookie = await this.login(client);
    const res = await fetch(`${baseUrl(client)}/api/v2/torrents/info`, { headers: { Cookie: cookie } });
    if (!res.ok) throw new Error(`qBittorrent torrents/info failed: HTTP ${res.status}`);
    const torrents = (await res.json()) as any[];

    // Only a torrent that's actually finished downloading and seeding (never one still fetching,
    // "uploading"/"stalledUP"/"queuedUP"/"pausedUP" states) is eligible — same reasoning as
    // qBittorrent's own state machine, so this can't accidentally remove an in-progress download.
    const seedingStates = new Set(["uploading", "stalledUP", "queuedUP", "pausedUP", "forcedUP"]);
    const eligible = torrents.filter((t) => {
      if (!seedingStates.has(t.state)) return false;
      const ratioMet = ratioGoal !== null && (t.ratio ?? 0) >= ratioGoal;
      const timeMet = seedTimeGoalMinutes !== null && (t.seeding_time ?? 0) / 60 >= seedTimeGoalMinutes;
      return ratioMet || timeMet;
    });
    if (eligible.length === 0) return 0;

    const removeRes = await fetch(`${baseUrl(client)}/api/v2/torrents/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ hashes: eligible.map((t) => t.hash).join("|"), deleteFiles: "false" }),
    });
    if (!removeRes.ok) throw new Error(`qBittorrent torrents/delete failed: HTTP ${removeRes.status}`);
    return eligible.length;
  }

  async removeDownload(client: DownloadClient, downloadId: string, deleteFiles: boolean): Promise<void> {
    const cookie = await this.login(client);
    const res = await fetch(`${baseUrl(client)}/api/v2/torrents/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ hashes: downloadId, deleteFiles: deleteFiles ? "true" : "false" }),
    });
    if (!res.ok) throw new Error(`qBittorrent torrents/delete failed: HTTP ${res.status}`);
  }
}

/** SABnzbd adapter. */
class SabnzbdAdapter implements DownloadClientAdapter {
  async addDownload(client: DownloadClient, downloadUrl: string, category: string | null): Promise<GrabResult> {
    const url = new URL(`${baseUrl(client)}/api`);
    url.searchParams.set("mode", "addurl");
    url.searchParams.set("name", downloadUrl);
    url.searchParams.set("apikey", client.apiKey ?? "");
    url.searchParams.set("output", "json");
    if (category) url.searchParams.set("cat", category);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`SABnzbd add failed: HTTP ${res.status}`);
    const body: any = await res.json();
    const downloadId = body?.nzo_ids?.[0] ?? downloadUrl;
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
    const queueRes = await fetch(queueUrl.toString());
    if (!queueRes.ok) throw new Error(`SABnzbd status failed: HTTP ${queueRes.status}`);
    const queueBody: any = await queueRes.json();
    const slots: any[] = queueBody?.queue?.slots ?? [];

    const updates: QueueStatusUpdate[] = [];
    const inQueueIds = new Set<string>();
    for (const s of slots) {
      inQueueIds.add(s.nzo_id);
      updates.push({
        downloadId: s.nzo_id,
        progress: s.percentage ? Number(s.percentage) / 100 : 0,
        status: s.status === "Failed" ? "failed" : "downloading",
      });
    }

    const missingIds = downloadIds.filter((id) => !inQueueIds.has(id));
    if (missingIds.length > 0) {
      const historyUrl = new URL(`${baseUrl(client)}/api`);
      historyUrl.searchParams.set("mode", "history");
      historyUrl.searchParams.set("apikey", client.apiKey ?? "");
      historyUrl.searchParams.set("output", "json");
      historyUrl.searchParams.set("nzo_ids", missingIds.join(","));
      const historyRes = await fetch(historyUrl.toString());
      if (historyRes.ok) {
        const historyBody: any = await historyRes.json();
        const historySlots: any[] = historyBody?.history?.slots ?? [];
        for (const h of historySlots) {
          updates.push({
            downloadId: h.nzo_id,
            progress: 1,
            status: h.status === "Failed" ? "failed" : "completed",
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
    const res = await fetch(url.toString());
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
        if (mode === "history") url.searchParams.set("del_files", deleteFiles ? "1" : "0");
        url.searchParams.set("apikey", client.apiKey ?? "");
        url.searchParams.set("output", "json");
        const res = await fetch(url.toString());
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
    const downloadId = crypto.randomUUID();
    this.jobs.set(downloadId, { progress: 0, status: "downloading" });

    (async () => {
      try {
        const res = await fetch(downloadUrl);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const ext = path.extname(new URL(downloadUrl).pathname) || ".bin";
        const filename = sanitizeFilename(releaseTitle || path.basename(new URL(downloadUrl).pathname) || downloadId) + ext;
        fs.mkdirSync(config.downloadsDir, { recursive: true });
        const dest = path.join(config.downloadsDir, filename);

        const total = Number(res.headers.get("content-length") ?? 0);
        let received = 0;
        const fileStream = fs.createWriteStream(dest);
        for await (const chunk of res.body as any) {
          fileStream.write(chunk);
          received += chunk.length;
          if (total > 0) this.jobs.set(downloadId, { progress: Math.min(received / total, 0.99), status: "downloading" });
        }
        await new Promise<void>((resolve, reject) => fileStream.end((err: any) => (err ? reject(err) : resolve())));
        this.jobs.set(downloadId, { progress: 1, status: "completed" });
      } catch (err) {
        log.warn(`[http-download] failed for "${releaseTitle ?? downloadUrl}":`, (err as Error).message);
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      }
    })();

    return { downloadId };
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return downloadIds
      .filter((id) => this.jobs.has(id))
      .map((id) => ({ downloadId: id, ...this.jobs.get(id)! }));
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

    const outputTemplate = path.join(config.downloadsDir, `${sanitizeFilename(releaseTitle || downloadId)}.%(ext)s`);
    // Audio-only mode (e.g. ripping a music video / live set) extracts and transcodes to mp3
    // instead of saving the source video container — yt-dlp's own -x/--audio-format flags.
    const args = client.audioOnly
      ? ["-x", "--audio-format", "mp3", "-o", outputTemplate, "--newline", downloadUrl]
      : ["-o", outputTemplate, "--newline", downloadUrl];

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
    proc.stdout.on("data", (chunk: Buffer) => {
      const match = chunk.toString().match(/(\d+(?:\.\d+)?)%/);
      if (match) this.jobs.set(downloadId, { progress: Math.min(Number(match[1]) / 100, 0.99), status: "downloading" });
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    proc.on("error", (err) => {
      log.warn(`[ytdlp] failed to start for "${releaseTitle ?? downloadUrl}":`, err.message);
      this.jobs.set(downloadId, { progress: 0, status: "failed" });
    });
    proc.on("exit", (code) => {
      if (code === 0) {
        this.jobs.set(downloadId, { progress: 1, status: "completed" });
      } else {
        log.warn(`[ytdlp] failed for "${releaseTitle ?? downloadUrl}" (exit ${code}):`, stderrTail.trim().split("\n").pop());
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      }
    });

    return { downloadId };
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return downloadIds
      .filter((id) => this.jobs.has(id))
      .map((id) => ({ downloadId: id, ...this.jobs.get(id)! }));
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
      try {
        const torrentId = await this.addToRealDebrid(client, downloadUrl);
        await fetch(`${this.base}/torrents/selectFiles/${torrentId}`, {
          method: "POST",
          headers: { ...this.headers(client), "Content-Type": "application/x-www-form-urlencoded" },
          body: "files=all",
        });

        // Poll RD's own caching/download progress until it's fully fetched on their end.
        let links: string[] = [];
        for (;;) {
          const res = await fetch(`${this.base}/torrents/info/${torrentId}`, { headers: this.headers(client) });
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

        fs.mkdirSync(config.downloadsDir, { recursive: true });
        for (const link of links) {
          const unrestrictRes = await fetch(`${this.base}/unrestrict/link`, {
            method: "POST",
            headers: { ...this.headers(client), "Content-Type": "application/x-www-form-urlencoded" },
            body: `link=${encodeURIComponent(link)}`,
          });
          if (!unrestrictRes.ok) throw new Error(`Real-Debrid unrestrict failed: HTTP ${unrestrictRes.status}`);
          const unrestricted: any = await unrestrictRes.json();

          const fileRes = await fetch(unrestricted.download);
          if (!fileRes.ok || !fileRes.body) throw new Error(`Downloading unrestricted link failed: HTTP ${fileRes.status}`);
          const filename = sanitizeFilename(unrestricted.filename || releaseTitle || downloadId);
          const dest = path.join(config.downloadsDir, filename);
          const fileStream = fs.createWriteStream(dest);
          for await (const chunk of fileRes.body as any) fileStream.write(chunk);
          await new Promise<void>((resolve, reject) => fileStream.end((err: any) => (err ? reject(err) : resolve())));
        }

        this.jobs.set(downloadId, { progress: 1, status: "completed" });
      } catch (err) {
        log.warn(`[real-debrid] failed for "${releaseTitle ?? downloadUrl}":`, (err as Error).message);
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
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
      const res = await fetch(`${this.base}/torrents/addMagnet`, {
        method: "POST",
        headers: { ...this.headers(client), "Content-Type": "application/x-www-form-urlencoded" },
        body: `magnet=${encodeURIComponent(source.uri)}`,
      });
      if (!res.ok) throw new Error(`Real-Debrid addMagnet failed: HTTP ${res.status}`);
      const body: any = await res.json();
      return body.id;
    }

    const addRes = await fetch(`${this.base}/torrents/addTorrent`, {
      method: "PUT",
      headers: this.headers(client),
      body: source.bytes,
    });
    if (!addRes.ok) throw new Error(`Real-Debrid addTorrent failed: HTTP ${addRes.status}`);
    const addBody: any = await addRes.json();
    return addBody.id;
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return downloadIds
      .filter((id) => this.jobs.has(id))
      .map((id) => ({ downloadId: id, ...this.jobs.get(id)! }));
  }
}

/**
 * TorBox — the same "debrid" torrent-caching shape as Real-Debrid/AllDebrid, just a different
 * provider (and one that also caches Usenet, though only the torrent side is wired up here, same
 * scope as the RD/AD adapters). client.apiKey holds the TorBox API key (Settings on torbox.app);
 * no host/port, always their public API. Every response is wrapped as `{ success, detail, data }`;
 * `success: false` (or a torrent-level error/dead state) is treated as a failure the same way RD's
 * `status === "error"` is.
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
    releaseTitle?: string
  ): Promise<GrabResult> {
    const downloadId = crypto.randomUUID();
    this.jobs.set(downloadId, { progress: 0, status: "downloading" });

    (async () => {
      try {
        const torrentId = await this.addToTorBox(client, downloadUrl);

        // Poll TorBox's own caching/download progress until the files are actually present on
        // their end. `progress` has been observed both as a 0-1 fraction and a 0-100 percentage
        // depending on state, so it's normalized defensively rather than assumed either way.
        let files: { id: number; name?: string }[] = [];
        for (;;) {
          const res = await fetch(`${this.base}/torrents/mylist?id=${torrentId}&bypass_cache=true`, { headers: this.headers(client) });
          if (!res.ok) throw new Error(`TorBox status check failed: HTTP ${res.status}`);
          const body: any = await res.json();
          if (body.success === false) throw new Error(`TorBox reported: ${body.detail ?? "unknown error"}`);
          const info: any = Array.isArray(body.data) ? body.data[0] : body.data;
          if (!info) throw new Error("TorBox reported no torrent info");
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

        fs.mkdirSync(config.downloadsDir, { recursive: true });
        for (const file of files) {
          const dlRes = await fetch(
            `${this.base}/torrents/requestdl?token=${encodeURIComponent(client.apiKey ?? "")}&torrent_id=${torrentId}&file_id=${file.id}`
          );
          if (!dlRes.ok) throw new Error(`TorBox requestdl failed: HTTP ${dlRes.status}`);
          const dlBody: any = await dlRes.json();
          const downloadLink = dlBody.data;
          if (!downloadLink) throw new Error("TorBox requestdl returned no link");

          const fileRes = await fetch(downloadLink);
          if (!fileRes.ok || !fileRes.body) throw new Error(`Downloading TorBox link failed: HTTP ${fileRes.status}`);
          const filename = sanitizeFilename(file.name || releaseTitle || downloadId);
          const dest = path.join(config.downloadsDir, filename);
          const fileStream = fs.createWriteStream(dest);
          for await (const chunk of fileRes.body as any) fileStream.write(chunk);
          await new Promise<void>((resolve, reject) => fileStream.end((err: any) => (err ? reject(err) : resolve())));
        }

        this.jobs.set(downloadId, { progress: 1, status: "completed" });
      } catch (err) {
        log.warn(`[torbox] failed for "${releaseTitle ?? downloadUrl}":`, (err as Error).message);
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
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

    const res = await fetch(`${this.base}/torrents/createtorrent`, {
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

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return downloadIds
      .filter((id) => this.jobs.has(id))
      .map((id) => ({ downloadId: id, ...this.jobs.get(id)! }));
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
    const res = await fetch(url.toString());
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
    const res = await fetch(url.toString(), {
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
    const res = await fetch(url.toString(), { method: "POST", body: form });
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
        for (;;) {
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

        fs.mkdirSync(config.downloadsDir, { recursive: true });
        for (const { link, filename: remoteFilename } of links) {
          const unlockData = await this.call(client, "/link/unlock", { link });
          const directLink = unlockData?.link;
          if (!directLink) throw new Error("AllDebrid link/unlock returned no direct link");

          const fileRes = await fetch(directLink);
          if (!fileRes.ok || !fileRes.body) throw new Error(`Downloading unlocked link failed: HTTP ${fileRes.status}`);
          const filename = sanitizeFilename(unlockData.filename || remoteFilename || releaseTitle || downloadId);
          const dest = path.join(config.downloadsDir, filename);
          const fileStream = fs.createWriteStream(dest);
          for await (const chunk of fileRes.body as any) fileStream.write(chunk);
          await new Promise<void>((resolve, reject) => fileStream.end((err: any) => (err ? reject(err) : resolve())));
        }

        this.jobs.set(downloadId, { progress: 1, status: "completed" });
      } catch (err) {
        log.warn(`[alldebrid] failed for "${releaseTitle ?? downloadUrl}":`, (err as Error).message);
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      }
    })();

    return { downloadId };
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return downloadIds
      .filter((id) => this.jobs.has(id))
      .map((id) => ({ downloadId: id, ...this.jobs.get(id)! }));
  }
}

/**
 * Blackhole — the oldest, most universal *Starr integration pattern, for a torrent/usenet client
 * with no usable HTTP API (or one AoNarr just hasn't written an adapter for yet): instead of
 * talking to the client at all, AoNarr drops the release into a folder the client is separately
 * configured to watch (`client.host` holds that folder's path, reusing the field the same way
 * Real-Debrid reuses `apiKey` for its token). A magnet link is written as a `.magnet` file
 * (content is just the URI — most watch-folder setups that support magnets at all expect this);
 * anything else is fetched and sniffed by content (XML → `.nzb`, otherwise `.torrent`) since the
 * shared adapter interface doesn't carry the result's protocol through to here.
 *
 * This is fire-and-forget by design, same as the real thing: AoNarr has no way to ask an unknown
 * external client how a download is progressing, so getStatus can't report real progress or ever
 * return "completed" — the queue entry just stays "downloading" until removed by hand. Point the
 * client's own completed-download output at one of AoNarr's root folders to actually get files
 * into the library; this only handles getting the release TO the client.
 */
class BlackholeAdapter implements DownloadClientAdapter {
  async addDownload(client: DownloadClient, downloadUrl: string, _category: string | null, releaseTitle?: string): Promise<GrabResult> {
    if (!client.host) throw new Error("Blackhole client has no watch folder path configured");
    fs.mkdirSync(client.host, { recursive: true });
    const downloadId = crypto.randomUUID();
    const base = sanitizeFilename(releaseTitle || downloadId);

    if (downloadUrl.startsWith("magnet:")) {
      fs.writeFileSync(path.join(client.host, `${base}.magnet`), downloadUrl, "utf-8");
    } else {
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`Failed to fetch release file for blackhole: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const looksLikeNzb = buf.subarray(0, 20).toString("utf-8").trimStart().startsWith("<");
      fs.writeFileSync(path.join(client.host, `${base}${looksLikeNzb ? ".nzb" : ".torrent"}`), buf);
    }

    return { downloadId };
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return downloadIds.map((id) => ({ downloadId: id, progress: 0, status: "downloading" }));
  }
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
class SlskdAdapter implements DownloadClientAdapter {
  private baseUrl(client: DownloadClient): string {
    const scheme = client.useSsl ? "https" : "http";
    return `${scheme}://${client.host}:${client.port}`;
  }

  private headers(client: DownloadClient): Record<string, string> {
    return client.apiKey ? { "X-API-Key": client.apiKey } : {};
  }

  async addDownload(client: DownloadClient, downloadUrl: string): Promise<GrabResult> {
    const { username, filename, size } = decodeSlskdDownloadUrl(downloadUrl);
    const res = await fetch(`${this.baseUrl(client)}/api/v0/transfers/downloads/${encodeURIComponent(username)}`, {
      method: "POST",
      headers: { ...this.headers(client), "Content-Type": "application/json" },
      body: JSON.stringify([{ filename, size }]),
    });
    if (!res.ok) throw new Error(`slskd enqueue failed: HTTP ${res.status}`);
    // slskd tracks transfers by (username, filename), not a generated id — encode both into the
    // downloadId so getStatus can look this specific transfer back up later.
    return { downloadId: `${username} ${filename}` };
  }

  async getStatus(client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    const wanted = new Set(downloadIds);
    const res = await fetch(`${this.baseUrl(client)}/api/v0/transfers/downloads`, { headers: this.headers(client) });
    if (!res.ok) throw new Error(`slskd status failed: HTTP ${res.status}`);
    const users = (await res.json()) as { username: string; directories?: { files?: any[] }[] }[];

    const updates: QueueStatusUpdate[] = [];
    for (const u of users) {
      for (const dir of u.directories ?? []) {
        for (const f of dir.files ?? []) {
          const downloadId = `${u.username} ${f.filename}`;
          if (!wanted.has(downloadId)) continue;
          const state = String(f.state ?? "");
          const status = state.includes("Succeeded") ? "completed" : state.includes("Errored") || state.includes("Cancelled") ? "failed" : "downloading";
          const progress = f.size > 0 ? Math.min((f.bytesTransferred ?? 0) / f.size, 1) : 0;
          updates.push({ downloadId, progress, status });
        }
      }
    }
    return updates;
  }
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
};

export function getDownloadClientAdapter(type: DownloadClient["type"]): DownloadClientAdapter {
  return adapters[type];
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
