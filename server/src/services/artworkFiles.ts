import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { log } from "./logger.js";
import { writeFileAtomic } from "./atomicWrite.js";
import { isLocalAddress, v6ToBigInt } from "./networkAddress.js";
import { fetchMediaServerArtwork, isMediaServerArtworkRef } from "./mediaServer.js";
import { fetchScreenscraperArtwork, isScreenscraperArtworkRef } from "./metadata.js";

/**
 * Artwork files beside the media, in the names Kodi, Emby, Jellyfin and Plex read (poster.jpg, fanart.jpg,
 * season01-poster.jpg, "<episode>-thumb.jpg", folder.jpg ...). One image at a time: the bytes are fetched and checked in
 * memory first, then written under a temporary name and renamed into place, so a download that dies, a page that is not
 * an image or a disk that fills up leaves nothing half-written for a media server to pick up.
 */

/** Larger than any poster or still a provider serves; a body past this is not artwork. */
export const ARTWORK_MAX_BYTES = 15 * 1024 * 1024;
export const ARTWORK_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

export interface ArtworkSource {
  /** An image AoNarr already holds (a local poster beside a sidecar, a media server's or ScreenScraper's reference): used before the URL. */
  localPath?: string | null;
  url?: string | null;
}

export type ArtworkOutcome = "written" | "exists" | "none" | "failed";

export interface ArtworkResult {
  outcome: ArtworkOutcome;
  /** The file that was written, or the one that was already there. */
  file?: string;
  reason?: string;
}

type ImageKind = "jpg" | "png" | "webp" | "gif";

/** The image format the bytes are, from their first bytes; null for anything else (HTML error pages, JSON, text). */
export function sniffImage(bytes: Buffer): ImageKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "gif";
  return null;
}

/** TMDB serves posters at 342 pixels wide in the lists AoNarr stores; the full-size image is the one a media server wants. */
function sizedUrls(url: string): string[] {
  const full = url.replace(/^(https:\/\/image\.tmdb\.org\/t\/p\/)w\d+\//, "$1original/");
  return full === url ? [url] : [full, url];
}

/** IPv4 ranges RFC 6890 sets aside (private, shared, loopback, link-local, documentation, benchmarking, multicast, reserved): never a picture host. */
const SPECIAL_USE_V4: readonly (readonly [base: string, bits: number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4Number(address: string): number {
  return address.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

function specialUseV4(n: number): boolean {
  return SPECIAL_USE_V4.some(([base, bits]) => n >>> (32 - bits) === v4Number(base) >>> (32 - bits));
}

const NAT64_WELL_KNOWN = (v6ToBigInt("64:ff9b::") as bigint) >> 32n;
const NAT64_LOCAL_USE = (v6ToBigInt("64:ff9b:1::") as bigint) >> 80n;

/** An IPv6 address that is itself special-use, or carries a special-use IPv4 address (mapped, NAT64, 6to4). */
function specialUseV6(address: bigint): boolean {
  if (address >> 32n === 0n) return true; // ::/96: unspecified, loopback and the deprecated IPv4-compatible form
  if (address >> 32n === 0xffffn) return specialUseV4(Number(address & 0xffffffffn)); // ::ffff:a.b.c.d
  if (address >> 32n === NAT64_WELL_KNOWN) return specialUseV4(Number(address & 0xffffffffn)); // 64:ff9b::a.b.c.d
  if (address >> 80n === NAT64_LOCAL_USE) return true; // 64:ff9b:1::/48, local use only
  if (address >> 112n === 0x2002n) return specialUseV4(Number((address >> 80n) & 0xffffffffn)); // 6to4: the IPv4 address follows 2002:
  if (address >> 64n === 0x0100000000000000n) return true; // 100::/64, discard only
  if (address >> 96n === 0x20010db8n) return true; // documentation
  if (address >> 118n === 0x3fbn) return true; // fec0::/10, site-local
  return address >> 120n === 0xffn; // multicast
}

/**
 * Whether `hostname` is an address (or a name) a picture is never fetched from: what isLocalAddress knows, plus the other special-use
 * ranges, so `192.0.0.192`, `198.18.0.1`, a NAT64 `64:ff9b::7f00:1` or a 6to4 `2002:7f00:1::` do not reach a LAN host that way.
 * Only the text is judged, as everywhere else in the app (isLocalAddress is left as it is: it also routes the proxy and decides the
 * certificate rules): a public name whose DNS record points at a private address, such as `127.0.0.1.nip.io`, is not caught.
 */
export function isNonPublicHost(hostname: string): boolean {
  if (isLocalAddress(hostname)) return true;
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (net.isIPv4(host)) return specialUseV4(v4Number(host));
  const v6 = net.isIPv6(host) ? v6ToBigInt(host) : null;
  return v6 != null && specialUseV6(v6);
}

/** Why a URL is not fetched for artwork, or null. A stored URL can be set by hand, and this server is the one that asks for it. */
function urlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `a ${url.protocol} URL`;
  if (url.username || url.password) return "a URL with credentials in it";
  if (isNonPublicHost(url.hostname)) return "a URL on a local address";
  return null;
}

function bytesTooLarge(): Error {
  return new Error(`larger than ${Math.round(ARTWORK_MAX_BYTES / 1024 / 1024)} MB`);
}

/** The whole body, read up to the cap; the rest of an oversized one is never downloaded. */
async function readCapped(res: Response, controller: AbortController): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ARTWORK_MAX_BYTES) {
    controller.abort();
    throw bytesTooLarge();
  }
  if (!res.body) {
    const all = Buffer.from(await res.arrayBuffer());
    if (all.length > ARTWORK_MAX_BYTES) throw bytesTooLarge();
    return all;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > ARTWORK_MAX_BYTES) {
      controller.abort();
      await reader.cancel().catch(() => {});
      throw bytesTooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fetchImageBytes(startUrl: string, signal: AbortSignal | undefined): Promise<Buffer> {
  // A plain timer and a manual relay of the caller's abort: AbortSignal.any() with a timeout inside drops the deadline on Node 20.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`no answer in ${ARTWORK_TIMEOUT_MS / 1000}s`)), ARTWORK_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const problem = urlProblem(url);
      if (problem) throw new Error(`refused: ${problem}`);
      // Redirects are followed by hand so that each hop is checked like the first.
      const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        url = new URL(res.headers.get("location") as string, url).href;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!type.startsWith("image/")) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`not an image (${type || "no content type"})`);
      }
      const bytes = await readCapped(res, controller);
      if (!sniffImage(bytes)) throw new Error("the body is not a picture");
      return bytes;
    }
    throw new Error("too many redirects");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readLocalBytes(localPath: string, signal: AbortSignal | undefined): Promise<Buffer | null> {
  if (isMediaServerArtworkRef(localPath) || isScreenscraperArtworkRef(localPath)) {
    const res = await (isMediaServerArtworkRef(localPath) ? fetchMediaServerArtwork(localPath) : fetchScreenscraperArtwork(localPath));
    if (!res) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > ARTWORK_MAX_BYTES) throw bytesTooLarge();
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > ARTWORK_MAX_BYTES) throw bytesTooLarge();
    return sniffImage(bytes) ? bytes : null;
  }
  if (signal?.aborted) return null;
  try {
    const stat = await fsp.stat(localPath);
    if (!stat.isFile()) return null;
    if (stat.size > ARTWORK_MAX_BYTES) throw bytesTooLarge();
    const bytes = await fsp.readFile(localPath);
    return sniffImage(bytes) ? bytes : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The picture for a source: an image already held locally first, then the URL (the full-size one when the provider has
 * it). Null when the source names nothing; throws with the reason when something was named and could not be used.
 */
export async function loadArtwork(source: ArtworkSource, signal?: AbortSignal): Promise<{ bytes: Buffer; kind: ImageKind } | null> {
  let lastError: Error | null = null;
  if (source.localPath) {
    try {
      const bytes = await readLocalBytes(source.localPath, signal);
      if (bytes) return { bytes, kind: sniffImage(bytes) as ImageKind };
    } catch (err) {
      lastError = err as Error;
    }
  }
  // The local-artwork route of AoNarr itself is not a place to fetch from.
  if (source.url && /^https?:\/\//i.test(source.url)) {
    for (const url of sizedUrls(source.url)) {
      try {
        const bytes = await fetchImageBytes(url, signal);
        return { bytes, kind: sniffImage(bytes) as ImageKind };
      } catch (err) {
        lastError = err as Error;
        if (signal?.aborted) break;
      }
    }
  }
  if (lastError) throw lastError;
  return null;
}

const EXTENSIONS: Record<ImageKind, string> = { jpg: ".jpg", png: ".png", webp: ".webp", gif: ".gif" };
const EXISTING_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".tbn"];

/** The file already there under one of these names (any usual extension), or null. */
export function existingArtwork(dir: string, stems: string[]): string | null {
  for (const stem of stems) {
    for (const ext of EXISTING_EXTENSIONS) {
      const candidate = path.join(dir, `${stem}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not there
      }
    }
  }
  return null;
}

/** Writes at one place at a time, so two imports of one show do not both fetch and rename the same poster. */
const inFlight = new Map<string, Promise<ArtworkResult>>();

export interface WriteArtworkOptions {
  overwrite: boolean;
  signal?: AbortSignal;
  /** Other names that already satisfy this file (folder.jpg for poster.jpg), so a picture the admin put there is not duplicated. */
  alsoCountsAs?: string[];
}

/**
 * Writes the artwork `source` names as `<dir>/<stem>.<ext>` (the extension is the picture's own). Never overwrites a file
 * that is there unless `overwrite` is on, and never throws: a failure is the result's outcome, so one bad image cannot
 * stop the rest.
 */
export async function writeArtworkFile(dir: string, stem: string, source: ArtworkSource, options: WriteArtworkOptions): Promise<ArtworkResult> {
  const key = path.resolve(dir, stem).toLowerCase();
  const running = inFlight.get(key);
  if (running) return running;
  const work = writeArtworkOnce(dir, stem, source, options).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

async function writeArtworkOnce(dir: string, stem: string, source: ArtworkSource, options: WriteArtworkOptions): Promise<ArtworkResult> {
  try {
    const there = existingArtwork(dir, [stem, ...(options.alsoCountsAs ?? [])]);
    if (there && !options.overwrite) return { outcome: "exists", file: there };
    if (!source.localPath && !source.url) return { outcome: "none" };
    const loaded = await loadArtwork(source, options.signal);
    if (!loaded) return { outcome: "none" };
    const dest = path.join(dir, `${stem}${EXTENSIONS[loaded.kind]}`);
    // Replacing a picture with itself (the local poster IS this file) is not a write.
    if (there && path.resolve(there) === path.resolve(dest) && source.localPath && path.resolve(source.localPath) === path.resolve(dest)) {
      return { outcome: "exists", file: there };
    }
    await writeFileAtomic(dest, loaded.bytes);
    // A picture replaced under another extension (poster.png over poster.jpg) must not leave the old one for Kodi to find first.
    for (const ext of EXISTING_EXTENSIONS) {
      const stale = path.join(dir, `${stem}${ext}`);
      if (path.resolve(stale) !== path.resolve(dest)) await fsp.rm(stale, { force: true }).catch(() => {});
    }
    return { outcome: "written", file: dest };
  } catch (err) {
    const reason = (err as Error).message;
    log.warn(`[artwork] ${stem} in "${dir}" was not written: ${reason}`);
    return { outcome: "failed", reason };
  }
}
