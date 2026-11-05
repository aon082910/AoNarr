import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { log } from "./logger.js";
import { writeArtworkFile, type ArtworkResult, type ArtworkSource } from "./artworkFiles.js";
import { finishBackgroundJob, incrementBackgroundJobDone, startBackgroundJob } from "./backgroundJobs.js";
import { trackedFileInside } from "./fileDeletion.js";
import { folderSegmentsOf, ownFolderOf } from "./libraryFolder.js";
import {
  buildAlbumNfo,
  buildArtistNfo,
  writeEpisodeNfoSidecar,
  writeMusicNfo,
  writeNfoSidecar,
  writeTvShowNfoIfMissing,
  type ExportableItem,
  type NfoWriteResult,
} from "./metadataExport.js";
import {
  anythingEnabledFor,
  imagesApplyTo,
  metadataKindOf,
  readMetadataFileOptions,
  type MetadataFileOptions,
  type MetadataKind,
} from "./metadataFileOptions.js";
import { fetchSeriesEpisodesFor } from "./metadata.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { namingTemplateOfType } from "./naming.js";
import { rootFolderUnmountedReason } from "./rootFolderCheck.js";
import { isTitleMoving } from "./titleMoveLock.js";

/**
 * NFO and artwork files for the libraries a media server reads beside the media (Sonarr's and Lidarr's metadata
 * consumers). The same functions run at import (importer.ts), for one title on demand (the "Write metadata files" button)
 * and for the whole library (the "Metadata Files" job), so a file is the same whichever way it was written.
 *
 * Rules that hold everywhere:
 *  - an NFO another tool wrote is never replaced, and a picture that is there is kept unless "overwrite" is on;
 *  - nothing is written into a read-only library or one whose share is not mounted;
 *  - a failure is counted and logged, never thrown: the import, the other files and the other titles carry on.
 */

type MediaItem = ReturnType<typeof mediaItemFromRow>;

export interface MetadataFilesReport {
  title: string;
  written: number;
  /** Files that were already there, another tool's NFOs that were left alone, and pictures no source was known for. */
  skipped: number;
  failed: number;
  /** The files written (base names, the first few). */
  files: string[];
  /** Why nothing was done, when the whole title was passed over. */
  reason?: string;
  /** "not-enabled": no file kind is switched on for this kind of title. */
  code?: "not-enabled" | "busy" | "unavailable" | "no-files";
}

/** Pauses that keep a library-wide run from hammering the disks and the metadata providers. Exported so a test can shorten them. */
export const metadataFilesPacing = { titleMs: 150, providerMs: 1000 };

const MAX_REPORTED_FILES = 40;
/** Episode stills fetched at once for one show. */
const EPISODE_IMAGE_CONCURRENCY = 3;
/** Failed provider lookups in a row after which a run stops asking providers for episode stills. */
const MAX_PROVIDER_FAILURES = 3;

class Tally {
  written = 0;
  skipped = 0;
  failed = 0;
  files: string[] = [];

  nfo(result: NfoWriteResult, file: string): void {
    if (result === "written") this.wrote(file);
    else if (result === "failed") this.failed++;
    else this.skipped++;
  }

  art(result: ArtworkResult): void {
    if (result.outcome === "written") this.wrote(result.file ?? "");
    else if (result.outcome === "failed") this.failed++;
    else this.skipped++;
  }

  private wrote(file: string): void {
    this.written++;
    if (this.files.length < MAX_REPORTED_FILES) this.files.push(path.basename(file));
  }
}

interface Ctx {
  row: any;
  item: MediaItem;
  options: MetadataFileOptions;
  signal?: AbortSignal;
  tally: Tally;
  /** NFO files are written only where there is none (a run over existing titles), not refreshed. */
  nfoOnlyIfMissing: boolean;
}

function parseIds(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {}; // malformed external_ids on an old row: written without unique ids
  }
}

function exportableOf(item: MediaItem): ExportableItem {
  return { type: item.type, title: item.title, year: item.year, overview: item.overview, posterUrl: item.posterUrl, externalIds: parseIds(item.externalIds) };
}

/** Only a real address can be fetched: AoNarr's own local-artwork route is a path on this server, not a source. */
function remoteUrl(url: unknown): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

function posterSource(row: any): ArtworkSource {
  return { localPath: row.local_poster_path ?? null, url: remoteUrl(row.poster_url) };
}

function backdropSource(row: any): ArtworkSource {
  return { localPath: row.local_backdrop_path ?? null, url: remoteUrl(row.backdrop_url) };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isUnder(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** At most `limit` of the tasks at a time; each task handles its own failures. */
async function mapLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The NFO that goes with a media file: its own name with .nfo. */
function nfoPathOf(file: string): string {
  return path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.nfo`);
}

function seasonPosterStem(season: number): string {
  return season === 0 ? "season-specials-poster" : `season${String(season).padStart(2, "0")}-poster`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Movies (single-file items)
// ---------------------------------------------------------------------------------------------------------------------

/** Whether the file's folder holds anything of another title, so that its pictures need the file's name to be told apart. */
async function folderIsShared(dir: string, rootPath: string, itemId: number): Promise<boolean> {
  if (path.resolve(dir) === path.resolve(rootPath)) return true;
  return (await trackedFileInside(dir, itemId)) !== null;
}

async function writeMovieImages(ctx: Ctx, file: string, rootPath: string): Promise<void> {
  const { options, row, tally } = ctx;
  if (!options.images || !options.posterFanart || !imagesApplyTo(ctx.item)) return;
  const dir = path.dirname(file);
  // "poster.jpg" in a folder of its own, "<name>-poster.jpg" beside the file when the folder is shared (Kodi and Plex read both).
  const base = path.basename(file, path.extname(file));
  const shared = await folderIsShared(dir, rootPath, ctx.item.id);
  const common = { overwrite: options.overwrite, signal: ctx.signal };
  tally.art(await writeArtworkFile(dir, shared ? `${base}-poster` : "poster", posterSource(row), { ...common, alsoCountsAs: shared ? [] : ["folder"] }));
  if (ctx.signal?.aborted) return;
  tally.art(await writeArtworkFile(dir, shared ? `${base}-fanart` : "fanart", backdropSource(row), { ...common, alsoCountsAs: shared ? [] : ["backdrop"] }));
}

async function writeMovieFiles(ctx: Ctx, rootPath: string, withNfo: boolean): Promise<void> {
  const file = ctx.item.path as string;
  if (withNfo) ctx.tally.nfo(writeNfoSidecar(file, exportableOf(ctx.item), { keepRicher: true, onlyIfMissing: ctx.nfoOnlyIfMissing }), nfoPathOf(file));
  await writeMovieImages(ctx, file, rootPath);
}

// ---------------------------------------------------------------------------------------------------------------------
// Shows and episodes
// ---------------------------------------------------------------------------------------------------------------------

interface EpisodeRow {
  id: number;
  season_number: number;
  episode_number: number;
  title: string | null;
  air_date: string | null;
  overview: string | null;
  file_path: string | null;
  thumb_url: string | null;
}

/** The show's folder: where its tvshow.nfo, poster and fanart go. */
async function showFolderOf(item: MediaItem, rootPath: string, files: string[]): Promise<string | null> {
  const stored = folderSegmentsOf(item.libraryFolder);
  let folder: string | null = null;
  if (stored) {
    const candidate = path.join(rootPath, ...stored);
    if (isDirectory(candidate)) folder = candidate;
  }
  if (!folder) {
    const template = namingTemplateOfType(item.type);
    for (const file of files.slice(0, 5)) {
      const candidate = ownFolderOf(file, [path.resolve(rootPath)], template);
      if (candidate && isDirectory(candidate)) {
        folder = candidate;
        break;
      }
    }
  }
  // A folder another title keeps files in is not this show's own: its poster would be that other show's too.
  if (folder && (await trackedFileInside(folder, item.id)) !== null) return null;
  return folder;
}

/** tvshow.nfo, poster.jpg, fanart.jpg and the season posters of a show's own folder. */
async function writeShowFolderFiles(ctx: Ctx, folder: string, seasons: number[], withNfo: boolean): Promise<void> {
  const { options, row, tally } = ctx;
  if (withNfo) tally.nfo(writeTvShowNfoIfMissing(folder, exportableOf(ctx.item), { overwrite: options.overwrite }), path.join(folder, "tvshow.nfo"));
  if (!options.images || !imagesApplyTo(ctx.item)) return;
  const common = { overwrite: options.overwrite, signal: ctx.signal };
  if (options.posterFanart) {
    tally.art(await writeArtworkFile(folder, "poster", posterSource(row), { ...common, alsoCountsAs: ["folder"] }));
    if (ctx.signal?.aborted) return;
    tally.art(await writeArtworkFile(folder, "fanart", backdropSource(row), { ...common, alsoCountsAs: ["backdrop"] }));
  }
  if (options.seasonPosters && seasons.length > 0) {
    const posters = (await db
      .prepare(`SELECT season_number, poster_url FROM seasons WHERE media_item_id = ? AND season_number IN (${seasons.map(() => "?").join(",")})`)
      .all(ctx.item.id, ...seasons)) as { season_number: number; poster_url: string | null }[];
    for (const season of posters) {
      if (ctx.signal?.aborted) return;
      tally.art(await writeArtworkFile(folder, seasonPosterStem(Number(season.season_number)), { url: remoteUrl(season.poster_url) }, common));
    }
  }
}

/** The NFO and the still of one episode file (which may cover several episodes). */
async function writeEpisodeFileFiles(ctx: Ctx, file: string, episodes: EpisodeRow[], withNfo: boolean): Promise<void> {
  const { options, tally } = ctx;
  if (withNfo) {
    const result = writeEpisodeNfoSidecar(
      file,
      episodes.map((e) => ({ showTitle: ctx.item.title, title: e.title, season: Number(e.season_number), episode: Number(e.episode_number), aired: e.air_date, overview: e.overview })),
      { onlyIfMissing: ctx.nfoOnlyIfMissing }
    );
    tally.nfo(result, nfoPathOf(file));
  }
  if (!options.images || !options.episodeThumbs || !imagesApplyTo(ctx.item)) return;
  const thumb = episodes.map((e) => remoteUrl(e.thumb_url)).find((url) => url);
  const stem = `${path.basename(file, path.extname(file))}-thumb`;
  tally.art(await writeArtworkFile(path.dirname(file), stem, { url: thumb ?? null }, { overwrite: options.overwrite, signal: ctx.signal }));
}

/** Episodes grouped by the file they are in. */
function groupByFile(rows: EpisodeRow[]): Map<string, EpisodeRow[]> {
  const groups = new Map<string, EpisodeRow[]>();
  for (const row of rows) {
    if (!row.file_path) continue;
    groups.set(row.file_path, [...(groups.get(row.file_path) ?? []), row]);
  }
  return groups;
}

/** State shared by the titles of one library-wide run, so a provider that fails is not asked about every show. */
interface RunState {
  providerFailures: number;
}

/**
 * Remembers the providers' stills for episodes that have none stored (shows added before stills were kept). One request
 * per show at most; a provider that fails several times in a run is left alone for the rest of it.
 */
async function fillEpisodeStills(ctx: Ctx, rows: EpisodeRow[], state: RunState | undefined): Promise<void> {
  if (rows.every((r) => r.thumb_url)) return;
  if (state && state.providerFailures >= MAX_PROVIDER_FAILURES) return;
  const ids = parseIds(ctx.item.externalIds);
  if (Object.keys(ids).length === 0) return;
  try {
    const listed = await fetchSeriesEpisodesFor(ids);
    if (state) state.providerFailures = 0;
    for (const ep of listed) {
      if (!ep.thumbUrl) continue;
      const row = rows.find((r) => Number(r.season_number) === ep.seasonNumber && Number(r.episode_number) === ep.episodeNumber);
      if (!row || row.thumb_url) continue;
      await db.prepare("UPDATE episodes SET thumb_url = ? WHERE id = ? AND thumb_url IS NULL").run(ep.thumbUrl, row.id);
      row.thumb_url = ep.thumbUrl;
    }
  } catch (err) {
    if (state) state.providerFailures++;
    log.warn(`[metadataFiles] episode pictures of "${ctx.item.title}" could not be looked up:`, (err as Error).message);
  }
  if (state && metadataFilesPacing.providerMs > 0) await new Promise((resolve) => setTimeout(resolve, metadataFilesPacing.providerMs));
}

async function writeShowFiles(ctx: Ctx, rootPath: string, state: RunState | undefined): Promise<string | null> {
  const rows = (await db
    .prepare("SELECT id, season_number, episode_number, title, air_date, overview, file_path, thumb_url FROM episodes WHERE media_item_id = ? AND has_file = 1 AND file_path IS NOT NULL ORDER BY season_number, episode_number")
    .all(ctx.item.id)) as EpisodeRow[];
  const present = rows.filter((r) => r.file_path && isFile(r.file_path) && isUnder(rootPath, r.file_path));
  if (present.length === 0) return "none of its episode files could be found on disk";
  const { options } = ctx;
  if (options.images && options.episodeThumbs && imagesApplyTo(ctx.item)) await fillEpisodeStills(ctx, present, state);

  const folder = await showFolderOf(ctx.item, rootPath, [...groupByFile(present).keys()]);
  if (folder) {
    await writeShowFolderFiles(ctx, folder, [...new Set(present.map((r) => Number(r.season_number)))], options.nfo.tv);
  }
  const groups = [...groupByFile(present)];
  await mapLimit(groups, EPISODE_IMAGE_CONCURRENCY, async ([file, episodes]) => {
    if (ctx.signal?.aborted) return;
    await writeEpisodeFileFiles(ctx, file, episodes, options.nfo.tv);
  });
  return folder ? null : "its folder is shared with another title, so only the episode files were written";
}

// ---------------------------------------------------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------------------------------------------------

interface AlbumRow {
  id: number;
  title: string;
  release_date: string | null;
  overview: string | null;
  external_id: string | null;
  external_provider: string | null;
  poster_url: string | null;
  file_path: string | null;
}

async function writeAlbumFolderFiles(ctx: Ctx, album: AlbumRow, folder: string): Promise<void> {
  const { options, tally } = ctx;
  if (options.nfo.music) {
    const tracks = (await db
      .prepare("SELECT track_number, title, duration_seconds FROM tracks WHERE sub_item_id = ? ORDER BY track_number")
      .all(album.id)) as { track_number: number; title: string; duration_seconds: number | null }[];
    const xml = buildAlbumNfo({
      title: album.title,
      artist: ctx.item.title,
      releaseDate: album.release_date,
      overview: album.overview,
      genres: ctx.item.genres,
      externalId: album.external_id,
      externalProvider: album.external_provider,
      posterUrl: album.poster_url,
      tracks: tracks.map((t) => ({ position: Number(t.track_number), title: t.title, durationSeconds: t.duration_seconds == null ? null : Number(t.duration_seconds) })),
    });
    tally.nfo(writeMusicNfo(folder, "album", xml, { overwrite: options.overwrite }), path.join(folder, "album.nfo"));
  }
  if (options.images && options.musicCover) {
    tally.art(await writeArtworkFile(folder, "folder", { url: remoteUrl(album.poster_url) }, { overwrite: options.overwrite, signal: ctx.signal, alsoCountsAs: ["cover"] }));
  }
}

async function writeArtistFolderFiles(ctx: Ctx, folder: string): Promise<void> {
  const { options, row, tally } = ctx;
  if (options.nfo.music) {
    const xml = buildArtistNfo({
      name: ctx.item.title,
      overview: ctx.item.overview,
      genres: ctx.item.genres,
      externalIds: parseIds(ctx.item.externalIds),
      posterUrl: ctx.item.posterUrl,
    });
    tally.nfo(writeMusicNfo(folder, "artist", xml, { overwrite: options.overwrite }), path.join(folder, "artist.nfo"));
  }
  if (options.images && options.musicCover) {
    const common = { overwrite: options.overwrite, signal: ctx.signal };
    tally.art(await writeArtworkFile(folder, "artist", posterSource(row), { ...common, alsoCountsAs: ["folder"] }));
    if (ctx.signal?.aborted) return;
    tally.art(await writeArtworkFile(folder, "fanart", backdropSource(row), { ...common, alsoCountsAs: ["backdrop"] }));
  }
}

async function writeMusicFiles(ctx: Ctx, rootPath: string): Promise<string | null> {
  const albums = (await db
    .prepare("SELECT id, title, release_date, overview, external_id, external_provider, poster_url, file_path FROM sub_items WHERE media_item_id = ? AND has_file = 1 AND file_path IS NOT NULL ORDER BY id")
    .all(ctx.item.id)) as AlbumRow[];
  const folders = albums.filter((a) => a.file_path && isDirectory(a.file_path) && isUnder(rootPath, a.file_path));
  if (folders.length === 0) return "none of its album folders could be found on disk";
  for (const album of folders) {
    if (ctx.signal?.aborted) return null;
    await writeAlbumFolderFiles(ctx, album, album.file_path as string);
  }
  const artistFolder = ownFolderOf(folders[0].file_path as string, [path.resolve(rootPath)], namingTemplateOfType(ctx.item.type), !!getMediaTypeConfig(ctx.item.type).multiFilePerChild);
  if (artistFolder && isDirectory(artistFolder) && (await trackedFileInside(artistFolder, ctx.item.id)) === null) {
    await writeArtistFolderFiles(ctx, artistFolder);
    return null;
  }
  return "its artist folder could not be told apart from another title's, so only the album folders were written";
}

// ---------------------------------------------------------------------------------------------------------------------
// One title, on demand or in a run
// ---------------------------------------------------------------------------------------------------------------------

const writing = new Set<number>();

export interface WriteTitleOptions {
  options?: MetadataFileOptions;
  signal?: AbortSignal;
  /** Shared by the titles of one library-wide run (see RunState). */
  state?: RunState;
}

/**
 * Writes the enabled kinds of metadata file for a title that already has files. NFO files are written where there is none
 * (with "overwrite" on, the ones AoNarr wrote are refreshed); pictures where none is. Never throws for a problem with a
 * file: it is counted in the report.
 */
export async function writeMetadataFilesForItem(itemId: number, opts: WriteTitleOptions = {}): Promise<MetadataFilesReport> {
  const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
  if (!row) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(row);
  const report = (extra: Partial<MetadataFilesReport> = {}): MetadataFilesReport => ({ title: item.title, written: 0, skipped: 0, failed: 0, files: [], ...extra });
  const options = opts.options ?? readMetadataFileOptions();
  if (!anythingEnabledFor(item, options)) {
    const label = getMediaTypeConfig(item.type).label;
    return report({
      code: "not-enabled",
      reason:
        metadataKindOf(item) === "other"
          ? `${label} get an NFO file only when a file is imported (Settings, Media Management, Write NFO on Import)`
          : `No metadata files are switched on for ${label}: choose them under Settings, Media Management, Metadata Files`,
    });
  }
  if (isTitleMoving(item.id) || writing.has(item.id)) return report({ code: "busy", reason: "It is being moved, renamed or written to right now: try again in a moment" });

  const root = item.rootFolderId == null ? undefined : ((await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId)) as any);
  if (!root) return report({ code: "unavailable", reason: "It has no root folder" });
  if (Number(root.read_only)) return report({ code: "unavailable", reason: `"${root.path}" is a read-only library: nothing is written into it` });
  const unmounted = await rootFolderUnmountedReason({ id: Number(root.id), path: root.path });
  if (unmounted) return report({ code: "unavailable", reason: unmounted });

  writing.add(item.id);
  try {
    const tally = new Tally();
    const ctx: Ctx = { row, item, options, signal: opts.signal, tally, nfoOnlyIfMissing: !options.overwrite };
    const kind: MetadataKind = metadataKindOf(item);
    let note: string | null = null;
    if (kind === "movie") {
      if (!Number(item.hasFile) || !item.path || !isFile(item.path)) note = "its file could not be found on disk";
      else if (!isUnder(root.path, item.path)) note = "its file is outside the root folder";
      else await writeMovieFiles(ctx, root.path, options.nfo.movie);
    } else if (kind === "tv") {
      note = await writeShowFiles(ctx, root.path, opts.state);
    } else if (kind === "music") {
      note = await writeMusicFiles(ctx, root.path);
    }
    const nothingDone = tally.written + tally.skipped + tally.failed === 0;
    return report({
      written: tally.written,
      skipped: tally.skipped,
      failed: tally.failed,
      files: tally.files,
      ...(note ? { reason: note[0].toUpperCase() + note.slice(1) } : {}),
      ...(nothingDone && note ? { code: "no-files" as const } : {}),
    });
  } finally {
    writing.delete(item.id);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The library-wide run
// ---------------------------------------------------------------------------------------------------------------------

export interface MetadataFilesRunSummary {
  titles: number;
  written: number;
  skipped: number;
  failed: number;
  titlesSkipped: number;
  cancelled: boolean;
}

/** The background-job entry the progress panel shows this run under. */
export const METADATA_FILES_JOB = { kind: "organize" as const, type: "metadata-files" };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Writes the enabled metadata files for every title that has files: the "Metadata Files" job. Titles go one at a time, with
 * a short pause after one that did any work, and a title that fails is counted and passed over. Stops between files when
 * cancelled. One summary line in the log.
 */
export async function runMetadataFilesJob(signal?: AbortSignal): Promise<MetadataFilesRunSummary> {
  const summary: MetadataFilesRunSummary = { titles: 0, written: 0, skipped: 0, failed: 0, titlesSkipped: 0, cancelled: false };
  const options = readMetadataFileOptions();
  const candidates = (await db.prepare("SELECT id, title, type, legacy_shape FROM media_items WHERE has_file = 1 ORDER BY id").all()) as {
    id: number;
    title: string;
    type: string;
    legacy_shape: string | null;
  }[];
  const titles = candidates.filter((c) => {
    try {
      return anythingEnabledFor({ type: c.type, legacyShape: c.legacy_shape }, options);
    } catch {
      return false; // a type this build does not know
    }
  });
  if (titles.length === 0) {
    log.info("[metadataFiles] library run: nothing to do (no file kind is switched on for a title that has files)");
    return summary;
  }

  let jobId: string | null = null;
  try {
    jobId = startBackgroundJob(METADATA_FILES_JOB.kind, METADATA_FILES_JOB.type, "Writing metadata files", titles.length);
  } catch {
    // already shown by an earlier run that is still listed
  }
  const state: RunState = { providerFailures: 0 };
  try {
    for (const title of titles) {
      if (signal?.aborted) {
        summary.cancelled = true;
        break;
      }
      try {
        const report = await writeMetadataFilesForItem(title.id, { options, signal, state });
        summary.titles++;
        summary.written += report.written;
        summary.skipped += report.skipped;
        summary.failed += report.failed;
        if (report.reason && report.written + report.skipped + report.failed === 0) summary.titlesSkipped++;
        if (report.failed > 0) log.warn(`[metadataFiles] "${title.title}": ${report.failed} file(s) could not be written`);
        if (report.written + report.failed > 0 && metadataFilesPacing.titleMs > 0) await sleep(metadataFilesPacing.titleMs);
      } catch (err) {
        summary.failed++;
        log.warn(`[metadataFiles] "${title.title}" failed:`, (err as Error).message);
      }
      if (jobId) incrementBackgroundJobDone(METADATA_FILES_JOB.kind, METADATA_FILES_JOB.type);
    }
  } finally {
    log.info(
      `[metadataFiles] library run${summary.cancelled ? " (cancelled)" : ""}: ${summary.titles} title(s), ${summary.written} file(s) written, ${summary.skipped} already there or without a source, ${summary.failed} failed, ${summary.titlesSkipped} title(s) passed over`
    );
    if (jobId) finishBackgroundJob(jobId, summary.failed > 0 ? `${summary.failed} file(s) could not be written, see the Logs page` : undefined);
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------------------------------
// Import hooks
// ---------------------------------------------------------------------------------------------------------------------

/** Runs `work`, logging a failure: a metadata file must never fail the import it follows. */
async function bestEffort(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    log.warn(`[metadataFiles] ${label} failed:`, (err as Error).message);
  }
}

async function importContext(itemId: number, options: MetadataFileOptions): Promise<Ctx | null> {
  const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
  if (!row) return null;
  return { row, item: mediaItemFromRow(row), options, tally: new Tally(), nfoOnlyIfMissing: false };
}

/** Artwork for a movie that was just imported. Its NFO is written by the importer itself. */
export async function writeImportedMovieFiles(args: { itemId: number; destPath: string; rootFolderPath: string }): Promise<void> {
  const options = readMetadataFileOptions();
  if (!options.images || !options.posterFanart) return;
  await bestEffort("poster and fanart after an import", async () => {
    const ctx = await importContext(args.itemId, options);
    if (ctx && imagesApplyTo(ctx.item)) await writeMovieImages(ctx, args.destPath, args.rootFolderPath);
  });
}

/**
 * The files of episodes that were just imported: the show's poster, fanart and season posters (once; they are kept once
 * there), each episode file's still and, for a season-pack import, which never wrote any, its NFO and the show's tvshow.nfo.
 */
export async function writeImportedEpisodeFiles(args: {
  itemId: number;
  rootFolderPath: string;
  /** The show's folder below the root folder, as the importer placed the first file; null when the naming has no folder of its own. */
  folderSegments: string[] | null;
  files: { dest: string; episodeIds: number[] }[];
  /** The importer's own NFO writer already ran for these files (a single episode). */
  nfoDone: boolean;
}): Promise<void> {
  const options = readMetadataFileOptions();
  const withNfo = !args.nfoDone && options.nfo.tv;
  const withImages = options.images && (options.posterFanart || options.seasonPosters || options.episodeThumbs);
  if (!withNfo && !withImages) return;
  await bestEffort("metadata files after an episode import", async () => {
    const ctx = await importContext(args.itemId, options);
    if (!ctx) return;
    const ids = args.files.flatMap((f) => f.episodeIds);
    if (ids.length === 0) return;
    const rows = (await db
      .prepare(`SELECT id, season_number, episode_number, title, air_date, overview, file_path, thumb_url FROM episodes WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY season_number, episode_number`)
      .all(...ids)) as EpisodeRow[];
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const folder = args.folderSegments && args.folderSegments.length > 0 ? path.join(args.rootFolderPath, ...args.folderSegments) : null;
    if (folder) await writeShowFolderFiles(ctx, folder, [...new Set(rows.map((r) => Number(r.season_number)))], withNfo);
    await mapLimit(args.files, EPISODE_IMAGE_CONCURRENCY, async ({ dest, episodeIds }) => {
      const episodes = episodeIds.map((id) => byId.get(id)).filter((r): r is EpisodeRow => !!r);
      if (episodes.length > 0) await writeEpisodeFileFiles(ctx, dest, episodes, withNfo);
    });
  });
}

/** The NFO and the cover of an album that was just imported, and the artist's own files in its folder. */
export async function writeImportedAlbumFiles(args: { itemId: number; subItemId: number; albumFolder: string; artistFolder: string | null }): Promise<void> {
  const options = readMetadataFileOptions();
  if (!options.nfo.music && !(options.images && options.musicCover)) return;
  await bestEffort("metadata files after an album import", async () => {
    const ctx = await importContext(args.itemId, options);
    // Audiobooks are placed by the same function but are not music: no album.nfo in a book's folder.
    if (!ctx || metadataKindOf(ctx.item) !== "music") return;
    const album = (await db
      .prepare("SELECT id, title, release_date, overview, external_id, external_provider, poster_url, file_path FROM sub_items WHERE id = ?")
      .get(args.subItemId)) as AlbumRow | undefined;
    if (album) await writeAlbumFolderFiles(ctx, album, args.albumFolder);
    // The artist's folder is its own only when it is neither the root folder nor a folder another artist's albums are in.
    if (args.artistFolder && (await trackedFileInside(args.artistFolder, ctx.item.id)) === null) await writeArtistFolderFiles(ctx, args.artistFolder);
  });
}
