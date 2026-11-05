import fsp from "node:fs/promises";
import path from "node:path";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/errorHandler.js";
import { writeAudioTags } from "./audioTagWriter.js";
import type { AudioTagInfo, CoverImage, TagWriteResult, WriteAudioTagsOptions } from "./audioTagCommon.js";
import { formatLabelOf, modeFollowsEdits, modeRetagsLibrary, modeTagsOnImport, resolveWriteTagsMode, type WriteTagsMode } from "./audioTagCommon.js";
import { finishBackgroundJob, incrementBackgroundJobDone, isBackgroundJobRunning, startBackgroundJob } from "./backgroundJobs.js";
import { StorageTimeoutError, readdirNamesAsync, statAsync } from "./fsAsync.js";
import { log } from "./logger.js";
import { isLocalAddress } from "./networkAddress.js";
import { rootFolderUnmountedReason } from "./rootFolderCheck.js";
import { getSetting } from "./settingsStore.js";
import { isTitleMoving, tryLockTitleMove, unlockTitleMove } from "./titleMoveLock.js";

/**
 * Writing the tags of the music and audiobook files AoNarr holds, as Lidarr does ("write tags": none, new files, all files,
 * sync). This file is the part that knows the database: which tags a track gets, which cover it may carry, and the walks that
 * retag a title or the whole library. Writing into a file is audioTagWriter.ts.
 *
 * Ebooks (EPUB, PDF, CBZ) are not written: their metadata lives inside a zip (an OPF file, a ComicInfo.xml), which needs a
 * zip editor, not a tag writer.
 */

export const RETAGGABLE_TYPES = ["artist", "audiobook"] as const;

export interface AudioTagSettings {
  mode: WriteTagsMode;
  scrub: boolean;
  embedCover: boolean;
}

export function getAudioTagSettings(): AudioTagSettings {
  return {
    mode: resolveWriteTagsMode(getSetting("writeAudioTagsMode"), getSetting("writeAudioTagsOnImport")),
    scrub: getSetting("scrubAudioTags") === "1",
    embedCover: getSetting("embedAudioCover") === "1",
  };
}

/** An import tags the files it places (modes new, all, sync). */
export function writeTagsOnImportEnabled(): boolean {
  return modeTagsOnImport(getAudioTagSettings().mode);
}

// ---- which tags a track gets ----------------------------------------------------------------------------------------

export interface TagSourceRows {
  item: { type: string; title: string; external_ids?: unknown; externalIds?: unknown; genres?: unknown };
  sub: {
    title: string;
    release_date?: string | null;
    external_id?: string | null;
    external_provider?: string | null;
    series_name?: string | null;
    series_position?: number | string | null;
    narrator?: string | null;
  };
  track: { track_number: number | string; title: string };
  /** How many tracks the album or book has (every row, whether or not its file is there yet). */
  trackTotal?: number | null;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function genreText(value: unknown): string | null {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      list = [value];
    }
  }
  const names = Array.isArray(list) ? list.filter((g): g is string => typeof g === "string" && g.trim() !== "").slice(0, 3) : [];
  return names.length > 0 ? names.join("; ") : null;
}

function partText(value: number | string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(value);
}

/**
 * What AoNarr knows about a track as tags. A music file's artist is the artist the album is filed under (AoNarr keeps no
 * per-track artist), its MusicBrainz ids are the artist's and the album's release group; an audiobook's artist is its author, its
 * composer field carries the narrator and the series goes in the grouping. Fields AoNarr does not know are left out, never
 * written empty.
 */
export function audioTagInfoFor(rows: TagSourceRows): AudioTagInfo {
  const { item, sub, track } = rows;
  const audiobook = item.type === "audiobook";
  const trackNumber = Number(track.track_number);
  const releaseDate = typeof sub.release_date === "string" ? sub.release_date.trim() : "";
  const total = rows.trackTotal != null && Number(rows.trackTotal) >= trackNumber ? Number(rows.trackTotal) : null;
  const info: AudioTagInfo = {
    title: track.title,
    artist: item.title,
    albumArtist: item.title,
    album: sub.title,
    trackNumber: Number.isFinite(trackNumber) && trackNumber > 0 ? trackNumber : undefined,
    trackTotal: total,
    year: /^\d{4}/.exec(releaseDate)?.[0] ?? null,
    date: /^\d{4}(-\d{2}(-\d{2})?)?$/.test(releaseDate) ? releaseDate : null,
    genre: genreText(item.genres),
  };
  if (audiobook) {
    info.composer = sub.narrator?.trim() || null;
    info.series = sub.series_name?.trim() || null;
    info.seriesPart = info.series ? partText(sub.series_position) : null;
    return info;
  }
  const artistMbid = parseObject(item.external_ids ?? item.externalIds).musicbrainz;
  const artistId = typeof artistMbid === "string" && artistMbid ? artistMbid : null;
  info.musicbrainz = {
    artistId,
    albumArtistId: artistId,
    releaseGroupId: sub.external_provider === "musicbrainz" && sub.external_id ? sub.external_id : null,
  };
  return info;
}

// ---- the cover ------------------------------------------------------------------------------------------------------

const COVER_NAMES = ["cover", "folder", "front", "albumart", "album"];
const COVER_EXTENSIONS = [".jpg", ".jpeg", ".png"];
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const COVER_FETCH_TIMEOUT_MS = 15_000;

/** The picture's type from its first bytes, or null when it is neither a JPEG nor a PNG (the formats ffmpeg and ID3 take as they are). */
export function coverFromBytes(data: Buffer): CoverImage | null {
  if (data.length < 8 || data.length > MAX_COVER_BYTES) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { data, mime: "image/jpeg" };
  if (data[0] === 0x89 && data.subarray(1, 4).toString("latin1") === "PNG") return { data, mime: "image/png" };
  return null;
}

/** A cover picture lying in the album's folder (cover.jpg, folder.png and so on); the names are read once, case aside. */
async function localCover(folder: string): Promise<CoverImage | null> {
  let names: string[];
  try {
    names = await readdirNamesAsync(folder, 10_000);
  } catch {
    return null;
  }
  for (const base of COVER_NAMES) {
    for (const ext of COVER_EXTENSIONS) {
      const name = names.find((n) => n.toLowerCase() === base + ext);
      if (!name) continue;
      try {
        const file = path.join(folder, name);
        const stat = await statAsync(file, 10_000);
        if (!stat.isFile() || stat.size > MAX_COVER_BYTES) continue;
        const cover = coverFromBytes(await fsp.readFile(file));
        if (cover) return cover;
      } catch {
        // an unreadable picture is the same as none
      }
    }
  }
  return null;
}

async function remoteCover(url: string | null | undefined, fetchImpl: typeof fetch): Promise<CoverImage | null> {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // A provider's picture, never an address on the admin's own network.
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || isLocalAddress(parsed.hostname)) return null;
  try {
    const res = await fetchImpl(parsed.toString(), { signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) return null;
    return coverFromBytes(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

const DISC_FOLDER = /^(cd|disc|disk)s*[-_]?s*d+$/i;

/** The album's picture: one in its folder (or, for a disc folder, the album's) first, else the provider's. Null when there is none (the tags are written without). */
export async function resolveCover(folder: string, posterUrl: string | null | undefined, fetchImpl: typeof fetch = fetch): Promise<CoverImage | null> {
  const local = (await localCover(folder)) ?? (DISC_FOLDER.test(path.basename(folder)) ? await localCover(path.dirname(folder)) : null);
  return local ?? (await remoteCover(posterUrl, fetchImpl));
}

// ---- the report -----------------------------------------------------------------------------------------------------

export interface FormatCounts {
  written: number;
  skipped: number;
  failed: number;
}

export interface RetagSummary {
  titles: number;
  files: number;
  written: number;
  skipped: number;
  failed: number;
  /** By format label ("MP3", "FLAC", "M4A/M4B", "OGG", "Opus", or the extension of one that cannot be written). */
  byFormat: Record<string, FormatCounts>;
  /** How many files were skipped or failed for each reason, and how many were written without their cover. */
  reasons: Record<string, number>;
  failures: { file: string; reason: string }[];
  cancelled: boolean;
  startedAt: string;
  finishedAt: string | null;
}

const MAX_LISTED_FAILURES = 25;

export function emptyRetagSummary(): RetagSummary {
  return { titles: 0, files: 0, written: 0, skipped: 0, failed: 0, byFormat: {}, reasons: {}, failures: [], cancelled: false, startedAt: new Date().toISOString(), finishedAt: null };
}

export function addRetagResult(summary: RetagSummary, file: string, result: TagWriteResult): void {
  summary.files++;
  summary[result.outcome]++;
  const counts = (summary.byFormat[result.format] ??= { written: 0, skipped: 0, failed: 0 });
  counts[result.outcome]++;
  if (result.reason) {
    summary.reasons[result.reason] = (summary.reasons[result.reason] ?? 0) + 1;
    if (result.outcome === "failed" && summary.failures.length < MAX_LISTED_FAILURES) summary.failures.push({ file, reason: result.reason });
  }
}

export function mergeRetagSummary(into: RetagSummary, from: RetagSummary): void {
  into.titles += from.titles;
  into.files += from.files;
  into.written += from.written;
  into.skipped += from.skipped;
  into.failed += from.failed;
  for (const [format, counts] of Object.entries(from.byFormat)) {
    const target = (into.byFormat[format] ??= { written: 0, skipped: 0, failed: 0 });
    target.written += counts.written;
    target.skipped += counts.skipped;
    target.failed += counts.failed;
  }
  for (const [reason, n] of Object.entries(from.reasons)) into.reasons[reason] = (into.reasons[reason] ?? 0) + n;
  for (const failure of from.failures) if (into.failures.length < MAX_LISTED_FAILURES) into.failures.push(failure);
  if (from.cancelled) into.cancelled = true;
}

/** "Retagged 120 of 130 files: FLAC 80, MP3 40 written; 8 skipped; 2 failed." */
export function retagSummaryText(summary: RetagSummary): string {
  const formats = Object.entries(summary.byFormat)
    .filter(([, counts]) => counts.written > 0)
    .map(([format, counts]) => `${format} ${counts.written}`);
  const parts = [`${summary.written} of ${summary.files} file(s) written${formats.length > 0 ? ` (${formats.join(", ")})` : ""}`];
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.cancelled) parts.push("cancelled before the end");
  return parts.join("; ");
}

// ---- the walk -------------------------------------------------------------------------------------------------------

export interface RetagOptions {
  signal?: AbortSignal;
  /** Pause after each file that was written, so a library pass does not keep the disks busy all night (default 150 ms). */
  throttleMs?: number;
  /** Replaces the writer (tests). */
  writer?: (filePath: string, info: AudioTagInfo, options: WriteAudioTagsOptions) => Promise<TagWriteResult>;
  /** Overrides the settings (tests). */
  settings?: Pick<AudioTagSettings, "scrub" | "embedCover">;
  /** Replaces the cover lookup (tests). */
  coverFor?: (folder: string, posterUrl: string | null) => Promise<CoverImage | null>;
  /** Called after each file (progress). */
  onFile?: () => void;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retags every file a music or audiobook title has, one at a time. A title with a read-only root folder is left alone whole
 * (as the importer never writes into one), so is one whose share did not come up, one that is being moved at this moment, and
 * any file that is not inside the title's root folder. Never throws for a file: each outcome is counted in the summary.
 */
export async function retagTitle(itemId: number, options: RetagOptions = {}): Promise<RetagSummary> {
  const summary = emptyRetagSummary();
  const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
  if (!item) throw new HttpError(404, "Media item not found");
  if (!(RETAGGABLE_TYPES as readonly string[]).includes(item.type)) {
    throw new HttpError(400, "Only music and audiobook titles have audio files whose tags can be rewritten (ebooks and comics keep theirs inside the file)");
  }
  summary.titles = 1;

  const tracks = (await db
    .prepare(
      `SELECT t.id, t.sub_item_id, t.track_number, t.title, t.file_path
       FROM tracks t JOIN sub_items s ON s.id = t.sub_item_id
       WHERE s.media_item_id = ? AND t.has_file = 1 AND t.file_path IS NOT NULL
       ORDER BY s.id, t.track_number`
    )
    .all(itemId)) as { id: number; sub_item_id: number; track_number: number; title: string; file_path: string }[];

  const skipAll = (reason: string) => {
    for (const t of tracks) {
      addRetagResult(summary, t.file_path, { outcome: "skipped", reason, format: formatLabelOf(t.file_path) });
      options.onFile?.();
    }
    summary.finishedAt = new Date().toISOString();
    return summary;
  };
  if (tracks.length === 0) {
    summary.finishedAt = new Date().toISOString();
    return summary;
  }

  const root = item.root_folder_id != null ? ((await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.root_folder_id)) as any) : null;
  if (!root) return skipAll("the title has no root folder");
  // Never write into a library that is only scanned and served, whatever the files' own permissions say.
  if (Number(root.read_only)) return skipAll("its root folder is read-only");
  const unmounted = await rootFolderUnmountedReason({ id: Number(root.id), path: root.path });
  if (unmounted) return skipAll("its root folder looks unmounted");
  if (!tryLockTitleMove(itemId)) return skipAll("it is being moved or renamed right now");

  try {
    const settings = options.settings ?? getAudioTagSettings();
    const writer = options.writer ?? writeAudioTags;
    const coverFor = options.coverFor ?? ((folder: string, posterUrl: string | null) => resolveCover(folder, posterUrl));
    const throttleMs = options.throttleMs ?? 150;

    const subs = new Map<number, any>();
    for (const sub of (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").all(itemId)) as any[]) subs.set(Number(sub.id), sub);
    const totals = new Map<number, number>();
    for (const row of (await db
      .prepare("SELECT t.sub_item_id AS sub_item_id, COUNT(*) AS c, MAX(t.track_number) AS m FROM tracks t JOIN sub_items s ON s.id = t.sub_item_id WHERE s.media_item_id = ? GROUP BY t.sub_item_id")
      .all(itemId)) as { sub_item_id: number; c: number; m: number }[]) {
      totals.set(Number(row.sub_item_id), Math.max(Number(row.c), Number(row.m)));
    }
    const covers = new Map<number, Promise<CoverImage | null>>();

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (options.signal?.aborted) {
        summary.cancelled = true;
        break;
      }
      const file = t.file_path;
      const done = (result: TagWriteResult) => {
        addRetagResult(summary, file, result);
        options.onFile?.();
      };
      if (!isInside(root.path, file)) {
        done({ outcome: "skipped", reason: "the file is not inside the title's root folder", format: formatLabelOf(file) });
        continue;
      }
      try {
        await statAsync(file, 10_000);
      } catch (err) {
        if (err instanceof StorageTimeoutError) {
          // A mount that stopped answering: the rest of the title is not tried one slow call at a time.
          for (const rest of tracks.slice(i)) {
            addRetagResult(summary, rest.file_path, { outcome: "skipped", reason: "its storage did not answer", format: formatLabelOf(rest.file_path) });
            options.onFile?.();
          }
          break;
        }
        done({ outcome: "skipped", reason: "the file is missing", format: formatLabelOf(file) });
        continue;
      }
      const sub = subs.get(Number(t.sub_item_id));
      if (!sub) {
        done({ outcome: "skipped", reason: "the track's album or book is gone", format: formatLabelOf(file) });
        continue;
      }
      const info = audioTagInfoFor({ item, sub, track: t, trackTotal: totals.get(Number(t.sub_item_id)) ?? null });
      let cover: CoverImage | null = null;
      if (settings.embedCover) {
        let pending = covers.get(Number(t.sub_item_id));
        if (!pending) {
          pending = coverFor(path.dirname(file), sub.poster_url ?? null).catch(() => null);
          covers.set(Number(t.sub_item_id), pending);
        }
        cover = await pending;
      }
      const result = await writer(file, info, { scrub: settings.scrub, cover, signal: options.signal });
      done(result);
      if (result.outcome === "written" && throttleMs > 0) await sleep(throttleMs);
      else await sleep(0);
    }
  } finally {
    unlockTitleMove(itemId);
    summary.finishedAt = new Date().toISOString();
  }
  return summary;
}

/** The last library-wide retag of this process, for the Settings page. */
let lastLibraryRetag: RetagSummary | null = null;

export function getLastLibraryRetag(): RetagSummary | null {
  return lastLibraryRetag;
}

export function resetRetagStateForTests(): void {
  lastLibraryRetag = null;
}

/** Titles of the retaggable types that have a track file. */
async function titlesWithFiles(): Promise<{ id: number; title: string }[]> {
  const types = RETAGGABLE_TYPES.map(() => "?").join(", ");
  return (await db
    .prepare(
      `SELECT DISTINCT m.id AS id, m.title AS title FROM media_items m
       JOIN sub_items s ON s.media_item_id = m.id JOIN tracks t ON t.sub_item_id = s.id
       WHERE m.type IN (${types}) AND t.has_file = 1 AND t.file_path IS NOT NULL
       ORDER BY m.id`
    )
    .all(...RETAGGABLE_TYPES)) as { id: number; title: string }[];
}

/**
 * Retags every music and audiobook title, as one tracked job ("Retag Audio Files" in the Jobs page and the progress widget).
 * Sequential and throttled; `signal` cancels it between files and stops the ffmpeg run in progress. Without `manual`, a run
 * that was scheduled does nothing unless the mode asks for library passes (all, sync).
 */
export async function runLibraryRetag(signal: AbortSignal, options: RetagOptions & { manual?: boolean } = {}): Promise<RetagSummary> {
  const summary = emptyRetagSummary();
  if (!options.manual && !modeRetagsLibrary(getAudioTagSettings().mode)) {
    summary.finishedAt = new Date().toISOString();
    return summary;
  }
  if (isBackgroundJobRunning("retag", "library")) throw new Error("A library retag is already running");
  const titles = await titlesWithFiles();
  const jobId = startBackgroundJob("retag", "library", "Retag audio files", titles.length);
  lastLibraryRetag = summary;
  let error: string | undefined;
  try {
    for (const title of titles) {
      if (signal.aborted) {
        summary.cancelled = true;
        break;
      }
      try {
        mergeRetagSummary(summary, await retagTitle(title.id, { ...options, signal }));
      } catch (err) {
        log.warn(`[audioRetag] retagging "${title.title}" failed:`, (err as Error).message);
        summary.failed++;
        summary.files++;
        summary.reasons[(err as Error).message] = (summary.reasons[(err as Error).message] ?? 0) + 1;
      }
      incrementBackgroundJobDone("retag", "library");
    }
    if (summary.failed > 0) error = `${summary.failed} file(s) could not be tagged — see the Logs page`;
  } finally {
    summary.finishedAt = new Date().toISOString();
    finishBackgroundJob(jobId, error, retagSummaryText(summary));
    log.info(`[audioRetag] ${retagSummaryText(summary)}`);
  }
  return summary;
}

export interface TitleRetagStart {
  started: boolean;
  reason?: "already-running" | "no-files";
  /** How many files the retag looks at. */
  files: number;
}

/**
 * Starts the retag of one title as a tracked background job (a title with hundreds of files runs longer than a request may);
 * answers at once. The progress widget shows it, and its completion message carries the counts per outcome.
 */
export async function startTitleRetag(itemId: number): Promise<TitleRetagStart> {
  const row = (await db.prepare("SELECT id, type, title FROM media_items WHERE id = ?").get(itemId)) as { id: number; type: string; title: string } | undefined;
  if (!row) throw new HttpError(404, "Media item not found");
  if (!(RETAGGABLE_TYPES as readonly string[]).includes(row.type)) {
    throw new HttpError(400, "Only music and audiobook titles have audio files whose tags can be rewritten (ebooks and comics keep theirs inside the file)");
  }
  const type = `title-${itemId}`;
  if (isBackgroundJobRunning("retag", type)) return { started: false, reason: "already-running", files: 0 };
  if (isTitleMoving(itemId)) throw new HttpError(409, `"${row.title}" is being moved or renamed right now`);
  const counted = (await db
    .prepare("SELECT COUNT(*) AS c FROM tracks t JOIN sub_items s ON s.id = t.sub_item_id WHERE s.media_item_id = ? AND t.has_file = 1 AND t.file_path IS NOT NULL")
    .get(itemId)) as { c: number };
  const files = Number(counted.c);
  if (files === 0) return { started: false, reason: "no-files", files: 0 };
  const jobId = startBackgroundJob("retag", type, `Retag "${row.title}"`, files);
  void (async () => {
    let error: string | undefined;
    let text: string | undefined;
    try {
      const summary = await retagTitle(itemId, { onFile: () => incrementBackgroundJobDone("retag", type) });
      text = retagSummaryText(summary);
      if (summary.failed > 0) error = `${summary.failed} file(s) could not be tagged — see the Logs page`;
      log.info(`[audioRetag] "${row.title}": ${text}`);
    } catch (err) {
      error = (err as Error).message;
      log.warn(`[audioRetag] retagging "${row.title}" failed:`, error);
    } finally {
      finishBackgroundJob(jobId, error, text);
    }
  })();
  return { started: true, files };
}

/**
 * `sync` mode: a metadata edit or rematch of a title is followed by a retag of its files. Fire and forget, tracked in the
 * progress widget; any other mode does nothing. Never throws.
 */
export function retagTitleAfterEdit(itemId: number, type: string): void {
  try {
    if (!(RETAGGABLE_TYPES as readonly string[]).includes(type) || !modeFollowsEdits(getAudioTagSettings().mode)) return;
  } catch {
    return;
  }
  startTitleRetag(itemId).catch((err) => log.warn(`[audioRetag] retag after an edit of title ${itemId} not started:`, (err as Error).message));
}
