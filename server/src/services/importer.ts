import { log } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { config } from "../config.js";
import { mediaItemFromRow, queueItemFromRow, rootFolderFromRow } from "../db/mappers.js";
import { notifyImported } from "./notifications.js";
import { notifyQueueChanged } from "./realtime.js";
import { parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode } from "./releaseParser.js";
import {
  downloadSubtitleContent,
  downloadSubtitleFromUrl,
  searchCustomSubtitles,
  searchSubtitles,
  type CustomSubtitleProviderConfig,
} from "./subtitleClient.js";
import { unpackDownloadedArchives } from "./archiveExtract.js";
import { DEFAULT_SHAPE_TEMPLATES, renderTemplate } from "./naming.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { getSetting } from "./settingsStore.js";
import { probeMediaInfo } from "./ffprobe.js";
import { recordGroupSuccess } from "./releaseGroupStats.js";
import { detectSeasonEpisode } from "./libraryScan.js";
import type { MediaType } from "../types/index.js";

// Shared across every "single"/"episodic" video library (Movies, TV Shows, Anime) so a just-moved
// file can be recognized as subtitle-eligible without hardcoding a type list.
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"]);

/** Best-effort: finds and saves a subtitle next to a just-imported video file. Never throws. */
async function tryDownloadSubtitle(videoPath: string, mediaItemId: number): Promise<void> {
  const provider = (await db.prepare("SELECT * FROM subtitle_providers WHERE enabled = 1 LIMIT 1").get()) as
    | { type: string; api_key: string | null; languages: string; config: string | null }
    | undefined;
  if (!provider) return;
  if (provider.type !== "custom" && !provider.api_key) return;

  try {
    const isCustom = provider.type === "custom";
    const results = isCustom
      ? await searchCustomSubtitles(
          JSON.parse(provider.config ?? "{}") as CustomSubtitleProviderConfig,
          provider.api_key,
          path.basename(videoPath),
          provider.languages
        )
      : await searchSubtitles(provider.api_key!, path.basename(videoPath), provider.languages);
    const best = isCustom ? results[0] : results.find((r) => r.fileId !== null);
    if (!best) return;

    const content = isCustom
      ? await downloadSubtitleFromUrl(best.downloadUrl)
      : await downloadSubtitleContent(provider.api_key!, best.fileId!);
    const srtPath = videoPath.slice(0, -path.extname(videoPath).length) + `.${best.language}.srt`;
    fs.writeFileSync(srtPath, content, "utf-8");

    await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'subtitleDownloaded', ?)`).run(
      mediaItemId,
      JSON.stringify({ srtPath, language: best.language })
    );
    log.info(`[importer] downloaded "${best.language}" subtitle for "${path.basename(videoPath)}"`);
  } catch (err) {
    log.warn(`[importer] subtitle download failed for "${videoPath}":`, (err as Error).message);
  }
}

function sanitizeForPath(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

/** Renders a naming template and splits it into sanitized path segments (template controls folder nesting via "/"). */
function renderPathSegments(template: string, vars: Record<string, string | number>): string[] {
  return renderTemplate(template, vars)
    .split("/")
    .map(sanitizeForPath)
    .filter(Boolean);
}

/** Per-type override (`naming<Type>Template` in settings) falling back to the shape's default. */
function getNamingTemplate(type: MediaType): string {
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  const override = getSetting(`naming${capitalized}Template`);
  if (override) return override;
  return DEFAULT_SHAPE_TEMPLATES[getMediaTypeConfig(type).shape];
}

/** `namingEnabled<Type>` in settings, defaulting to enabled — unset/missing means "on" so existing
 * installations (with no such key at all) keep their current templated-renaming behavior. */
function getNamingEnabled(type: MediaType): boolean {
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  return getSetting(`namingEnabled${capitalized}`) !== "0";
}

/** Builds the final destination from rendered template segments. When naming is disabled for this
 * type, the template's FOLDER structure still applies (still needed to keep episodes grouped
 * under their season, and to avoid dumping every file flat into one directory) — only the
 * filename itself is swapped for the sanitized original instead of the templated one. */
function resolveDest(
  rootFolderPath: string,
  segments: string[],
  ext: string,
  sourceFile: string,
  namingEnabled: boolean
): { destPath: string; fileLabel: string } {
  const folderSegments = segments.slice(0, -1);
  const fileLabel = namingEnabled
    ? `${segments[segments.length - 1]}${ext}`
    : `${sanitizeForPath(path.basename(sourceFile, path.extname(sourceFile)))}${ext}`;
  return { destPath: path.join(rootFolderPath, ...folderSegments, fileLabel), fileLabel };
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3);
}

interface FileCandidate {
  filePath: string;
  size: number;
  score: number;
}

/** Recursively walks the downloads directory (bounded depth) collecting files with a matching extension. */
function walk(dir: string, extensions: string[], maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(full, extensions, maxDepth, depth + 1));
    } else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
      found.push(full);
    }
  }
  return found;
}

function scoreByTokenOverlap(filePaths: string[], releaseTitle: string): FileCandidate[] {
  const wantedTokens = new Set(normalizeTokens(releaseTitle));
  return filePaths.map((filePath) => {
    const relative = path.relative(config.downloadsDir, filePath);
    const fileTokens = new Set(normalizeTokens(relative));
    let overlap = 0;
    for (const t of wantedTokens) if (fileTokens.has(t)) overlap++;
    const score = wantedTokens.size > 0 ? overlap / wantedTokens.size : 0;
    return { filePath, size: fs.statSync(filePath).size, score };
  });
}

/**
 * Finds the file in the shared downloads directory that best matches a release. This mirrors
 * how Sonarr/Radarr resolve a completed download to a file without needing direct
 * download-client filesystem APIs — it just needs the downloads folder to be visible to AoNarr.
 *
 * For episodic libraries, a season-pack download puts multiple episode files in one shared
 * folder, so several queue rows (one per grabbed episode) all resolve to files under the same
 * directory. When a target season/episode is given, candidates are first narrowed to files whose
 * own relative path parses to that specific episode (e.g. "...S01E05..." in the filename) so each
 * queue row picks its own file instead of racing the others for the top token-overlap score.
 * Falls back to plain token overlap when nothing parses that precisely (e.g. non-standard
 * per-episode release naming).
 */
export function findDownloadedFile(
  releaseTitle: string,
  mediaType: MediaType,
  target?: { season: number; episode: number } | { airDate: string }
): string | null {
  const extensions = getMediaTypeConfig(mediaType).extensions;
  const candidates = walk(config.downloadsDir, extensions, 4);
  if (candidates.length === 0) return null;

  if (target) {
    const episodeMatches = candidates.filter((filePath) => {
      const relative = path.relative(config.downloadsDir, filePath);
      const parsed = parseReleaseTitle(relative);
      return "airDate" in target ? releaseMatchesAirDate(parsed, target.airDate) : releaseMatchesEpisode(parsed, target.season, target.episode);
    });
    if (episodeMatches.length > 0) {
      const scored = scoreByTokenOverlap(episodeMatches, releaseTitle);
      scored.sort((a, b) => b.score - a.score || b.size - a.size);
      return scored[0].filePath;
    }
  }

  const scored = scoreByTokenOverlap(candidates, releaseTitle);
  scored.sort((a, b) => b.score - a.score || b.size - a.size);
  const best = scored[0];
  return best.score >= 0.4 ? best.filePath : null;
}

/**
 * Lists every file under the downloads directory whose extension matches the given media type,
 * newest-first, for the Activity page's manual-import picker — the same universe of files
 * `findDownloadedFile` searches, just without the fuzzy title match/score threshold, since a
 * manual pick means the admin is choosing by eye instead.
 */
export function listDownloadedFileCandidates(mediaType: MediaType): { path: string; size: number; mtimeMs: number }[] {
  const extensions = getMediaTypeConfig(mediaType).extensions;
  const candidates = walk(config.downloadsDir, extensions, 4);
  return candidates
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function moveFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err: any) {
    if (err.code !== "EXDEV") throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

export class ImportSkippedError extends Error {}

type EpisodeTarget = { season: number; episode: number } | { airDate: string };

/**
 * Moves a source file into the right root-folder location for a media item (and, for episodic/
 * collection types, its specific episode/sub-item), updates the DB, and notifies. Shared by both
 * the automatic post-download importer and the manual import endpoint. Handles "single" shape
 * (whole item is one file) and "collection" shape with a single file per child (Books, Comics,
 * Online Videos, Courses) — "collection" with multiple files per child (Music) goes through
 * `placeAlbumFiles` instead.
 */
export async function placeFile(params: {
  itemId: number;
  episodeId: number | null;
  subItemId: number | null;
  sourceFile: string;
  quality: string | null;
}): Promise<{ destPath: string; fileLabel: string }> {
  const { itemId, episodeId, subItemId, sourceFile, quality } = params;

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  if (!item.rootFolderId) {
    throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  }
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);

  const ext = path.extname(sourceFile);
  let destPath: string;
  let fileLabel: string;

  if (typeConfig.shape === "single") {
    const segments = renderPathSegments(getNamingTemplate(item.type), { title: item.title, year: item.year ?? "" });
    ({ destPath, fileLabel } = resolveDest(rootFolder.path, segments, ext, sourceFile, getNamingEnabled(item.type)));
  } else if (typeConfig.shape === "episodic" && episodeId) {
    const epRow = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId)) as any;
    if (!epRow) throw new Error(`Episode ${episodeId} not found`);
    // Running count across every season up to and including this episode — what anime naming
    // conventions call "absolute" numbering (e.g. episode 26 instead of S02E01), as an
    // alternative to {season}/{episode} in a custom naming template.
    // Season 0 (specials) is excluded from the running count — absolute numbering conventions
    // (AniDB, TVDB's absolute order, most anime release groups) start from season 1's episode 1,
    // not from whatever specials happen to sort before it.
    const absoluteEpisode = Number(
      (
        (await db
          .prepare(
            `SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND season_number > 0
           AND (season_number < ? OR (season_number = ? AND episode_number <= ?))`
          )
          .get(epRow.media_item_id, epRow.season_number, epRow.season_number, epRow.episode_number)) as { c: number }
      ).c
    );
    const segments = renderPathSegments(getNamingTemplate(item.type), {
      parentTitle: item.title,
      season: epRow.season_number,
      episode: epRow.episode_number,
      absoluteEpisode,
      airDate: epRow.air_date ?? "",
    });
    ({ destPath, fileLabel } = resolveDest(rootFolder.path, segments, ext, sourceFile, getNamingEnabled(item.type)));
  } else if (typeConfig.shape === "collection" && subItemId && !typeConfig.multiFilePerChild) {
    const subRow = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId)) as any;
    if (!subRow) throw new Error(`Sub-item ${subItemId} not found`);
    const segments = renderPathSegments(getNamingTemplate(item.type), {
      parentTitle: item.title,
      childTitle: subRow.title,
    });
    ({ destPath, fileLabel } = resolveDest(rootFolder.path, segments, ext, sourceFile, getNamingEnabled(item.type)));
  } else {
    throw new ImportSkippedError(
      `Don't know how to place a file for media type "${item.type}" without a linked episode/sub-item`
    );
  }

  moveFile(sourceFile, destPath);

  if (VIDEO_EXTENSIONS.has(ext.toLowerCase()) && (typeConfig.shape === "single" || typeConfig.shape === "episodic")) {
    await tryDownloadSubtitle(destPath, item.id);
  }

  const mediaInfo = await probeMediaInfo(destPath);
  const mediaInfoJson = mediaInfo ? JSON.stringify(mediaInfo) : null;

  if (typeConfig.shape === "single") {
    await db.prepare("UPDATE media_items SET has_file = 1, path = ?, quality = ?, media_info = ? WHERE id = ?").run(
      destPath,
      quality,
      mediaInfoJson,
      item.id
    );
  } else if (episodeId) {
    await db.prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = ?, media_info = ? WHERE id = ?").run(
      destPath,
      quality,
      mediaInfoJson,
      episodeId
    );
  } else if (subItemId) {
    await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ?, quality = ?, media_info = ? WHERE id = ?").run(
      destPath,
      quality,
      mediaInfoJson,
      subItemId
    );
  }

  await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'imported', ?)`).run(
    item.id,
    JSON.stringify({ fileLabel, destPath })
  );

  await notifyImported(item.title, fileLabel, destPath);
  log.info(`[importer] imported "${fileLabel}" for "${item.title}"`);
  return { destPath, fileLabel };
}

/**
 * For "collection" libraries where a child's download normally contains many files rather than
 * one (currently just Music: an album download has one file per track) — moves every sibling
 * file next to the best-matched anchor file, not just that one file. Each moved file is matched
 * to a track (if the track list has been fetched) by a leading number in its filename, e.g.
 * "04 - Song.mp3".
 */
export async function placeAlbumFiles(params: {
  itemId: number;
  subItemId: number;
  anchorFile: string;
  quality: string | null;
}): Promise<{ destFolder: string; fileCount: number }> {
  const { itemId, subItemId, anchorFile, quality } = params;

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  if (!item.rootFolderId) throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);

  const subRow = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId)) as any;
  if (!subRow) throw new Error(`Sub-item ${subItemId} not found`);

  const sourceDir = path.dirname(anchorFile);
  // Music's individual track filenames are always kept as-downloaded (see the per-file loop
  // below) — there's no separate "filename" to bypass independently the way single/episodic have,
  // so for this shape the album FOLDER is the naming toggle's equivalent of a filename: the
  // artist folder from the template still applies (avoids dumping every album flat), but the
  // album folder itself reverts to the source download's own folder name when disabled.
  const templatedSegments = renderPathSegments(getNamingTemplate(item.type), {
    parentTitle: item.title,
    childTitle: subRow.title,
  });
  const parentFolderSegments = templatedSegments.slice(0, -1);
  const albumFolderName = getNamingEnabled(item.type)
    ? templatedSegments[templatedSegments.length - 1]
    : sanitizeForPath(path.basename(sourceDir));
  const destFolder = path.join(rootFolder.path, ...parentFolderSegments, albumFolderName);
  const siblings = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((e) => e.isFile() && typeConfig.extensions.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(sourceDir, e.name));

  const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ?").all(subItemId)) as any[];

  let movedCount = 0;
  for (const src of siblings) {
    const fileName = sanitizeForPath(path.basename(src));
    const dest = path.join(destFolder, fileName);
    moveFile(src, dest);
    movedCount++;

    const leadingNumber = path.basename(src).match(/^(\d{1,3})/);
    if (leadingNumber && tracks.length > 0) {
      const track = tracks.find((t) => t.track_number === Number(leadingNumber[1]));
      if (track) await db.prepare("UPDATE tracks SET has_file = 1, file_path = ? WHERE id = ?").run(dest, track.id);
    }
  }

  const anchorDest = path.join(destFolder, sanitizeForPath(path.basename(anchorFile)));
  const mediaInfo = movedCount > 0 ? await probeMediaInfo(anchorDest) : null;

  await db.prepare("UPDATE sub_items SET has_file = ?, file_path = ?, quality = ?, media_info = ? WHERE id = ?").run(
    movedCount > 0 ? 1 : 0,
    destFolder,
    quality,
    mediaInfo ? JSON.stringify(mediaInfo) : null,
    subItemId
  );
  await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'imported', ?)`).run(
    item.id,
    JSON.stringify({ destFolder, fileCount: movedCount })
  );

  await notifyImported(item.title, `${movedCount} file(s) into ${path.basename(destFolder)}`, destFolder);
  log.info(`[importer] imported ${movedCount} file(s) into "${path.basename(destFolder)}" for "${item.title}"`);
  return { destFolder, fileCount: movedCount };
}

/**
 * Imports a full-season pack download — a folder with one video file per episode, no single
 * episodeId to place against. Same "walk every sibling file next to the anchor" shape as
 * placeAlbumFiles, but maps each file to an episode by parsing it (reusing the same folder-aware
 * detection scan-import uses) instead of a leading track number. A file whose parsed episode
 * number doesn't match any known episode of the target season is left in place rather than moved
 * blind — better to leave one file for manual handling than silently misplace it.
 */
export async function placeSeasonPackFiles(params: {
  itemId: number;
  seasonNumber: number;
  anchorFile: string;
  quality: string | null;
}): Promise<{ destFolder: string; episodeCount: number }> {
  const { itemId, seasonNumber, anchorFile, quality } = params;

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  if (!item.rootFolderId) throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);

  const sourceDir = path.dirname(anchorFile);
  const siblings = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((e) => e.isFile() && typeConfig.extensions.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(sourceDir, e.name));

  const episodes = (await db
    .prepare("SELECT * FROM episodes WHERE media_item_id = ? AND season_number = ?")
    .all(itemId, seasonNumber)) as any[];
  const sourceDirName = path.basename(sourceDir);

  let importedCount = 0;
  let destFolder = "";
  for (const src of siblings) {
    const base = path.basename(src, path.extname(src));
    const detected = detectSeasonEpisode(sourceDirName, base);
    // A season pack's own folder name (e.g. "Show.S01.1080p.WEB-DL") won't itself look like a
    // "Season NN" folder to detectSeasonEpisode, so a file with no season of its own (e.g. a bare
    // "01.mkv") falls back to assuming it belongs to the season this whole download is for.
    const episodeNumber = detected.season === null || detected.season === seasonNumber ? detected.episode : null;
    const targetEpisode = episodeNumber !== null ? episodes.find((e) => e.episode_number === episodeNumber) : undefined;
    if (!targetEpisode) {
      log.warn(`[importer] couldn't match "${path.basename(src)}" to a known episode of season ${seasonNumber} for "${item.title}" — left in place`);
      continue;
    }

    // Season 0 (specials) is excluded from the running count — see the identical comment in
    // placeFile() above.
    const absoluteEpisode = Number(
      (
        (await db
          .prepare(
            `SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND season_number > 0
           AND (season_number < ? OR (season_number = ? AND episode_number <= ?))`
          )
          .get(itemId, seasonNumber, seasonNumber, episodeNumber)) as { c: number }
      ).c
    );
    const segments = renderPathSegments(getNamingTemplate(item.type), {
      parentTitle: item.title,
      season: seasonNumber,
      episode: episodeNumber as number,
      absoluteEpisode,
    });
    const ext = path.extname(src);
    const { destPath: dest } = resolveDest(rootFolder.path, segments, ext, src, getNamingEnabled(item.type));
    destFolder = path.dirname(dest);
    moveFile(src, dest);

    if (VIDEO_EXTENSIONS.has(ext.toLowerCase())) await tryDownloadSubtitle(dest, item.id);
    const mediaInfo = await probeMediaInfo(dest);
    await db.prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = ?, media_info = ? WHERE id = ?").run(
      dest,
      quality,
      mediaInfo ? JSON.stringify(mediaInfo) : null,
      targetEpisode.id
    );
    importedCount++;
  }

  if (importedCount === 0) {
    throw new ImportSkippedError(`No files in this download could be matched to a known episode of season ${seasonNumber}`);
  }

  await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'imported', ?)`).run(
    item.id,
    JSON.stringify({ seasonNumber, episodeCount: importedCount })
  );
  await notifyImported(item.title, `season ${seasonNumber} pack — ${importedCount} episode(s)`, destFolder);
  log.info(`[importer] imported season ${seasonNumber} pack for "${item.title}": ${importedCount} episode(s)`);
  return { destFolder, episodeCount: importedCount };
}

/**
 * Locates, moves, and links the downloaded file(s) for a completed queue entry. Throws on failure.
 * `manualSourceFile`, when given, skips the automatic `findDownloadedFile` fuzzy match entirely and
 * uses that exact path instead — the manual-import path (Activity page) for a file the automatic
 * matcher couldn't find or picked wrong; it's the admin's own explicit choice at that point, so no
 * confidence threshold applies the way it does for the automatic match.
 */
export async function importQueueItem(queueItemId: number, manualSourceFile?: string): Promise<void> {
  const queueRow = await db.prepare("SELECT * FROM queue WHERE id = ?").get(queueItemId);
  if (!queueRow) throw new Error(`Queue item ${queueItemId} not found`);
  const queueItem = queueItemFromRow(queueRow);

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(queueItem.mediaItemId);
  if (!mediaRow) throw new Error(`Media item ${queueItem.mediaItemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  let episodeTarget: EpisodeTarget | undefined;
  if (typeConfig.shape === "episodic" && queueItem.episodeId) {
    const epRow = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(queueItem.episodeId)) as any;
    if (!epRow) throw new Error(`Episode ${queueItem.episodeId} not found`);
    episodeTarget = item.seriesType === "daily" && epRow.air_date
      ? { airDate: epRow.air_date }
      : { season: epRow.season_number, episode: epRow.episode_number };
  }

  let sourceFile: string | null;
  if (manualSourceFile) {
    const resolvedDownloadsDir = path.resolve(config.downloadsDir);
    const resolved = path.resolve(manualSourceFile);
    if (resolved !== resolvedDownloadsDir && !resolved.startsWith(resolvedDownloadsDir + path.sep)) {
      throw new Error("Selected file must be inside the downloads directory");
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error("Selected file no longer exists");
    }
    sourceFile = resolved;
  } else {
    await unpackDownloadedArchives();
    sourceFile = findDownloadedFile(queueItem.title, item.type, episodeTarget);
  }
  if (!sourceFile) {
    throw new Error(`No matching file found in downloads directory for "${queueItem.title}"`);
  }

  if (typeConfig.shape === "collection" && typeConfig.multiFilePerChild && queueItem.subItemId) {
    await placeAlbumFiles({
      itemId: item.id,
      subItemId: queueItem.subItemId,
      anchorFile: sourceFile,
      quality: queueItem.quality,
    });
  } else if (typeConfig.shape === "episodic" && !queueItem.episodeId && queueItem.seasonNumber) {
    await placeSeasonPackFiles({
      itemId: item.id,
      seasonNumber: queueItem.seasonNumber,
      anchorFile: sourceFile,
      quality: queueItem.quality,
    });
  } else {
    await placeFile({
      itemId: item.id,
      episodeId: queueItem.episodeId,
      subItemId: queueItem.subItemId,
      sourceFile,
      quality: queueItem.quality,
    });
  }

  await db.prepare(`UPDATE queue SET status = 'imported', updated_at = ${nowExpr(db)} WHERE id = ?`).run(queueItemId);
  notifyQueueChanged();
  await recordGroupSuccess(parseReleaseTitle(queueItem.title).releaseGroup);
}

/** Removes now-empty directories left behind by a rename, walking upward from a file's old folder
 * but never touching the root folder itself or anything above it. */
function removeEmptyParents(dir: string, rootFolderPath: string): void {
  const resolvedRoot = path.resolve(rootFolderPath);
  let current = path.resolve(dir);
  while (current !== resolvedRoot && current.startsWith(resolvedRoot + path.sep)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

export interface RenameResult {
  renamed: { title: string; from: string; to: string }[];
  errors: { title: string; error: string }[];
  skippedMusic: number;
}

/**
 * Retroactively re-renames every already-imported file for items whose naming template has
 * changed since they were imported — Sonarr/Radarr's "Rename Files" bulk action. Never touches
 * anything without a file yet, and only actually moves a file when the freshly-computed
 * destination differs from where it already is. Music (multiFilePerChild) is deliberately skipped
 * — its individual track filenames are always kept as-downloaded rather than templated (see
 * placeAlbumFiles), so a template change there would only affect the album folder name, a
 * different and riskier operation (renaming a folder full of files with no per-file destination
 * to verify against) than this function's per-file model handles; the count is still reported so
 * a caller isn't left thinking Music was silently included.
 */
export async function renameLibraryFiles(mediaType?: MediaType): Promise<RenameResult> {
  const result: RenameResult = { renamed: [], errors: [], skippedMusic: 0 };

  const itemRows = (
    mediaType
      ? await db.prepare("SELECT * FROM media_items WHERE type = ?").all(mediaType)
      : await db.prepare("SELECT * FROM media_items").all()
  ) as any[];

  for (const mediaRow of itemRows) {
    const item = mediaItemFromRow(mediaRow);
    const typeConfig = getMediaTypeConfig(item.type);
    if (!item.rootFolderId) continue;
    const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
    if (!folderRow) continue;
    const rootFolder = rootFolderFromRow(folderRow);
    const namingEnabled = getNamingEnabled(item.type);
    const template = getNamingTemplate(item.type);

    try {
      if (typeConfig.shape === "single") {
        if (!item.hasFile || !item.path) continue;
        const ext = path.extname(item.path);
        const segments = renderPathSegments(template, { title: item.title, year: item.year ?? "" });
        const { destPath } = resolveDest(rootFolder.path, segments, ext, item.path, namingEnabled);
        if (path.resolve(destPath) === path.resolve(item.path)) continue;
        const oldDir = path.dirname(item.path);
        moveFile(item.path, destPath);
        removeEmptyParents(oldDir, rootFolder.path);
        await db.prepare("UPDATE media_items SET path = ? WHERE id = ?").run(destPath, item.id);
        result.renamed.push({ title: item.title, from: item.path, to: destPath });
      } else if (typeConfig.shape === "episodic") {
        const episodes = (await db
          .prepare("SELECT * FROM episodes WHERE media_item_id = ? AND has_file = 1 AND file_path IS NOT NULL")
          .all(item.id)) as any[];
        for (const epRow of episodes) {
          const ext = path.extname(epRow.file_path);
          const absoluteEpisode = Number(
            (
              (await db
                .prepare(
                  `SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND season_number > 0
                 AND (season_number < ? OR (season_number = ? AND episode_number <= ?))`
                )
                .get(item.id, epRow.season_number, epRow.season_number, epRow.episode_number)) as { c: number }
            ).c
          );
          const segments = renderPathSegments(template, {
            parentTitle: item.title,
            season: epRow.season_number,
            episode: epRow.episode_number,
            absoluteEpisode,
            airDate: epRow.air_date ?? "",
          });
          const { destPath } = resolveDest(rootFolder.path, segments, ext, epRow.file_path, namingEnabled);
          if (path.resolve(destPath) === path.resolve(epRow.file_path)) continue;
          const oldDir = path.dirname(epRow.file_path);
          moveFile(epRow.file_path, destPath);
          removeEmptyParents(oldDir, rootFolder.path);
          await db.prepare("UPDATE episodes SET file_path = ? WHERE id = ?").run(destPath, epRow.id);
          result.renamed.push({ title: `${item.title} — ${epRow.season_number}x${epRow.episode_number}`, from: epRow.file_path, to: destPath });
        }
      } else if (typeConfig.shape === "collection" && typeConfig.multiFilePerChild) {
        const count = (await db.prepare("SELECT COUNT(*) AS c FROM sub_items WHERE media_item_id = ? AND has_file = 1").get(item.id)) as {
          c: number;
        };
        result.skippedMusic += count.c;
      } else if (typeConfig.shape === "collection") {
        const subItems = (await db
          .prepare("SELECT * FROM sub_items WHERE media_item_id = ? AND has_file = 1 AND file_path IS NOT NULL")
          .all(item.id)) as any[];
        for (const subRow of subItems) {
          const ext = path.extname(subRow.file_path);
          const segments = renderPathSegments(template, { parentTitle: item.title, childTitle: subRow.title });
          const { destPath } = resolveDest(rootFolder.path, segments, ext, subRow.file_path, namingEnabled);
          if (path.resolve(destPath) === path.resolve(subRow.file_path)) continue;
          const oldDir = path.dirname(subRow.file_path);
          moveFile(subRow.file_path, destPath);
          removeEmptyParents(oldDir, rootFolder.path);
          await db.prepare("UPDATE sub_items SET file_path = ? WHERE id = ?").run(destPath, subRow.id);
          result.renamed.push({ title: `${item.title} — ${subRow.title}`, from: subRow.file_path, to: destPath });
        }
      }
    } catch (err) {
      result.errors.push({ title: item.title, error: (err as Error).message });
      log.warn(`[importer] rename failed for "${item.title}":`, (err as Error).message);
    }
  }

  if (result.renamed.length > 0) {
    log.info(`[importer] renamed ${result.renamed.length} file(s) to match the current naming template`);
  }
  return result;
}
