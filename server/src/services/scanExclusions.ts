import path from "node:path";

/**
 * What the library scan must never take for a title of its own, after Sonarr's and Radarr's
 * DiskScanService exclusions. Pointed at an existing Plex, Jellyfin, Synology or QNAP library, the
 * scan used to create an item from every trailer, extra, sample, thumbnail-cache copy and recycled
 * file under the root, and a trailer could take the movie's file slot before the real movie.
 */

/** Folders that hold no library media of any type: NAS and media-server housekeeping, other
 * programs' trash. Every folder starting with a dot is skipped as well (hidden on Linux and Samba). */
const JUNK_FOLDERS = new Set([
  "@eadir", // Synology thumbnails and indexes
  ".@__thumb", // QNAP thumbnails
  "@recycle",
  "@recently-snapshot",
  "#recycle", // Synology and Unraid recycle bins
  "$recycle.bin",
  "lost+found",
  "plex versions", // Plex's optimized copies of a title
  "system volume information",
]);

/** The extras folders of a movie or a show (Plex, Jellyfin and Kodi layouts). */
const EXTRAS_FOLDERS = new Set([
  "extras",
  "extra",
  "featurettes",
  "behind the scenes",
  "deleted scenes",
  "interviews",
  "scenes",
  "shorts",
  "trailers",
  "samples",
  "sample",
  "theme music",
  "backdrops",
]);

/** "Movie (2010)-trailer.mkv" and its siblings: Plex's, Jellyfin's and Radarr's naming for an extra beside
 * the movie. The word must follow a dash, as in Radarr: "Crime Scene", "Cut Short" and "The Other" are
 * episode and movie titles. */
const EXTRAS_FILE_SUFFIX = /-(?:trailer|featurette|behindthescenes|deleted|interview|scene|short|other)$/i;

/** "Movie-sample" and "Movie.sample": a sample cut from a release. */
const SAMPLE_FILE_SUFFIX = /[-.]sample$/i;

/** What a release name ends with before its group ("...x264-OTHER", "...720p-SCENE"): such a file is a
 * release whose group happens to be called OTHER or SCENE, not an extra. */
const RELEASE_NAME_TAIL = /(?:x26[45]|h\.?26[45]|hevc|avc|xvid|divx|bluray|web-?dl|webrip|hdtv|dvdrip|brrip|\d{3,4}p)$/i;

/** The media types whose files are movies and shows, where extras folders and suffixes mean what they
 * do in Plex. A video channel's "Shorts" or an adult studio's "Scenes" folder is real content. */
const EXTRAS_TYPES = new Set(["movie", "series", "anime"]);

export interface ScanFilter {
  /** Skip extras folders and "-trailer"-style files: movies and shows only. */
  skipExtras: boolean;
  /** Resolved folders to skip whole (the recycle bin, when it sits inside a root folder). */
  excludedPaths: Set<string>;
}

export function scanFilterFor(mediaType: string, excludedPaths: string[] = []): ScanFilter {
  return { skipExtras: EXTRAS_TYPES.has(mediaType), excludedPaths: new Set(excludedPaths.filter(Boolean).map((p) => path.resolve(p))) };
}

/**
 * True when the scan must not descend into this folder. `depth` is how far below the root folder it
 * is: 0 for a root's direct children. A movie or show folder is itself one of those, so a series
 * called "Extras" or "Shorts" is never read as an extras folder; the extras folders sit inside a title's.
 */
export function isExcludedFolder(name: string, fullPath: string, filter: ScanFilter, depth = 1): boolean {
  const lower = name.toLowerCase();
  if (name.startsWith(".") || JUNK_FOLDERS.has(lower)) return true;
  if (filter.excludedPaths.has(path.resolve(fullPath))) return true;
  return filter.skipExtras && depth >= 1 && EXTRAS_FOLDERS.has(lower);
}

/** True when the scan must not take this file as a title's own. */
export function isExcludedFile(name: string, filter: ScanFilter): boolean {
  // Import temporaries and the old copy set aside during an upgrade (importer.ts).
  if (name.startsWith(".aonarr-tmp-") || name.startsWith(".aonarr-old-")) return true;
  if (!filter.skipExtras) return false;
  const base = path.basename(name, path.extname(name));
  if (base.toLowerCase() === "sample" || SAMPLE_FILE_SUFFIX.test(base)) return true;
  const extra = EXTRAS_FILE_SUFFIX.exec(base);
  return !!extra && !RELEASE_NAME_TAIL.test(base.slice(0, extra.index));
}
