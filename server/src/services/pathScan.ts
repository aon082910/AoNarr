import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { log } from "./logger.js";
import { getSetting } from "./settingsStore.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { parseReleaseTitle, type ParsedRelease } from "./releaseParser.js";
import { aliasTitlesByItem, resolveReleaseItemInLibrary } from "./releaseAliases.js";
import { identityKey } from "./releaseIdentity.js";
import { sceneIndexFor } from "./sceneNumbering.js";
import { ImportSkippedError, SEEDING_CLIENT_TYPES, autoStrategyFor, placeAlbumFiles, placeFile, withImportStrategy } from "./importer.js";
import { getQualityProfile } from "./scheduler.js";
import { matchCollectionRelease, releaseNamesEpisode } from "./rssSync.js";
import { groupedRank, rankingOf } from "./quality.js";
import { redactLinks } from "./linkRedaction.js";
import type { MediaItem, SearchResult } from "../types/index.js";

/**
 * The scan of a folder or a file somebody hands to AoNarr (Starr's `DownloadedEpisodesScan`, `DownloadedMoviesScan`,
 * `DownloadedAlbumsScan` and `DownloadedBooksScan` commands with a `path`): the media found in it is matched to the titles of
 * the library by its name, as a release is, and what matches is imported with the title's quality profile and naming rules
 * (placeFile and placeAlbumFiles, the code behind the manual import). Nothing else is touched: a file that matches nothing,
 * is not an upgrade of the one the library has, or belongs to a download the queue is still tracking stays exactly where it is.
 *
 * A command may name any path, and the import moves files, so a path is only taken inside a place a download can be in:
 *  - the downloads folder of AoNarr, or the local side of the remote path mapping the path itself goes through (where that
 *    download client's folder is seen; a mapping is no place for a path that does not use it);
 *  - or a folder of the `scanPathAllowList` setting (comma-separated absolute folders; empty by default).
 * It must exist, be absolute, hold no `..`, and not be inside (or be) a library root folder. Symbolic links are resolved
 * with realpath before any of this is judged, and a link inside a scanned folder is never followed.
 *
 * A scan that names no mode (or Auto) over the downloads folder or a torrent client's folder hardlinks (a copy where a link
 * cannot be made) rather than follow the "move" import strategy: a torrent that is still seeding has no queue row, and moving
 * its files would stop it seeding. An explicit Move is the caller's call.
 */

/** The scan was refused, and why; the Starr layer answers it as a validation failure on `propertyName`. */
export class ScanRefused extends Error {
  constructor(
    message: string,
    readonly propertyName = "Path"
  ) {
    super(message);
  }
}

export type ScanOutcome = "imported" | "skipped" | "unmatched" | "tracked" | "failed";

export interface ScannedFile {
  /** Relative to the scanned folder (the file's name for a single file). */
  file: string;
  outcome: ScanOutcome;
  reason?: string;
  mediaItemId?: number;
}

export interface ScanSummary {
  found: number;
  imported: number;
  skipped: number;
  unmatched: number;
  tracked: number;
  failed: number;
  /** Some of the folder was not looked at: it holds more files than a scan takes, or folders deeper than MAX_DEPTH. */
  truncated: boolean;
  /** Folders deeper than 6 levels hold media that was not looked at. */
  tooDeep: boolean;
  files: ScannedFile[];
  message: string;
}

/** What bounds a scan (an object so the tests can shrink it). */
export const scanLimits = {
  /** Files a scan imports in one go; a file the library already has (or a profile refuses) does not count, so a rerun goes on from where the last one stopped. */
  maxFiles: 5000,
  /** Files looked at in all, counted or not: the walk stops here. */
  maxLookedAt: 25_000,
  /** Files judged together (whole folders, so an album is never split between two). */
  chunkSize: 500,
};
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 6;

// --- where a scan may look ----------------------------------------------------------------------------------------------

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  // A folder named "..x" is inside; only ".." itself and "../something" are outside.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

/** The folders given in the `scanPathAllowList` setting: absolute ones only, split on commas, semicolons and line breaks. */
export function allowListEntries(): string[] {
  return (getSetting("scanPathAllowList") ?? "")
    .split(/[,;\r\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && path.isAbsolute(entry));
}

const normalizedRemote = (p: string) => p.replace(/[/\\]+$/, "").replace(/\\/g, "/").toLowerCase();

/** The mapping a path went through. */
interface UsedMapping {
  download_client_id: number;
  remote_path: string;
  local_path: string;
}

/**
 * The path as this server sees it: a remote path mapping rewrites a path in a download client's namespace to the local one.
 * `via` is the mapping that did it (null when none applied), the only mapping whose local folder this path may use as its base.
 */
async function mapToLocal(raw: string, clientId: number | null): Promise<{ local: string; via: UsedMapping | null }> {
  const mappings = (await db
    .prepare(`SELECT download_client_id, remote_path, local_path FROM remote_path_mappings${clientId != null ? " WHERE download_client_id = ?" : ""} ORDER BY download_client_id, id`)
    .all(...(clientId != null ? [clientId] : []))) as UsedMapping[];
  const wanted = normalizedRemote(raw);
  let best: UsedMapping | null = null;
  for (const m of mappings) {
    const remote = normalizedRemote(m.remote_path);
    if (wanted !== remote && !wanted.startsWith(`${remote}/`)) continue;
    // The longest prefix wins, so /downloads/movies beats /downloads.
    if (!best || remote.length > normalizedRemote(best.remote_path).length) best = m;
  }
  if (!best) return { local: raw, via: null };
  const suffix = raw.slice(best.remote_path.replace(/[/\\]+$/, "").length).replace(/^[/\\]+/, "");
  const base = best.local_path.replace(/[/\\]+$/, "");
  return { local: suffix ? `${base}/${suffix.replace(/\\/g, "/")}` : base, via: best };
}

/**
 * The folders a scan may look in, as real paths: the downloads folder and the allow-list always; the local folder of a mapping
 * only for a path that went through that mapping (one that is merely under some mapping's local folder is no download).
 */
async function allowedBases(via: UsedMapping | null): Promise<string[]> {
  const places = [config.downloadsDir];
  if (via?.local_path && path.isAbsolute(via.local_path)) places.push(via.local_path);
  places.push(...allowListEntries());
  const real: string[] = [];
  for (const place of places) {
    const resolved = await realOrNull(place);
    if (resolved) real.push(resolved);
  }
  return [...new Set(real)];
}

/** Every library root folder, as the path it is configured with and as the real path (a scan never goes into either). */
async function libraryRoots(): Promise<string[]> {
  const rows = (await db.prepare("SELECT path FROM root_folders").all()) as { path: string }[];
  const roots = new Set<string>();
  for (const row of rows) {
    if (!row.path) continue;
    roots.add(path.resolve(row.path));
    const real = await realOrNull(row.path);
    if (real) roots.add(real);
  }
  return [...roots];
}

export interface ScanTarget {
  /** The real path (symbolic links resolved). */
  real: string;
  isFile: boolean;
}

/**
 * Checks a path a command names, and answers where it really is. Throws ScanRefused (and nothing has been touched) for a path
 * that is not text, not absolute, holds `..`, does not exist, is inside a library root folder, or is not inside the downloads
 * folder, the local folder of the remote path mapping it goes through, or the scanPathAllowList.
 */
export async function checkScanPath(raw: unknown, downloadId?: string | null): Promise<ScanTarget> {
  if (typeof raw !== "string" || raw.trim() === "") throw new ScanRefused("Path must be given");
  const text = raw.trim();
  if (text.includes("\0")) throw new ScanRefused("Path is not a valid path");
  // A path in a download client's own namespace may be a Windows path; the mapping below brings it here.
  if (!path.posix.isAbsolute(text) && !path.win32.isAbsolute(text)) throw new ScanRefused("Path must be an absolute path");
  if (text.split(/[/\\]+/).includes("..")) throw new ScanRefused('Path must not contain ".."');

  // A download id that the queue knows names the client, and then only that client's mappings apply.
  const tracked = downloadId ? ((await db.prepare("SELECT download_client_id FROM queue WHERE download_id = ? LIMIT 1").get(downloadId)) as { download_client_id: number | null } | undefined) : undefined;
  const { local, via } = await mapToLocal(text, tracked?.download_client_id ?? null);
  if (!path.isAbsolute(local)) throw new ScanRefused("Path is not a folder this server can see (no remote path mapping covers it)");

  const real = await realOrNull(local);
  if (!real) throw new ScanRefused("Path does not exist, or cannot be read");
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(real);
  } catch {
    throw new ScanRefused("Path does not exist, or cannot be read");
  }
  if (!stat.isFile() && !stat.isDirectory()) throw new ScanRefused("Path is neither a file nor a folder");

  if ((await libraryRoots()).some((root) => isInside(real, root))) throw new ScanRefused("Path is inside a library root folder; what is there is in the library already");
  if (!(await allowedBases(via)).some((base) => isInside(real, base))) {
    throw new ScanRefused("Path is not inside the downloads folder, the local folder of the remote path mapping it goes through, or a folder of the scanPathAllowList setting");
  }
  return { real, isFile: stat.isFile() };
}

/**
 * How a scan that was not told a mode brings a file in, when the import strategy setting would move it. A file in the downloads
 * folder, or in the folder of a torrent client's remote path mapping, may belong to a torrent that is still seeding with no queue
 * row (imported earlier by hardlink, added by hand, or a Radarr's/Sonarr's): moving it takes the data out from under the client,
 * which stops seeding. So these are hardlinked, and copied where the disks differ (the importer's hardlink strategy does both).
 * The deepest folder the file is in decides; the folder of a usenet client (or any other that does not seed) and the allow-list
 * keep the setting. A setting that already leaves the source alone (copy, hardlink, symlink) is not replaced. Undefined: follow the setting.
 *
 * Asking each torrent client which torrents it holds, to spare a file that is in the middle of one, is not done: only qBittorrent's
 * status call lists every torrent (Transmission and Deluge answer for the ids they are given), so the folder is what is judged.
 */
async function seedingSafeStrategy(real: string): Promise<"hardlink" | undefined> {
  const configured = getSetting("importStrategy") ?? "move";
  if (configured !== "move" && configured !== "auto") return undefined;
  const zones: { base: string; seeds: boolean }[] = [];
  const downloads = await realOrNull(config.downloadsDir);
  if (downloads) zones.push({ base: downloads, seeds: true });
  const mapped = (await db.prepare("SELECT m.local_path AS local_path, c.type AS type FROM remote_path_mappings m JOIN download_clients c ON c.id = m.download_client_id").all()) as { local_path: string; type: string }[];
  for (const m of mapped) {
    if (!m.local_path || !path.isAbsolute(m.local_path)) continue;
    const base = await realOrNull(m.local_path);
    if (base) zones.push({ base, seeds: SEEDING_CLIENT_TYPES.has(m.type) });
  }
  const around = zones.filter((z) => isInside(real, z.base)).sort((a, b) => b.base.length - a.base.length);
  return around[0]?.seeds ? "hardlink" : undefined;
}

/** The import mode a command asks for (Starr: Auto, Move, Copy; AoNarr also hardlink and symlink); undefined follows the import strategy setting. */
export function importModeOfCommand(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const mode = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (mode === "auto") return undefined;
  if (["move", "copy", "hardlink", "symlink"].includes(mode)) return mode;
  throw new ScanRefused("ImportMode must be Auto, Move, Copy, HardLink or SymLink", "ImportMode");
}

// --- what is in the folder ----------------------------------------------------------------------------------------------

async function listMedia(target: ScanTarget, extensions: Set<string>, roots: string[]): Promise<{ files: string[]; cut: boolean; tooDeep: boolean }> {
  const hasExtension = (name: string) => extensions.has(path.extname(name).toLowerCase());
  if (target.isFile) return { files: hasExtension(target.real) ? [target.real] : [], cut: false, tooDeep: false };
  const files: string[] = [];
  let entries = 0;
  let truncated = false;
  let tooDeep = false;
  /** Whether a folder the depth limit skips has anything a scan would have looked at (a folder or a media file). */
  const holdsMedia = async (dir: string): Promise<boolean> => {
    try {
      return (await fs.promises.readdir(dir, { withFileTypes: true })).some((c) => !c.isSymbolicLink() && (c.isDirectory() || (c.isFile() && hasExtension(c.name))));
    } catch {
      return false;
    }
  };
  const visit = async (dir: string, depth: number): Promise<void> => {
    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (truncated) return;
      if (++entries > MAX_ENTRIES) {
        truncated = true;
        return;
      }
      // A link is never followed: it can point out of the place this scan is allowed to look in.
      if (child.isSymbolicLink()) continue;
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (roots.some((root) => isInside(full, root))) continue;
        if (depth >= MAX_DEPTH) {
          // Not walked, and said so: media in it would otherwise be missing without a word.
          if (!tooDeep && (await holdsMedia(full))) tooDeep = true;
          continue;
        }
        await visit(full, depth + 1);
      } else if (child.isFile() && hasExtension(child.name) && !child.name.startsWith(".aonarr-tmp-")) {
        if (files.length >= scanLimits.maxLookedAt) {
          truncated = true;
          return;
        }
        files.push(full);
      }
    }
  };
  await visit(target.real, 0);
  return { files, cut: truncated, tooDeep };
}

// --- who a file is ------------------------------------------------------------------------------------------------------

const numbered = (p: ParsedRelease) => p.seasonNumber != null || (p.episodeNumbers?.length ?? 0) > 0 || p.isFullSeason || !!p.airDate || p.absoluteEpisode != null;
const DISC_FOLDER = /^(cd|disc|disk)\s*[-_]?\s*\d+$/i;

/** The names a file can be known by: its own, then the folders it came in, nearest first, up to (and with) the scanned one. */
function namesOf(file: string, root: ScanTarget): string[] {
  const names = [path.basename(file, path.extname(file))];
  const stop = root.isFile ? path.dirname(root.real) : root.real;
  let dir = path.dirname(file);
  while (isInside(dir, stop)) {
    names.push(path.basename(dir));
    if (dir === stop || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  return names.filter((n) => n.trim() !== "");
}

/** The release name to match a video file by: its own when it names itself, else the nearest folder's, with the numbering of the file. */
function releaseNameFor(file: string, root: ScanTarget): { name: string; parsed: ParsedRelease } {
  const names = namesOf(file, root);
  const own = parseReleaseTitle(names[0]);
  if (own.title && !own.rejected && (numbered(own) || own.year != null)) return { name: names[0], parsed: own };
  for (const name of names.slice(1)) {
    const folder = parseReleaseTitle(name);
    if (!folder.title || folder.rejected) continue;
    // The folder names the title; the file's own numbering (S01E02) or the folder's says which part.
    const merged = numbered(own) ? { ...folder, seasonNumber: own.seasonNumber, episodeNumbers: own.episodeNumbers, isFullSeason: own.isFullSeason, airDate: own.airDate, absoluteEpisode: own.absoluteEpisode } : folder;
    return { name, parsed: merged };
  }
  return { name: names[0], parsed: own };
}

interface Target {
  item: MediaItem;
  episodeId: number | null;
  subItemId: number | null;
  /** The name the match was made by (kept on the file as its release). */
  name: string;
}

type Match = { target: Target } | { reason: string };

async function itemsOfTypes(types: string[]): Promise<MediaItem[]> {
  const rows = (await db.prepare(`SELECT * FROM media_items WHERE type IN (${types.map(() => "?").join(",")})`).all(...types)) as any[];
  return rows.map(mediaItemFromRow) as MediaItem[];
}

const yearFits = (parsed: ParsedRelease, item: MediaItem) => parsed.titleYear != null || parsed.year == null || item.year == null || Math.abs(parsed.year - item.year) <= 1;

// --- the scan -----------------------------------------------------------------------------------------------------------

/** Scans run one at a time: two of them over the same folder would race for its files. */
let scanning: Promise<unknown> = Promise.resolve();

export interface ScanOptions {
  /** The media types the app that was asked holds (Radarr: movie). */
  types: string[];
  /** The raw `path` of the command. */
  path: unknown;
  /** The raw `importMode` of the command. */
  importMode?: unknown;
  /** The `downloadClientId` of the command: the id the download client gave the download. */
  downloadId?: unknown;
}

export function scanPath(options: ScanOptions): Promise<ScanSummary> {
  const run = scanning.then(
    () => scanNow(options),
    () => scanNow(options)
  );
  scanning = run.catch(() => undefined);
  return run;
}

async function scanNow(options: ScanOptions): Promise<ScanSummary> {
  const downloadId = typeof options.downloadId === "string" && options.downloadId.trim() ? options.downloadId.trim() : null;
  // Judged again here, not only when the command was accepted: the path may have changed since.
  const target = await checkScanPath(options.path, downloadId);
  const mode = importModeOfCommand(options.importMode);
  const shape = getMediaTypeConfig(options.types[0]).shape;
  const multiFile = shape === "collection" && !!getMediaTypeConfig(options.types[0]).multiFilePerChild;
  const extensions = new Set(options.types.flatMap((t) => getMediaTypeConfig(t).extensions.map((e) => e.toLowerCase())));
  const roots = await libraryRoots();
  const { files, cut, tooDeep } = await listMedia(target, extensions, roots);

  const summary: ScanSummary = { found: files.length, imported: 0, skipped: 0, unmatched: 0, tracked: 0, failed: 0, truncated: cut || tooDeep, tooDeep, files: [], message: "" };
  const relative = (file: string) => (target.isFile ? path.basename(file) : path.relative(target.real, file).split(path.sep).join("/"));
  const note = (file: string, outcome: ScanOutcome, reason?: string, mediaItemId?: number) => {
    summary[outcome]++;
    summary.files.push({ file: relative(file), outcome, ...(reason ? { reason } : {}), ...(mediaItemId != null ? { mediaItemId } : {}) });
  };

  // Downloads the queue is tracking are imported by the queue's own pipeline (identity checks, blocklist, history): a scan that
  // moved their files would leave that import with nothing, and the release would be failed and grabbed again.
  const queued = (await db.prepare("SELECT download_path, download_id FROM queue WHERE status IN ('queued', 'downloading', 'completed')").all()) as { download_path: string | null; download_id: string | null }[];
  const trackedPaths = queued.filter((q) => q.download_path).map((q) => path.resolve(q.download_path!));
  const knownId = downloadId !== null && queued.some((q) => q.download_id === downloadId);
  const isTracked = (file: string) => knownId || trackedPaths.some((p) => isInside(file, p));

  const claims = new Set<string>();
  const strategyHint = downloadId ? ((await db.prepare("SELECT q.protocol AS protocol, c.type AS client_type FROM queue q LEFT JOIN download_clients c ON c.id = q.download_client_id WHERE q.download_id = ? LIMIT 1").get(downloadId)) as { protocol: string | null; client_type: string | null } | undefined) : undefined;
  const hinted = strategyHint ? autoStrategyFor(strategyHint.protocol, strategyHint.client_type) : undefined;
  // No mode asked for, and nothing known about the download: a file in a torrent client's folder may still be seeding.
  const seedingSafe = mode === undefined && hinted === undefined ? await seedingSafeStrategy(target.real) : undefined;
  const strategy = mode ?? hinted ?? seedingSafe;

  const withStrategy: Strategy = (work) => withImportStrategy(strategy, work);
  const import1 = async (file: string, work: () => Promise<void>, itemId: number) => {
    try {
      await withStrategy(work);
      note(file, "imported", undefined, itemId);
    } catch (err) {
      const reason = redactLinks((err as Error).message);
      if (err instanceof ImportSkippedError) note(file, "skipped", reason, itemId);
      else {
        log.warn(`[pathScan] "${path.basename(file)}" was not imported:`, reason);
        note(file, "failed", reason, itemId);
      }
    }
  };

  const candidates = files.filter((file) => {
    if (!isTracked(file)) return true;
    note(file, "tracked", "this download is in the queue: AoNarr imports it itself");
    return false;
  });

  // Judged in chunks of whole folders. Only the files that could still be imported count toward scanLimits.maxFiles: one the library
  // already has (or a profile refuses) is the same on every rerun, and would otherwise hold back the files after it for ever.
  const cache: ScanCache = {};
  let spent = 0;
  let looked = files.length - candidates.length;
  let budgetCut = false;
  for (const chunk of chunksOf(candidates, target, multiFile)) {
    if (spent >= scanLimits.maxFiles) {
      budgetCut = true;
      break;
    }
    const skippedBefore = summary.skipped;
    if (shape === "single") await scanSingles(chunk, target, options.types, claims, note, import1, cache);
    else if (shape === "episodic") await scanEpisodes(chunk, target, options.types, claims, note, import1, cache);
    else if (multiFile) await scanAlbums(chunk, target, options.types, claims, note, withStrategy);
    else await scanBooks(chunk, target, options.types, claims, note, import1);
    looked += chunk.length;
    spent += chunk.length - (summary.skipped - skippedBefore);
  }
  if (budgetCut) {
    summary.found = looked;
    summary.truncated = true;
  }

  summary.message = describe(summary, target, { cut: cut || budgetCut, hardlinked: seedingSafe === "hardlink" });
  log.info(`[pathScan] ${summary.message}`);
  return summary;
}

function describe(s: ScanSummary, target: ScanTarget, how: { cut: boolean; hardlinked: boolean }): string {
  const where = `"${path.basename(target.real)}"`;
  const notes: string[] = [];
  if (how.cut) notes.push(`only the first ${s.found} files were looked at`);
  if (s.tooDeep) notes.push(`folders deeper than ${MAX_DEPTH} levels were not looked at`);
  const cut = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  if (s.found === 0) return `Nothing to import: no media files in ${where}${cut}`;
  const parts: string[] = [];
  if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
  if (s.unmatched > 0) parts.push(`${s.unmatched} matched nothing in the library`);
  if (s.tracked > 0) parts.push(`${s.tracked} left to the queue`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  // The scan chose this strategy itself (no mode was asked for): said, so a download that is still there is no surprise.
  if (how.hardlinked && s.imported > 0) parts.push(`hardlinked ${s.imported} file${s.imported === 1 ? "" : "s"} (copied where a link cannot be made), the download stays where it is`);
  const left = parts.length > 0 ? `; ${parts.join(", ")}` : "";
  return `Imported ${s.imported} of ${s.found} media file${s.found === 1 ? "" : "s"} in ${where}${left}${cut}`;
}

type Note = (file: string, outcome: ScanOutcome, reason?: string, mediaItemId?: number) => void;
type Import1 = (file: string, work: () => Promise<void>, itemId: number) => Promise<void>;
type Strategy = <T>(work: () => Promise<T>) => Promise<T>;

/** What the scanners read once per scan, however many chunks of files they are handed. */
interface ScanCache {
  items?: MediaItem[];
  aliases?: Map<number, string[]>;
  episodes?: Map<number, any[]>;
  scene?: Map<number, Awaited<ReturnType<typeof sceneIndexFor>>>;
  absolutes?: Map<number, number>;
}

/** The folder whose album a track belongs to (a disc folder belongs to the album folder above it). */
function albumFolderOf(file: string, root: ScanTarget): string {
  const dir = path.dirname(file);
  return DISC_FOLDER.test(path.basename(dir)) && isInside(path.dirname(dir), root.real) ? path.dirname(dir) : dir;
}

/** The files in groups of whole folders (an album's tracks stay together), scanLimits.chunkSize files or a little more to a group. */
function chunksOf(files: string[], root: ScanTarget, byAlbum: boolean): string[][] {
  const folders = new Map<string, string[]>();
  for (const file of files) {
    const key = byAlbum ? albumFolderOf(file, root) : path.dirname(file);
    const group = folders.get(key);
    if (group) group.push(file);
    else folders.set(key, [file]);
  }
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const group of folders.values()) {
    if (current.length > 0 && current.length + group.length > scanLimits.chunkSize) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** The quality a file's names state, or null. */
function qualityOf(file: string, root: ScanTarget): string | null {
  for (const name of namesOf(file, root)) {
    const q = parseReleaseTitle(name).quality;
    if (q && q !== "Unknown") return q;
  }
  return null;
}

/**
 * Whether what the library holds for a target keeps this file out: a file already there (and on disk) is replaced only by a
 * better quality, by the profile's own ranking. Null when the file may be imported. Types without quality tiers (albums, books)
 * never replace.
 */
async function keepsExisting(item: MediaItem, existing: { hasFile: boolean; quality: string | null; filePath: string | null }, quality: string | null, tiered: boolean): Promise<string | null> {
  if (!existing.hasFile) return null;
  if (existing.filePath && !fs.existsSync(existing.filePath)) return null; // recorded, but gone from the disk: the import fills it
  if (!tiered) return "the library already has a file for it";
  const profile = await getQualityProfile(item.qualityProfileId);
  const ranking = rankingOf(profile);
  if (quality && existing.quality && groupedRank(quality, ranking) > groupedRank(existing.quality, ranking)) return null;
  return `the library already has a "${existing.quality ?? "unknown"}" file for it and this one ("${quality ?? "unknown"}") is not a better quality`;
}

/** The profile's allowed qualities: a file of another quality is not imported. */
async function profileRefuses(item: MediaItem, quality: string | null): Promise<string | null> {
  if (!quality) return null;
  const profile = await getQualityProfile(item.qualityProfileId);
  const allowed = profile?.allowedQualities ?? [];
  return allowed.length > 0 && !allowed.includes(quality) ? `its quality "${quality}" is not allowed by the quality profile of "${item.title}"` : null;
}

async function scanSingles(files: string[], root: ScanTarget, types: string[], claims: Set<string>, note: Note, import1: Import1, cache: ScanCache): Promise<void> {
  const movies = (cache.items ??= await itemsOfTypes(types));
  const aliases = (cache.aliases ??= await aliasTitlesByItem());
  for (const file of files) {
    const { name, parsed } = releaseNameFor(file, root);
    if (numbered(parsed)) {
      note(file, "unmatched", "its name is numbered like an episode, not a film");
      continue;
    }
    const resolved = await resolveReleaseItemInLibrary({ title: name }, parsed, movies.filter((m) => yearFits(parsed, m)), aliases);
    if (resolved.kind !== "one") {
      note(file, "unmatched", resolved.kind === "ambiguous" ? `"${parsed.title}" could be more than one title of the library` : `no title of the library is named "${parsed.title}"`);
      continue;
    }
    const item = resolved.item;
    const quality = qualityOf(file, root);
    const current = (await db.prepare("SELECT has_file, quality, path FROM media_items WHERE id = ?").get(item.id)) as { has_file: number; quality: string | null; path: string | null };
    const why = (await profileRefuses(item, quality)) ?? (await keepsExisting(item, { hasFile: !!Number(current.has_file), quality: current.quality, filePath: current.path }, quality, true));
    if (why) {
      note(file, "skipped", why, item.id);
      continue;
    }
    await import1(file, async () => void (await placeFile({ itemId: item.id, episodeId: null, subItemId: null, sourceFile: file, quality, batchClaims: claims, verify: { releaseTitle: name, downloadPath: root.real }, releaseTitle: name, refuseDowngrade: true })), item.id);
  }
}

async function scanEpisodes(files: string[], root: ScanTarget, types: string[], claims: Set<string>, note: Note, import1: Import1, cache: ScanCache): Promise<void> {
  const shows = (cache.items ??= await itemsOfTypes(types));
  const aliases = (cache.aliases ??= await aliasTitlesByItem());
  const episodesOf = (cache.episodes ??= new Map<number, any[]>());
  const sceneOf = (cache.scene ??= new Map<number, Awaited<ReturnType<typeof sceneIndexFor>>>());
  const absolutes = (cache.absolutes ??= new Map<number, number>());
  for (const file of files) {
    const { name, parsed } = releaseNameFor(file, root);
    if (!numbered(parsed)) {
      note(file, "unmatched", "its name carries no season and episode, and no air date");
      continue;
    }
    if (parsed.isFullSeason) {
      note(file, "unmatched", "its name is a season pack's, not an episode's");
      continue;
    }
    const resolved = await resolveReleaseItemInLibrary({ title: name }, parsed, shows, aliases);
    if (resolved.kind !== "one") {
      note(file, "unmatched", resolved.kind === "ambiguous" ? `"${parsed.title}" could be more than one show of the library` : `no show of the library is named "${parsed.title}"`);
      continue;
    }
    const show = resolved.item;
    if (!episodesOf.has(show.id)) episodesOf.set(show.id, (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number").all(show.id)) as any[]);
    if (!sceneOf.has(show.id)) sceneOf.set(show.id, await sceneIndexFor(show.id));
    let episode: any | null = null;
    for (const ep of episodesOf.get(show.id)!) {
      if (await releaseNamesEpisode(parsed, show, ep, sceneOf.get(show.id)!, absolutes)) {
        episode = ep;
        break;
      }
    }
    if (!episode) {
      note(file, "unmatched", `it names no episode of "${show.title}" that the library lists`, show.id);
      continue;
    }
    const quality = qualityOf(file, root);
    const why = (await profileRefuses(show, quality)) ?? (await keepsExisting(show, { hasFile: !!Number(episode.has_file), quality: episode.quality, filePath: episode.file_path }, quality, true));
    if (why) {
      note(file, "skipped", why, show.id);
      continue;
    }
    await import1(file, async () => void (await placeFile({ itemId: show.id, episodeId: Number(episode.id), subItemId: null, sourceFile: file, quality, batchClaims: claims, verify: { releaseTitle: name, downloadPath: root.real }, releaseTitle: name, refuseDowngrade: true })), show.id);
  }
}

/** The artists, authors and the like whose names the release has, each with every sub-item the library lists (a plain edition before a deluxe one). */
async function collectionsNamedIn(name: string, types: string[]): Promise<{ item: MediaItem; subs: any[] }[]> {
  const key = ` ${identityKey(name)} `;
  const named = (await itemsOfTypes(types)).filter((item) => {
    const own = identityKey(item.title);
    return !!own && key.includes(` ${own} `);
  });
  const out: { item: MediaItem; subs: any[] }[] = [];
  for (const item of named) {
    const subs = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ? ORDER BY id").all(item.id)) as any[];
    if (subs.length > 0) out.push({ item, subs });
  }
  return out;
}

async function matchCollection(names: string[], types: string[]): Promise<Match> {
  for (const name of names) {
    const hit = await matchCollectionRelease({ title: name } as SearchResult, await collectionsNamedIn(name, types));
    if (hit) return { target: { item: hit.item, episodeId: null, subItemId: Number(hit.sub.id), name } };
  }
  return { reason: `no album or book of the library is named "${names[0]}"` };
}

async function scanAlbums(files: string[], root: ScanTarget, types: string[], claims: Set<string>, note: Note, withStrategy: Strategy): Promise<void> {
  // The tracks of one album are in one folder (a disc folder belongs to the album folder above it).
  const byFolder = new Map<string, string[]>();
  for (const file of files) {
    const folder = albumFolderOf(file, root);
    const tracks = byFolder.get(folder);
    if (tracks) tracks.push(file);
    else byFolder.set(folder, [file]);
  }
  for (const [folder, tracks] of byFolder) {
    const folderName = path.basename(folder);
    const above = path.basename(path.dirname(folder));
    const match = await matchCollection([folderName, `${above} ${folderName}`], types);
    if (!("target" in match)) {
      for (const track of tracks) note(track, "unmatched", match.reason);
      continue;
    }
    const { item, subItemId, name } = match.target;
    const sub = (await db.prepare("SELECT has_file, quality, file_path FROM sub_items WHERE id = ?").get(subItemId)) as { has_file: number; quality: string | null; file_path: string | null };
    const quality = parseReleaseTitle(name).quality;
    const why = await keepsExisting(item, { hasFile: !!Number(sub.has_file), quality: sub.quality, filePath: sub.file_path }, quality, false);
    if (why) {
      for (const track of tracks) note(track, "skipped", why, item.id);
      continue;
    }
    try {
      const placed = await withStrategy(() =>
        placeAlbumFiles({ itemId: item.id, subItemId: subItemId!, anchorFile: tracks.sort()[0], quality: quality === "Unknown" ? null : quality, releaseTitle: name, downloadPath: null, category: null, batchClaims: claims, refuseDowngrade: true })
      );
      // Every track of the folder went with the album; one the importer left in place is not counted as imported.
      const left = Math.min(tracks.length, placed.leftInPlace);
      for (const track of tracks.slice(0, tracks.length - left)) note(track, "imported", undefined, item.id);
      for (const track of tracks.slice(tracks.length - left)) note(track, "skipped", "left where it was by the import", item.id);
    } catch (err) {
      const reason = redactLinks((err as Error).message);
      for (const track of tracks) note(track, err instanceof ImportSkippedError ? "skipped" : "failed", reason, item.id);
    }
  }
}

async function scanBooks(files: string[], root: ScanTarget, types: string[], claims: Set<string>, note: Note, import1: Import1): Promise<void> {
  for (const file of files) {
    const base = path.basename(file, path.extname(file));
    const match = await matchCollection([base, `${path.basename(path.dirname(file))} ${base}`], types);
    if (!("target" in match)) {
      note(file, "unmatched", match.reason);
      continue;
    }
    const { item, subItemId, name } = match.target;
    const sub = (await db.prepare("SELECT has_file, quality, file_path FROM sub_items WHERE id = ?").get(subItemId)) as { has_file: number; quality: string | null; file_path: string | null };
    const why = await keepsExisting(item, { hasFile: !!Number(sub.has_file), quality: sub.quality, filePath: sub.file_path }, null, false);
    if (why) {
      note(file, "skipped", why, item.id);
      continue;
    }
    await import1(file, async () => void (await placeFile({ itemId: item.id, episodeId: null, subItemId, sourceFile: file, quality: null, batchClaims: claims, releaseTitle: name, refuseDowngrade: true })), item.id);
  }
}
