import { log } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/client.js";
import { config } from "../config.js";
import { mediaItemFromRow, queueItemFromRow, rootFolderFromRow } from "../db/mappers.js";
import { notifyImported } from "./notifications.js";
import { parseReleaseTitle, releaseMatchesEpisode } from "./releaseParser.js";
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
import type { MediaType } from "../types/index.js";

// Shared across every "single"/"episodic" video library (Movies, TV Shows, Anime) so a just-moved
// file can be recognized as subtitle-eligible without hardcoding a type list.
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"]);

/** Best-effort: finds and saves a subtitle next to a just-imported video file. Never throws. */
async function tryDownloadSubtitle(videoPath: string, mediaItemId: number): Promise<void> {
  const provider = db.prepare("SELECT * FROM subtitle_providers WHERE enabled = 1 LIMIT 1").get() as
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

    db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'subtitleDownloaded', ?)`).run(
      mediaItemId,
      JSON.stringify({ srtPath, language: best.language })
    );
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
  target?: { season: number; episode: number }
): string | null {
  const extensions = getMediaTypeConfig(mediaType).extensions;
  const candidates = walk(config.downloadsDir, extensions, 4);
  if (candidates.length === 0) return null;

  if (target) {
    const episodeMatches = candidates.filter((filePath) => {
      const relative = path.relative(config.downloadsDir, filePath);
      return releaseMatchesEpisode(parseReleaseTitle(relative), target.season, target.episode);
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

interface EpisodeTarget {
  season: number;
  episode: number;
}

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

  const mediaRow = db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  if (!item.rootFolderId) {
    throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  }
  const folderRow = db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);

  const ext = path.extname(sourceFile);
  let destPath: string;
  let fileLabel: string;

  if (typeConfig.shape === "single") {
    const segments = renderPathSegments(getNamingTemplate(item.type), { title: item.title, year: item.year ?? "" });
    fileLabel = `${segments[segments.length - 1]}${ext}`;
    destPath = path.join(rootFolder.path, ...segments) + ext;
  } else if (typeConfig.shape === "episodic" && episodeId) {
    const epRow = db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId) as any;
    if (!epRow) throw new Error(`Episode ${episodeId} not found`);
    // Running count across every season up to and including this episode — what anime naming
    // conventions call "absolute" numbering (e.g. episode 26 instead of S02E01), as an
    // alternative to {season}/{episode} in a custom naming template.
    const absoluteEpisode = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ?
           AND (season_number < ? OR (season_number = ? AND episode_number <= ?))`
        )
        .get(epRow.media_item_id, epRow.season_number, epRow.season_number, epRow.episode_number) as { c: number }
    ).c;
    const segments = renderPathSegments(getNamingTemplate(item.type), {
      parentTitle: item.title,
      season: epRow.season_number,
      episode: epRow.episode_number,
      absoluteEpisode,
    });
    fileLabel = `${segments[segments.length - 1]}${ext}`;
    destPath = path.join(rootFolder.path, ...segments) + ext;
  } else if (typeConfig.shape === "collection" && subItemId && !typeConfig.multiFilePerChild) {
    const subRow = db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId) as any;
    if (!subRow) throw new Error(`Sub-item ${subItemId} not found`);
    const segments = renderPathSegments(getNamingTemplate(item.type), {
      parentTitle: item.title,
      childTitle: subRow.title,
    });
    fileLabel = `${segments[segments.length - 1]}${ext}`;
    destPath = path.join(rootFolder.path, ...segments) + ext;
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
    db.prepare("UPDATE media_items SET has_file = 1, path = ?, quality = ?, media_info = ? WHERE id = ?").run(
      destPath,
      quality,
      mediaInfoJson,
      item.id
    );
  } else if (episodeId) {
    db.prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = ?, media_info = ? WHERE id = ?").run(
      destPath,
      quality,
      mediaInfoJson,
      episodeId
    );
  } else if (subItemId) {
    db.prepare("UPDATE sub_items SET has_file = 1, file_path = ?, quality = ?, media_info = ? WHERE id = ?").run(
      destPath,
      quality,
      mediaInfoJson,
      subItemId
    );
  }

  db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'imported', ?)`).run(
    item.id,
    JSON.stringify({ fileLabel, destPath })
  );

  await notifyImported(item.title, fileLabel);
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

  const mediaRow = db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  if (!item.rootFolderId) throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  const folderRow = db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);

  const subRow = db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId) as any;
  if (!subRow) throw new Error(`Sub-item ${subItemId} not found`);

  const folderSegments = renderPathSegments(getNamingTemplate(item.type), {
    parentTitle: item.title,
    childTitle: subRow.title,
  });
  const destFolder = path.join(rootFolder.path, ...folderSegments);

  const sourceDir = path.dirname(anchorFile);
  const siblings = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((e) => e.isFile() && typeConfig.extensions.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(sourceDir, e.name));

  const tracks = db.prepare("SELECT * FROM tracks WHERE sub_item_id = ?").all(subItemId) as any[];

  let movedCount = 0;
  for (const src of siblings) {
    const fileName = sanitizeForPath(path.basename(src));
    const dest = path.join(destFolder, fileName);
    moveFile(src, dest);
    movedCount++;

    const leadingNumber = path.basename(src).match(/^(\d{1,3})/);
    if (leadingNumber && tracks.length > 0) {
      const track = tracks.find((t) => t.track_number === Number(leadingNumber[1]));
      if (track) db.prepare("UPDATE tracks SET has_file = 1, file_path = ? WHERE id = ?").run(dest, track.id);
    }
  }

  const anchorDest = path.join(destFolder, sanitizeForPath(path.basename(anchorFile)));
  const mediaInfo = movedCount > 0 ? await probeMediaInfo(anchorDest) : null;

  db.prepare("UPDATE sub_items SET has_file = ?, file_path = ?, quality = ?, media_info = ? WHERE id = ?").run(
    movedCount > 0 ? 1 : 0,
    destFolder,
    quality,
    mediaInfo ? JSON.stringify(mediaInfo) : null,
    subItemId
  );
  db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'imported', ?)`).run(
    item.id,
    JSON.stringify({ destFolder, fileCount: movedCount })
  );

  await notifyImported(item.title, `${movedCount} file(s) into ${path.basename(destFolder)}`);
  return { destFolder, fileCount: movedCount };
}

/** Locates, moves, and links the downloaded file(s) for a completed queue entry. Throws on failure. */
export async function importQueueItem(queueItemId: number): Promise<void> {
  const queueRow = db.prepare("SELECT * FROM queue WHERE id = ?").get(queueItemId);
  if (!queueRow) throw new Error(`Queue item ${queueItemId} not found`);
  const queueItem = queueItemFromRow(queueRow);

  const mediaRow = db.prepare("SELECT * FROM media_items WHERE id = ?").get(queueItem.mediaItemId);
  if (!mediaRow) throw new Error(`Media item ${queueItem.mediaItemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  let episodeTarget: EpisodeTarget | undefined;
  if (typeConfig.shape === "episodic" && queueItem.episodeId) {
    const epRow = db.prepare("SELECT * FROM episodes WHERE id = ?").get(queueItem.episodeId) as any;
    if (!epRow) throw new Error(`Episode ${queueItem.episodeId} not found`);
    episodeTarget = { season: epRow.season_number, episode: epRow.episode_number };
  }

  await unpackDownloadedArchives();
  const sourceFile = findDownloadedFile(queueItem.title, item.type, episodeTarget);
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
  } else {
    await placeFile({
      itemId: item.id,
      episodeId: queueItem.episodeId,
      subItemId: queueItem.subItemId,
      sourceFile,
      quality: queueItem.quality,
    });
  }

  db.prepare("UPDATE queue SET status = 'imported', updated_at = datetime('now') WHERE id = ?").run(queueItemId);
  recordGroupSuccess(parseReleaseTitle(queueItem.title).releaseGroup);
}
