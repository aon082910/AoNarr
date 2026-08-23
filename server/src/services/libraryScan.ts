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

/** Cuts a piece of text off at the first season/year/quality marker to get a plausible title —
 * the same "everything before the release metadata starts" heuristic release names use, just
 * applied to a plain filename (or folder name) instead of a scene-style release string. */
function guessTitleFromText(text: string): string {
  const normalized = text.replace(/[._]/g, " ");
  const cutPatterns = [
    /\bS\d{1,2}(E\d{1,3})?\b/i,
    /\b\d{1,2}x\d{1,3}\b/i, // "1x02"
    /\bE\d{1,3}\b/i, // bare "E03" — a season-folder-relative episode file with no series name at all
    /\b(19|20)\d{2}\b/,
    /\b(2160p|1080p|720p|480p|bluray|blu-ray|web-?dl|webrip|hdtv|dvdrip|brrip|remux)\b/i,
    /\b(x264|x265|h264|h265|hevc|xvid|divx)\b/i,
    /\b(aac|ac3|dts|atmos|ddp?5\s?1|truehd)\b/i,
    /\b(proper|repack|extended|unrated|directors?\s?cut|imax)\b/i,
    /\bimdb-tt\d+\b/i,
    /\btmdb-\d+\b/i,
    /\btvdb-\d+\b/i,
  ];
  let cutIndex = normalized.length;
  for (const p of cutPatterns) {
    const m = normalized.match(p);
    if (m && m.index !== undefined && m.index < cutIndex) cutIndex = m.index;
  }
  // The cut lands right at the start of the matched marker (e.g. the "2" in "2015"), so whatever
  // separator introduced it — "(", "[", "-", a trailing "." — is still dangling at the end of the
  // slice (e.g. "45 Years (2015)" -> "45 Years ("). Strip that off, along with any other trailing
  // punctuation left over from the cut (not just the exact separator immediately before the
  // marker — a stray unmatched "(" or "[" earlier in the leftover text can otherwise survive too).
  return normalized
    .slice(0, cutIndex)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s([{.,:;_-]+$/, "")
    .trim();
}

const SEASON_FOLDER = /^season\s*0*(\d{1,3})$|^s0*(\d{1,3})$/i;
const EPISODE_X_FORMAT = /\b0*(\d{1,2})x0*(\d{1,3})\b/i; // "1x01"
const EPISODE_ONLY = /\bE0*(\d{1,3})\b/i;

/**
 * Real TV libraries very often only carry the series name in the folder structure (e.g.
 * `Series Name/Season 01/S01E01.mkv`, sometimes even just `Series Name/Season 01/01.mkv`) rather
 * than repeating it — and the season number — in every single episode's filename. Falls back
 * through, in order: season+episode straight from the filename (handles "S01E01"/"1x01" embedded
 * in the file itself, the common scene-release-style case) → a "Season NN"/"SNN" parent folder
 * plus an "E01"-style marker in the filename. Doesn't guess a bare episode number with no season
 * context or marker at all — too easy to misfire on an unrelated number in the name (a resolution,
 * a year, part of the title itself).
 */
export function detectSeasonEpisode(parentFolderName: string, filenameBase: string): { season: number | null; episode: number | null } {
  const parsed = parseReleaseTitle(filenameBase);
  if (parsed.seasonNumber !== null && parsed.episodeNumbers && parsed.episodeNumbers.length > 0) {
    return { season: parsed.seasonNumber, episode: parsed.episodeNumbers[0] };
  }
  const xMatch = filenameBase.match(EPISODE_X_FORMAT);
  if (xMatch) return { season: Number(xMatch[1]), episode: Number(xMatch[2]) };

  const seasonFolderMatch = parentFolderName.match(SEASON_FOLDER);
  if (seasonFolderMatch) {
    const season = Number(seasonFolderMatch[1] ?? seasonFolderMatch[2]);
    const epMatch = filenameBase.match(EPISODE_ONLY);
    if (epMatch) return { season, episode: Number(epMatch[1]) };
  }
  return { season: null, episode: null };
}

/** Same folder-awareness reasoning as detectSeasonEpisode: prefers a title guessed from the
 * filename itself when it looks substantial, otherwise falls back to the parent folder name (or
 * the grandparent, when the parent is just a "Season NN" folder rather than the series' own). */
function guessSeriesTitle(parentDir: string, filenameBase: string): string {
  const fromFilename = guessTitleFromText(filenameBase);
  if (fromFilename.length > 2) return fromFilename;

  const parentName = path.basename(parentDir);
  const folderName = SEASON_FOLDER.test(parentName) ? path.basename(path.dirname(parentDir)) : parentName;
  return guessTitleFromText(folderName);
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
 * episode/sub_item, and imports them: matches an existing "missing" item (movie) or series
 * (episodic) by a guessed title where possible (has_file=1 + path, same as a normal grab import),
 * else creates a new minimal item/series outright — a fresh library with nothing pre-added in
 * AoNarr yet still gets fully imported, not just files that happen to match something already
 * there. For "collection" shapes (books, comics, music, video channels, courses), the same idea
 * applies one level deeper: the file's immediate parent folder (relative to the root folder) is
 * taken as the parent item's title (Artist/Author/Creator — matched against an existing item or
 * created), and the child (Album/Book/Issue) is either the next folder down (for
 * `multiFilePerChild` types like Music, where an album is a folder of tracks — the whole folder
 * becomes one sub_item) or the file's own name (for everything else, one file per child).
 */
export async function scanAndImportLibrary(type: string, signal?: AbortSignal): Promise<ScanImportResult> {
  const typeConfig = getMediaTypeConfig(type);
  const result: ScanImportResult = { matched: 0, created: 0, skipped: 0, skippedFiles: [] };

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
    ...(
      db
        .prepare(
          `SELECT s.file_path FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.file_path IS NOT NULL AND m.type = ?`
        )
        .all(type) as { file_path: string }[]
    ).map((r) => r.file_path),
  ]);

  let files: string[] = [];
  for (const folder of folders) walkForExtensions(folder.path, typeConfig.extensions, knownPaths, files);

  // multiFilePerChild sub_items track a whole album FOLDER as one file_path — a plain per-file
  // knownPaths check above wouldn't catch individual track files inside an already-known album, so
  // every already-tracked album folder's files are excluded here instead, up front.
  if (typeConfig.shape === "collection" && typeConfig.multiFilePerChild) {
    const knownAlbumFolders = new Set(
      (
        db
          .prepare(
            `SELECT s.file_path FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.file_path IS NOT NULL AND m.type = ?`
          )
          .all(type) as { file_path: string }[]
      ).map((r) => r.file_path)
    );
    files = files.filter((f) => !knownAlbumFolders.has(path.dirname(f)));
  }

  const missingItems = db.prepare("SELECT * FROM media_items WHERE type = ? AND has_file = 0").all(type) as any[];
  const seriesItems = typeConfig.shape === "episodic" ? (db.prepare("SELECT * FROM media_items WHERE type = ?").all(type) as any[]) : [];
  const collectionParents = typeConfig.shape === "collection" ? (db.prepare("SELECT * FROM media_items WHERE type = ?").all(type) as any[]) : [];
  const qualityProfileId = defaultQualityProfileId();

  for (const filePath of files) {
    if (signal?.aborted) break;
    const base = path.basename(filePath, path.extname(filePath));
    const parentDir = path.dirname(filePath);

    try {
      if (typeConfig.shape === "episodic") {
        const { season, episode } = detectSeasonEpisode(path.basename(parentDir), base);
        if (season === null || episode === null) {
          result.skipped++;
          result.skippedFiles.push(filePath);
          continue;
        }
        const guessedTitle = guessSeriesTitle(parentDir, base);
        if (!guessedTitle) {
          result.skipped++;
          result.skippedFiles.push(filePath);
          continue;
        }
        const parsed = parseReleaseTitle(base);
        const quality = parsed.quality === "Unknown" ? null : parsed.quality;

        let seriesMatch = seriesItems.find((m) => titlesMatch(m.title, guessedTitle));
        if (!seriesMatch) {
          // No existing series to match against at all — create one, same as the single-shape
          // branch already does for movies. Otherwise a fresh TV library with nothing pre-added
          // in AoNarr yet would skip every single file with nothing to show for it.
          const folder = folders.find((f) => filePath.startsWith(f.path));
          const insertResult = db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, root_folder_id, quality_profile_id, monitored, has_file, status)
               VALUES (?, ?, ?, ?, ?, 1, 0, 'unknown')`
            )
            .run(type, guessedTitle, guessedTitle.toLowerCase(), folder?.id ?? null, qualityProfileId);
          seriesMatch = { id: Number(insertResult.lastInsertRowid), title: guessedTitle, has_file: 0 };
          seriesItems.push(seriesMatch);
        }

        const mediaInfo = await probeMediaInfo(filePath);
        const mediaInfoJson = mediaInfo ? JSON.stringify(mediaInfo) : null;
        const existingEp = db
          .prepare("SELECT id FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number = ?")
          .get(seriesMatch.id, season, episode) as { id: number } | undefined;
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
          ).run(seriesMatch.id, season, episode, `Episode ${episode}`, filePath, quality, mediaInfoJson);
        }
        result.matched++;
      } else if (typeConfig.shape === "collection") {
        const folder = folders.find((f) => filePath.startsWith(f.path));
        if (!folder) {
          result.skipped++;
          result.skippedFiles.push(filePath);
          continue;
        }
        const relSegments = path.relative(folder.path, filePath).split(path.sep).filter(Boolean);
        // Needs at least "Parent/file.ext" (2 segments) to know who the file belongs to — a file
        // sitting directly in the root folder with no parent folder at all can't be guessed at.
        if (relSegments.length < 2) {
          result.skipped++;
          result.skippedFiles.push(filePath);
          continue;
        }
        const parentTitle = guessTitleFromText(relSegments[0]);
        if (!parentTitle) {
          result.skipped++;
          result.skippedFiles.push(filePath);
          continue;
        }

        let parentMatch = collectionParents.find((m) => titlesMatch(m.title, parentTitle));
        if (!parentMatch) {
          const insertResult = db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, root_folder_id, quality_profile_id, monitored, has_file, status)
               VALUES (?, ?, ?, ?, ?, 1, 0, 'unknown')`
            )
            .run(type, parentTitle, parentTitle.toLowerCase(), folder.id, qualityProfileId);
          parentMatch = { id: Number(insertResult.lastInsertRowid), title: parentTitle, has_file: 0 };
          collectionParents.push(parentMatch);
        }

        const childSubItems = db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").all(parentMatch.id) as any[];

        if (typeConfig.multiFilePerChild) {
          // Album is whichever folder the file directly sits in (relSegments[0] = parent/artist,
          // so a real "Artist/Album/track.mp3" layout has the album as relSegments[1]; a flatter
          // "Artist/track.mp3" layout with no album subfolder falls back to the artist's own name
          // as a single self-titled album rather than being skipped outright).
          const albumFolderName = relSegments.length >= 3 ? relSegments[1] : relSegments[0];
          const albumTitle = guessTitleFromText(albumFolderName);
          if (!albumTitle) {
            result.skipped++;
            result.skippedFiles.push(filePath);
            continue;
          }
          let childMatch = childSubItems.find((s) => titlesMatch(s.title, albumTitle));
          if (!childMatch) {
            const insertResult = db
              .prepare("INSERT INTO sub_items (media_item_id, title, monitored) VALUES (?, ?, 1)")
              .run(parentMatch.id, albumTitle);
            childMatch = { id: Number(insertResult.lastInsertRowid), title: albumTitle, has_file: 0 };
            childSubItems.push(childMatch);
          }
          if (!childMatch.has_file) {
            db.prepare("UPDATE sub_items SET has_file = 1, file_path = ? WHERE id = ?").run(parentDir, childMatch.id);
            childMatch.has_file = 1;
            result.matched++;
          } else {
            // Already-known album that just gained another track file — nothing new to record at
            // the album level, but the file itself is now accounted for rather than re-scanned
            // forever (its containing folder join the knownAlbumFolders exclusion on the next run).
            result.skipped++;
          }
        } else {
          const childTitle = guessTitleFromText(base);
          if (!childTitle) {
            result.skipped++;
            result.skippedFiles.push(filePath);
            continue;
          }
          const parsed = parseReleaseTitle(base);
          const quality = parsed.quality === "Unknown" ? null : parsed.quality;
          const mediaInfo = await probeMediaInfo(filePath);
          const mediaInfoJson = mediaInfo ? JSON.stringify(mediaInfo) : null;

          const childMatch = childSubItems.find((s) => titlesMatch(s.title, childTitle));
          if (childMatch) {
            db.prepare("UPDATE sub_items SET has_file = 1, file_path = ?, quality = ?, media_info = ? WHERE id = ?").run(
              filePath,
              quality,
              mediaInfoJson,
              childMatch.id
            );
          } else {
            db.prepare(
              `INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path, quality, media_info)
               VALUES (?, ?, 1, 1, ?, ?, ?)`
            ).run(parentMatch.id, childTitle, filePath, quality, mediaInfoJson);
          }
          result.matched++;
        }
      } else {
        const guessedTitle = guessTitleFromText(base);
        if (!guessedTitle) {
          result.skipped++;
          result.skippedFiles.push(filePath);
          continue;
        }
        const parsed = parseReleaseTitle(base);
        const quality = parsed.quality === "Unknown" ? null : parsed.quality;

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
 * fetch-by-id call generic enough to cover every provider this app supports.
 *
 * Title/external ids are only overwritten for items that don't have external ids yet — i.e. items
 * that were never actually matched to real metadata in the first place, almost always a Scan &
 * Import guess parsed straight from a filename. For those, this Refresh is the only "match" they
 * ever get, so leaving the guessed title in place forever (the previous behavior) meant Scan &
 * Import's filename guess was permanent even after the item's overview/poster/year had all been
 * correctly filled in from the real provider result. An item that's already matched (has external
 * ids) keeps its title untouched, since a fuzzy title-only search could occasionally land on the
 * wrong result and this shouldn't silently rename something that was already correct. */
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
      const alreadyMatched = item.external_ids && item.external_ids !== "{}";
      db.prepare(
        `UPDATE media_items SET overview = COALESCE(?, overview), poster_url = COALESCE(?, poster_url), year = COALESCE(?, year),
         release_date = COALESCE(?, release_date)
         ${alreadyMatched ? "" : ", title = ?, sort_title = ?, external_ids = ?"}
         WHERE id = ?`
      ).run(
        best.overview,
        best.posterUrl,
        best.year,
        best.releaseDate ?? null,
        ...(alreadyMatched ? [] : [best.title, best.title.toLowerCase(), JSON.stringify(best.externalIds ?? {})]),
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
