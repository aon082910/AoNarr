import fs from "node:fs";
import path from "node:path";
import { db } from "../db/client.js";
import { getMediaTypeConfig, MEDIA_TYPE_KEYS } from "./mediaTypes.js";
import { rootFolderFromRow } from "../db/mappers.js";
import { parseReleaseTitle } from "./releaseParser.js";
import { probeMediaInfo } from "./ffprobe.js";
import { searchMetadata } from "./metadata.js";
import { log } from "./logger.js";

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titlesMatch(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Cuts a filename off at the first season/year/quality marker to get a plausible title —
 * the same "everything before the release metadata starts" heuristic release names use, just
 * applied to a plain filename instead of a scene-style release string. */
function guessTitleFromFilename(filenameNoExt: string): string {
  const normalized = filenameNoExt.replace(/[._]/g, " ");
  const cutPatterns = [
    /\bS\d{1,2}(E\d{1,3})?\b/i,
    /\b(19|20)\d{2}\b/,
    /\b(2160p|1080p|720p|bluray|blu-ray|web-?dl|webrip|hdtv|dvdrip|remux)\b/i,
  ];
  let cutIndex = normalized.length;
  for (const p of cutPatterns) {
    const m = normalized.match(p);
    if (m && m.index !== undefined && m.index < cutIndex) cutIndex = m.index;
  }
  // The cut lands right at the start of the matched marker (e.g. the "2" in "2015"), so whatever
  // separator introduced it — "(", "[", "-", a trailing "." — is still dangling at the end of the
  // slice (e.g. "45 Years (2015)" -> "45 Years ("). Strip that off along with surrounding spaces.
  return normalized
    .slice(0, cutIndex)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s([{-]+$/, "")
    .trim();
}

function walkForExtensions(dir: string, extensions: string[], knownPaths: Set<string>, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForExtensions(full, extensions, knownPaths, out);
    } else if (extensions.includes(path.extname(entry.name).toLowerCase()) && !knownPaths.has(full)) {
      out.push(full);
    }
  }
}

function defaultQualityProfileId(): number | null {
  const row = db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  return row?.id ?? null;
}

export interface ScanImportResult {
  matched: number;
  created: number;
  skipped: number;
  skippedFiles: string[];
  unsupported?: string;
}

/**
 * Scans a library type's root folder(s) for media files not already tracked by any media_item/
 * episode/sub_item, and imports them: matches an existing "missing" item by filename-guessed
 * title where possible (has_file=1 + path, same as a normal grab import), else creates a new
 * minimal item outright. Scoped to "single" and "episodic" shapes (movie/series/anime/rom/adult) —
 * "collection" shapes (books, comics, music, video channels, courses) need a parent item to file a
 * new child under, and blindly creating one from a single filename would misrepresent the
 * structure, so those are reported as unsupported rather than guessed at.
 */
export async function scanAndImportLibrary(type: string, signal?: AbortSignal): Promise<ScanImportResult> {
  const typeConfig = getMediaTypeConfig(type);
  const result: ScanImportResult = { matched: 0, created: 0, skipped: 0, skippedFiles: [] };
  if (typeConfig.shape === "collection") {
    result.unsupported = "Scan & import isn't supported for this library type yet — it needs an existing parent item to file new children under.";
    return result;
  }

  const folders = (db.prepare("SELECT * FROM root_folders WHERE media_type = ?").all(type) as any[]).map(rootFolderFromRow);
  if (folders.length === 0) return result;

  const knownPaths = new Set<string>([
    ...(db.prepare("SELECT path FROM media_items WHERE path IS NOT NULL AND type = ?").all(type) as { path: string }[]).map((r) => r.path),
    ...(
      db
        .prepare(
          `SELECT e.file_path FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.file_path IS NOT NULL AND m.type = ?`
        )
        .all(type) as { file_path: string }[]
    ).map((r) => r.file_path),
  ]);

  const files: string[] = [];
  for (const folder of folders) walkForExtensions(folder.path, typeConfig.extensions, knownPaths, files);

  const missingItems = db.prepare("SELECT * FROM media_items WHERE type = ? AND has_file = 0").all(type) as any[];
  const seriesItems = typeConfig.shape === "episodic" ? (db.prepare("SELECT * FROM media_items WHERE type = ?").all(type) as any[]) : [];
  const qualityProfileId = defaultQualityProfileId();

  for (const filePath of files) {
    if (signal?.aborted) break;
    const base = path.basename(filePath, path.extname(filePath));
    const guessedTitle = guessTitleFromFilename(base);
    if (!guessedTitle) {
      result.skipped++;
      result.skippedFiles.push(filePath);
      continue;
    }
    const parsed = parseReleaseTitle(base);
    const quality = parsed.quality === "Unknown" ? null : parsed.quality;

    try {
      if (typeConfig.shape === "episodic") {
        const seriesMatch = seriesItems.find((m) => titlesMatch(m.title, guessedTitle));
        if (!seriesMatch || parsed.seasonNumber === null || !parsed.episodeNumbers || parsed.episodeNumbers.length === 0) {
          result.skipped++;
          result.skippedFiles.push(filePath);
          continue;
        }
        const epNum = parsed.episodeNumbers[0];
        const mediaInfo = await probeMediaInfo(filePath);
        const mediaInfoJson = mediaInfo ? JSON.stringify(mediaInfo) : null;
        const existingEp = db
          .prepare("SELECT id FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number = ?")
          .get(seriesMatch.id, parsed.seasonNumber, epNum) as { id: number } | undefined;
        if (existingEp) {
          db.prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = ?, media_info = ? WHERE id = ?").run(
            filePath,
            quality,
            mediaInfoJson,
            existingEp.id
          );
        } else {
          db.prepare(
            `INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path, quality, media_info)
             VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`
          ).run(seriesMatch.id, parsed.seasonNumber, epNum, `Episode ${epNum}`, filePath, quality, mediaInfoJson);
        }
        result.matched++;
      } else {
        const match = missingItems.find((m) => titlesMatch(m.title, guessedTitle));
        const mediaInfo = await probeMediaInfo(filePath);
        const mediaInfoJson = mediaInfo ? JSON.stringify(mediaInfo) : null;
        if (match) {
          db.prepare("UPDATE media_items SET has_file = 1, path = ?, quality = ?, media_info = ? WHERE id = ?").run(
            filePath,
            quality,
            mediaInfoJson,
            match.id
          );
          match.has_file = 1;
          result.matched++;
        } else {
          const folder = folders.find((f) => filePath.startsWith(f.path));
          db.prepare(
            `INSERT INTO media_items (type, title, sort_title, year, path, root_folder_id, quality_profile_id, monitored, has_file, quality, media_info, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 'unknown')`
          ).run(type, guessedTitle, guessedTitle.toLowerCase(), parsed.year, filePath, folder?.id ?? null, qualityProfileId, quality, mediaInfoJson);
          result.created++;
        }
      }
    } catch (err) {
      log.warn(`[libraryScan] failed to import "${filePath}":`, (err as Error).message);
      result.skipped++;
      result.skippedFiles.push(filePath);
    }
  }

  return result;
}

/** Re-pulls overview/poster/year from the same metadata provider used at add-time for every item
 * of a type — the closest a title-only search API can get to "refresh," since there's no
 * fetch-by-id call generic enough to cover every provider this app supports. Never touches title
 * or external ids, only fields safe to overwrite with a fresher value. */
export async function refreshLibraryMetadata(type: string, signal?: AbortSignal): Promise<{ updated: number; failed: number }> {
  const items = db.prepare("SELECT * FROM media_items WHERE type = ?").all(type) as any[];
  let updated = 0;
  let failed = 0;

  for (const item of items) {
    if (signal?.aborted) break;
    try {
      const results = await searchMetadata(type as any, item.title);
      const best = results[0];
      if (!best) {
        failed++;
        continue;
      }
      db.prepare("UPDATE media_items SET overview = COALESCE(?, overview), poster_url = COALESCE(?, poster_url), year = COALESCE(?, year) WHERE id = ?").run(
        best.overview,
        best.posterUrl,
        best.year,
        item.id
      );
      updated++;
    } catch {
      failed++;
    }
  }

  return { updated, failed };
}

export async function scanAndImportAllLibraries(signal?: AbortSignal): Promise<void> {
  for (const type of MEDIA_TYPE_KEYS) {
    if (signal?.aborted) return;
    const result = await scanAndImportLibrary(type, signal);
    if (result.matched > 0 || result.created > 0) {
      log.info(`[libraryScan] "${type}": matched ${result.matched}, created ${result.created}, skipped ${result.skipped}`);
    }
  }
}

export async function refreshAllLibraries(signal?: AbortSignal): Promise<void> {
  for (const type of MEDIA_TYPE_KEYS) {
    if (signal?.aborted) return;
    const result = await refreshLibraryMetadata(type, signal);
    if (result.updated > 0) log.info(`[libraryScan] refreshed "${type}": ${result.updated} updated, ${result.failed} failed`);
  }
}
