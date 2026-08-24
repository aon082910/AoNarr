import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
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

/** Upserts one `tracks` row for a file inside a multiFilePerChild (Music) album folder — parses a
 * leading "01 - " / "01." style track number out of the filename where present (same convention
 * placeAlbumFiles() in importer.ts assumes for the download-import path), falling back to the next
 * number after this album's current highest track for anything unnumbered. Shared by the live scan
 * loop and backfillMissingAlbumTracks() below so both stay in sync. */
async function upsertTrackFromFile(subItemId: number, filePath: string): Promise<void> {
  const base = path.basename(filePath, path.extname(filePath));
  const leadingNumber = base.match(/^(\d{1,3})\b/);
  let trackNumber = leadingNumber ? Number(leadingNumber[1]) : null;
  if (trackNumber === null || trackNumber === 0) {
    const maxRow = (await db
      .prepare("SELECT COALESCE(MAX(track_number), 0) AS m FROM tracks WHERE sub_item_id = ?")
      .get(subItemId)) as { m: number };
    trackNumber = Number(maxRow.m) + 1;
  }
  const trackTitle = guessTitleFromText(base.replace(/^\d{1,3}[\s._-]*/, "")) || base;
  await db
    .prepare(
      `INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (sub_item_id, track_number) DO UPDATE SET has_file = 1, file_path = excluded.file_path`
    )
    .run(subItemId, trackNumber, trackTitle, filePath);
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

async function defaultQualityProfileId(): Promise<number | null> {
  const row = (await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as { id: number } | undefined;
  return row?.id ?? null;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface ScanImportResult {
  matched: number;
  created: number;
  skipped: number;
  skippedFiles: SkippedFile[];
  unsupported?: string;
  alreadyRunning?: boolean;
}

/** Guards against two overlapping scans of the same type racing each other — e.g. a scheduled
 * "Library Import" job firing while an admin's manual "Scan & Import" click (or a duplicate click)
 * is still in flight. Both would otherwise load their own independent snapshot of existing
 * series/collection parents before either had inserted anything, each conclude "no existing match"
 * for the same new show, and both insert their own duplicate media_items row for it — this was the
 * cause of library-wide duplicate TV shows reported after scanning. probeMediaInfo's per-file
 * ffprobe call is slow enough (real subprocess I/O) that this race was easy to hit in practice, not
 * just a theoretical window. */
const scansInProgress = new Set<string>();

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
  if (scansInProgress.has(type)) {
    log.warn(`[libraryScan] a scan for "${type}" is already running — skipping this overlapping request`);
    return { matched: 0, created: 0, skipped: 0, skippedFiles: [], alreadyRunning: true };
  }
  scansInProgress.add(type);
  try {
    return await scanAndImportLibraryInner(type, signal);
  } finally {
    scansInProgress.delete(type);
  }
}

async function scanAndImportLibraryInner(type: string, signal?: AbortSignal): Promise<ScanImportResult> {
  const typeConfig = getMediaTypeConfig(type);
  const result: ScanImportResult = { matched: 0, created: 0, skipped: 0, skippedFiles: [] };

  const folders = ((await db.prepare("SELECT * FROM root_folders WHERE media_type = ?").all(type)) as any[]).map(rootFolderFromRow);
  if (folders.length === 0) return result;

  const knownPaths = new Set<string>([
    ...((await db.prepare("SELECT path FROM media_items WHERE path IS NOT NULL AND type = ?").all(type)) as { path: string }[]).map(
      (r) => r.path
    ),
    ...(
      (await db
        .prepare(
          `SELECT e.file_path FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.file_path IS NOT NULL AND m.type = ?`
        )
        .all(type)) as { file_path: string }[]
    ).map((r) => r.file_path),
    ...(
      (await db
        .prepare(
          `SELECT s.file_path FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.file_path IS NOT NULL AND m.type = ?`
        )
        .all(type)) as { file_path: string }[]
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
        (await db
          .prepare(
            `SELECT s.file_path FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.file_path IS NOT NULL AND m.type = ?`
          )
          .all(type)) as { file_path: string }[]
      ).map((r) => r.file_path)
    );
    files = files.filter((f) => !knownAlbumFolders.has(path.dirname(f)));
  }

  // Matched against ALL items of this type, not just has_file=0 ones — same reasoning as
  // seriesItems/collectionParents below. Filtering to only-missing here was the root cause of
  // movies (and other single-shape types) getting duplicated: an already-imported movie is
  // invisible to this match once it has a file, so a second file that guesses the same title
  // (an extra copy, a sample left behind, a re-download) always fell to the "no match" branch and
  // created a brand new row instead of being recognized as the same movie.
  const singleShapeItems = (await db.prepare("SELECT * FROM media_items WHERE type = ?").all(type)) as any[];
  const seriesItems = typeConfig.shape === "episodic" ? ((await db.prepare("SELECT * FROM media_items WHERE type = ?").all(type)) as any[]) : [];
  const collectionParents =
    typeConfig.shape === "collection" ? ((await db.prepare("SELECT * FROM media_items WHERE type = ?").all(type)) as any[]) : [];
  const qualityProfileId = await defaultQualityProfileId();

  for (const filePath of files) {
    if (signal?.aborted) break;
    const base = path.basename(filePath, path.extname(filePath));
    const parentDir = path.dirname(filePath);

    try {
      if (typeConfig.shape === "episodic") {
        const { season, episode } = detectSeasonEpisode(path.basename(parentDir), base);
        if (season === null || episode === null) {
          result.skipped++;
          result.skippedFiles.push({ path: filePath, reason: "couldn't detect a season/episode number from the filename or folder" });
          continue;
        }
        const guessedTitle = guessSeriesTitle(parentDir, base);
        if (!guessedTitle) {
          result.skipped++;
          result.skippedFiles.push({ path: filePath, reason: "couldn't guess a series title from the filename or folder" });
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
          const insertResult = await db
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
        const existingEp = (await db
          .prepare("SELECT id FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number = ?")
          .get(seriesMatch.id, season, episode)) as { id: number } | undefined;
        if (existingEp) {
          await db
            .prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = ?, media_info = ? WHERE id = ?")
            .run(filePath, quality, mediaInfoJson, existingEp.id);
        } else {
          await db
            .prepare(
              `INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path, quality, media_info)
               VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`
            )
            .run(seriesMatch.id, season, episode, `Episode ${episode}`, filePath, quality, mediaInfoJson);
        }
        result.matched++;
      } else if (typeConfig.shape === "collection") {
        const folder = folders.find((f) => filePath.startsWith(f.path));
        if (!folder) {
          result.skipped++;
          result.skippedFiles.push({ path: filePath, reason: "not inside any configured root folder" });
          continue;
        }
        const relSegments = path.relative(folder.path, filePath).split(path.sep).filter(Boolean);
        // Needs at least "Parent/file.ext" (2 segments) to know who the file belongs to — a file
        // sitting directly in the root folder with no parent folder at all can't be guessed at.
        if (relSegments.length < 2) {
          result.skipped++;
          result.skippedFiles.push({ path: filePath, reason: "sits directly in the root folder with no parent (Artist/Author/...) folder" });
          continue;
        }
        const parentTitle = guessTitleFromText(relSegments[0]);
        if (!parentTitle) {
          result.skipped++;
          result.skippedFiles.push({ path: filePath, reason: `couldn't guess a title from the parent folder name "${relSegments[0]}"` });
          continue;
        }

        let parentMatch = collectionParents.find((m) => titlesMatch(m.title, parentTitle));
        if (!parentMatch) {
          const insertResult = await db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, root_folder_id, quality_profile_id, monitored, has_file, status)
               VALUES (?, ?, ?, ?, ?, 1, 0, 'unknown')`
            )
            .run(type, parentTitle, parentTitle.toLowerCase(), folder.id, qualityProfileId);
          parentMatch = { id: Number(insertResult.lastInsertRowid), title: parentTitle, has_file: 0 };
          collectionParents.push(parentMatch);
        }

        const childSubItems = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").all(parentMatch.id)) as any[];

        if (typeConfig.multiFilePerChild) {
          // Album is whichever folder the file directly sits in (relSegments[0] = parent/artist,
          // so a real "Artist/Album/track.mp3" layout has the album as relSegments[1]; a flatter
          // "Artist/track.mp3" layout with no album subfolder falls back to the artist's own name
          // as a single self-titled album rather than being skipped outright).
          const albumFolderName = relSegments.length >= 3 ? relSegments[1] : relSegments[0];
          const albumTitle = guessTitleFromText(albumFolderName);
          if (!albumTitle) {
            result.skipped++;
            result.skippedFiles.push({ path: filePath, reason: `couldn't guess an album title from the folder name "${albumFolderName}"` });
            continue;
          }
          let childMatch = childSubItems.find((s) => titlesMatch(s.title, albumTitle));
          if (!childMatch) {
            const insertResult = await db
              .prepare("INSERT INTO sub_items (media_item_id, title, monitored) VALUES (?, ?, 1)")
              .run(parentMatch.id, albumTitle);
            childMatch = { id: Number(insertResult.lastInsertRowid), title: albumTitle, has_file: 0 };
            childSubItems.push(childMatch);
          }
          if (!childMatch.has_file) {
            await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ? WHERE id = ?").run(parentDir, childMatch.id);
            childMatch.has_file = 1;
            result.matched++;
          } else {
            // Already-known album that just gained another track file — nothing new to record at
            // the album level, but the file itself is now accounted for rather than re-scanned
            // forever (its containing folder join the knownAlbumFolders exclusion on the next run).
            result.skipped++;
          }

          // A track row per file, not just the album-level has_file/file_path set above — without
          // this the album detail page shows "0 have / 0 total, no track data available" forever
          // for a Scan & Import-created album, since no metadata provider ever ran to populate the
          // track list the way an Add Media search + fetchAlbumTracksFor() would.
          await upsertTrackFromFile(childMatch.id, filePath);
        } else {
          const childTitle = guessTitleFromText(base);
          if (!childTitle) {
            result.skipped++;
            result.skippedFiles.push({ path: filePath, reason: `couldn't guess a title from the filename "${base}"` });
            continue;
          }
          const parsed = parseReleaseTitle(base);
          const quality = parsed.quality === "Unknown" ? null : parsed.quality;
          const mediaInfo = await probeMediaInfo(filePath);
          const mediaInfoJson = mediaInfo ? JSON.stringify(mediaInfo) : null;

          const childMatch = childSubItems.find((s) => titlesMatch(s.title, childTitle));
          if (childMatch) {
            await db
              .prepare("UPDATE sub_items SET has_file = 1, file_path = ?, quality = ?, media_info = ? WHERE id = ?")
              .run(filePath, quality, mediaInfoJson, childMatch.id);
          } else {
            await db
              .prepare(
                `INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path, quality, media_info)
                 VALUES (?, ?, 1, 1, ?, ?, ?)`
              )
              .run(parentMatch.id, childTitle, filePath, quality, mediaInfoJson);
          }
          result.matched++;
        }
      } else {
        const guessedTitle = guessTitleFromText(base);
        if (!guessedTitle) {
          result.skipped++;
          result.skippedFiles.push({ path: filePath, reason: `couldn't guess a title from the filename "${base}"` });
          continue;
        }
        const parsed = parseReleaseTitle(base);
        const quality = parsed.quality === "Unknown" ? null : parsed.quality;

        const match = singleShapeItems.find((m) => titlesMatch(m.title, guessedTitle));
        if (match && match.has_file && match.path !== filePath) {
          // Already has a different file — most likely an extra copy, a sample, or a re-download
          // sitting alongside the one already tracked. Matching (not creating a new row) but not
          // overwriting an existing good file with this one is the safer default; the file is left
          // on disk, untouched, for manual review rather than silently duplicated or clobbered.
          result.skipped++;
          result.skippedFiles.push({
            path: filePath,
            reason: `matched existing movie "${match.title}" which already has a file — left in place rather than duplicating or overwriting`,
          });
          continue;
        }

        const mediaInfo = await probeMediaInfo(filePath);
        const mediaInfoJson = mediaInfo ? JSON.stringify(mediaInfo) : null;
        if (match) {
          await db
            .prepare("UPDATE media_items SET has_file = 1, path = ?, quality = ?, media_info = ? WHERE id = ?")
            .run(filePath, quality, mediaInfoJson, match.id);
          match.has_file = 1;
          match.path = filePath;
          result.matched++;
        } else {
          const folder = folders.find((f) => filePath.startsWith(f.path));
          const insertResult = await db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, year, path, root_folder_id, quality_profile_id, monitored, has_file, quality, media_info, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 'unknown')`
            )
            .run(type, guessedTitle, guessedTitle.toLowerCase(), parsed.year, filePath, folder?.id ?? null, qualityProfileId, quality, mediaInfoJson);
          // Pushed into the same array this scan matches against — without this, two files in one
          // scan that both guess the same new title (e.g. a movie's main file and its sample) each
          // create their own row instead of the second one matching the first's.
          singleShapeItems.push({ id: Number(insertResult.lastInsertRowid), title: guessedTitle, has_file: 1, path: filePath });
          result.created++;
        }
      }
    } catch (err) {
      log.warn(`[libraryScan] failed to import "${filePath}":`, (err as Error).message);
      result.skipped++;
      result.skippedFiles.push({ path: filePath, reason: (err as Error).message });
    }
  }

  // The episodic/collection branches above only ever set has_file on the child episode/sub_item
  // row they just matched or created — never on the parent series/collection media_items row
  // itself, since a parent can gain files one child at a time across many separate scan runs.
  // Without this rollup (the same one mediaServerImport.ts/starrImport.ts already do after their
  // own episode/sub-item import passes) a Scan & Import-created series or collection parent's
  // has_file stayed 0 forever, which is what the Library page's hasFile-driven "Missing" badge
  // reads — so every episodic/collection item scanned in looked permanently "missing" even once
  // every episode/album was actually present on disk.
  if (typeConfig.shape === "episodic") {
    await db
      .prepare(
        `UPDATE media_items SET has_file = 1 WHERE type = ? AND has_file = 0 AND id IN (SELECT DISTINCT media_item_id FROM episodes WHERE has_file = 1)`
      )
      .run(type);
  } else if (typeConfig.shape === "collection") {
    await db
      .prepare(
        `UPDATE media_items SET has_file = 1 WHERE type = ? AND has_file = 0 AND id IN (SELECT DISTINCT media_item_id FROM sub_items WHERE has_file = 1)`
      )
      .run(type);
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
  const items = (await db.prepare("SELECT * FROM media_items WHERE type = ?").all(type)) as any[];
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
      await db
        .prepare(
          `UPDATE media_items SET overview = COALESCE(?, overview), poster_url = COALESCE(?, poster_url), year = COALESCE(?, year),
           release_date = COALESCE(?, release_date)
           ${alreadyMatched ? "" : ", title = ?, sort_title = ?, external_ids = ?"}
           WHERE id = ?`
        )
        .run(
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

/**
 * One-time-per-startup data fix for installs that hit the has_file rollup gap described above
 * (fixed going forward in scanAndImportLibrary itself, as of this same change) — a Scan &
 * Import-created series/collection parent whose children all have files, but whose own has_file
 * never got flipped, so it still shows as "Missing" on the Library page. Safe to run unconditionally
 * on every startup: each UPDATE is scoped to `has_file = 0` rows with at least one has_file=1 child,
 * so it's a no-op once every affected row has been fixed once.
 */
export async function backfillEpisodicAndCollectionHasFile(): Promise<void> {
  let fixed = 0;
  for (const type of MEDIA_TYPE_KEYS) {
    const shape = getMediaTypeConfig(type).shape;
    if (shape === "episodic") {
      const result = await db
        .prepare(
          `UPDATE media_items SET has_file = 1 WHERE type = ? AND has_file = 0 AND id IN (SELECT DISTINCT media_item_id FROM episodes WHERE has_file = 1)`
        )
        .run(type);
      fixed += result.changes;
    } else if (shape === "collection") {
      const result = await db
        .prepare(
          `UPDATE media_items SET has_file = 1 WHERE type = ? AND has_file = 0 AND id IN (SELECT DISTINCT media_item_id FROM sub_items WHERE has_file = 1)`
        )
        .run(type);
      fixed += result.changes;
    }
  }
  if (fixed > 0) log.info(`[libraryScan] startup data fix: corrected has_file on ${fixed} item(s) that had files but were still marked missing`);
}

/**
 * One-time-per-startup data fix for albums that were Scan & Import-created before this round added
 * per-file track-row insertion (see upsertTrackFromFile()) — those albums have `has_file = 1` and a
 * `file_path` (the album folder) but zero rows in `tracks`, so the album detail page permanently
 * showed "no track data available" even with every file right there on disk. Re-lists each such
 * album's own folder and inserts the same guessed track rows the main scan loop now creates going
 * forward. Safe to run unconditionally on every startup: scoped to albums with zero known tracks,
 * so it's a no-op once every affected album has been backfilled once — and normal re-scans skip an
 * already-known album folder entirely, so without this fix those albums would never self-heal.
 */
export async function backfillMissingAlbumTracks(): Promise<void> {
  let fixed = 0;
  for (const type of MEDIA_TYPE_KEYS) {
    const cfg = getMediaTypeConfig(type);
    if (cfg.shape !== "collection" || !cfg.multiFilePerChild) continue;

    const albums = (await db
      .prepare(
        `SELECT s.id, s.file_path FROM sub_items s
         JOIN media_items m ON m.id = s.media_item_id
         WHERE m.type = ? AND s.has_file = 1 AND s.file_path IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.sub_item_id = s.id)`
      )
      .all(type)) as { id: number; file_path: string }[];

    for (const album of albums) {
      let files: string[];
      try {
        files = fs
          .readdirSync(album.file_path, { withFileTypes: true })
          .filter((e) => e.isFile() && cfg.extensions.includes(path.extname(e.name).toLowerCase()))
          .map((e) => path.join(album.file_path, e.name));
      } catch {
        continue; // folder moved/removed since the scan — nothing to backfill from
      }
      if (files.length === 0) continue;
      for (const filePath of files) await upsertTrackFromFile(album.id, filePath);
      fixed++;
    }
  }
  if (fixed > 0) log.info(`[libraryScan] startup data fix: backfilled track listings for ${fixed} previously-scanned album(s)`);
}

/** Logs a scan's outcome, including WHY each skipped file was skipped — not just the bare count.
 * Without the per-file reason, a file that's silently skipped (unparseable filename, wrong folder
 * depth, etc.) looks like it simply vanished, with nothing in the logs pointing at which file or
 * why; every caller of scanAndImportLibrary should route its result through this instead of
 * logging matched/created/skipped counts alone. Capped at 20 reasons per call so a library with a
 * systemic naming-convention mismatch (hundreds of skips) doesn't flood the log — the count above
 * the list still reflects the true total. */
export function logScanResult(type: string, result: ScanImportResult): void {
  log.info(`[libraryScan] "${type}": matched ${result.matched}, created ${result.created}, skipped ${result.skipped}`);
  if (result.skippedFiles.length === 0) return;
  const shown = result.skippedFiles.slice(0, 20);
  for (const { path: filePath, reason } of shown) {
    log.info(`[libraryScan] "${type}" skipped "${filePath}": ${reason}`);
  }
  if (result.skippedFiles.length > shown.length) {
    log.info(`[libraryScan] "${type}": ${result.skippedFiles.length - shown.length} more skipped file(s) not shown`);
  }
}

export async function scanAndImportAllLibraries(signal?: AbortSignal): Promise<void> {
  for (const type of MEDIA_TYPE_KEYS) {
    if (signal?.aborted) return;
    const result = await scanAndImportLibrary(type, signal);
    if (result.matched > 0 || result.created > 0 || result.skipped > 0) {
      logScanResult(type, result);
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
