/**
 * Central definition of every library type AoNarr manages. Adding a new library is meant to be
 * mostly a matter of adding an entry here — the scheduler, importer, indexer category mapping,
 * and naming defaults are all driven by `shape` rather than hardcoded per-type branches.
 *
 * Shapes:
 * - "single": one file per item (Movies, ROMs, Adult) — grabbed/imported as a unit.
 * - "episodic": season/episode children (TV Shows, Anime) — uses the `episodes` table.
 * - "collection": an open-ended list of named children (Music albums, Books, Comics issues,
 *   Online Video uploads, Course lessons) — uses the generic `sub_items` table. `multiFilePerChild`
 *   is true only for Music, where a "child" (album) download typically contains many files (one
 *   per track) rather than a single file per child.
 */

export type MediaShape = "single" | "episodic" | "collection";

export interface MediaTypeConfig {
  key: string;
  label: string;
  shape: MediaShape;
  childLabel?: string; // for "collection" shape: what a child is called (Album, Book, Issue, ...)
  extensions: string[];
  indexerCategory: string; // default Torznab/Newznab category id
  metadataProviders: string[];
  defaultProvider: string | null; // null when no viable search provider exists (manual-only)
  multiFilePerChild?: boolean;
  /** Nested grouping levels above the media_item itself, outermost first — e.g. rom's
   * ["system", "maker"] means System -> Maker -> Game. Empty/absent means items of this type
   * aren't grouped (browsed as a flat list, same as before library_groups existed). */
  groupLevels?: string[];
}

const VIDEO_EXT = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"];
const AUDIO_EXT = [".mp3", ".flac", ".m4a", ".ogg", ".wav"];
const BOOK_EXT = [".epub", ".mobi", ".pdf", ".azw3", ".m4b"];
const AUDIOBOOK_EXT = [".m4b", ".mp3", ".m4a"];
const COMIC_EXT = [".cbz", ".cbr", ".pdf"];
const ROM_EXT = [".zip", ".7z", ".nes", ".sfc", ".smc", ".gba", ".gbc", ".gb", ".n64", ".z64", ".nds", ".3ds", ".iso", ".chd"];

export const MEDIA_TYPES: Record<string, MediaTypeConfig> = {
  movie: {
    key: "movie",
    label: "Movies",
    shape: "single",
    extensions: VIDEO_EXT,
    indexerCategory: "2000",
    metadataProviders: ["tmdb", "omdb", "trakt"],
    defaultProvider: "tmdb",
  },
  series: {
    key: "series",
    label: "TV Shows",
    shape: "episodic",
    extensions: VIDEO_EXT,
    indexerCategory: "5000",
    metadataProviders: ["tmdb", "tvdb", "tvmaze", "trakt"],
    defaultProvider: "tmdb",
  },
  anime: {
    key: "anime",
    label: "Anime",
    shape: "episodic",
    extensions: VIDEO_EXT,
    indexerCategory: "5070",
    metadataProviders: ["anilist", "tvdb", "tmdb"],
    defaultProvider: "anilist",
  },
  artist: {
    key: "artist",
    label: "Music",
    shape: "collection",
    childLabel: "Album",
    extensions: AUDIO_EXT,
    indexerCategory: "3000",
    metadataProviders: ["musicbrainz", "deezer", "discogs", "lastfm"],
    defaultProvider: "musicbrainz",
    multiFilePerChild: true,
  },
  author: {
    key: "author",
    label: "Books",
    shape: "collection",
    childLabel: "Book",
    extensions: BOOK_EXT,
    indexerCategory: "7000",
    metadataProviders: ["openlibrary", "googlebooks"],
    defaultProvider: "openlibrary",
  },
  audiobook: {
    key: "audiobook",
    label: "Audiobooks",
    shape: "collection",
    childLabel: "Book",
    extensions: AUDIOBOOK_EXT,
    indexerCategory: "3030",
    // No dedicated audiobook metadata API is wired up; reuses the book-metadata providers for
    // title/author/cover art since a narrated edition still shares the same underlying work.
    metadataProviders: ["openlibrary", "googlebooks"],
    defaultProvider: "openlibrary",
    multiFilePerChild: true,
  },
  comic: {
    key: "comic",
    label: "Comics",
    shape: "collection",
    childLabel: "Issue",
    extensions: COMIC_EXT,
    indexerCategory: "7030",
    metadataProviders: ["comicvine"],
    defaultProvider: "comicvine",
  },
  manga: {
    key: "manga",
    label: "Manga",
    shape: "collection",
    childLabel: "Chapter",
    extensions: COMIC_EXT,
    indexerCategory: "7020",
    metadataProviders: ["anilist", "mangadex"],
    defaultProvider: "anilist",
  },
  rom: {
    key: "rom",
    label: "ROMs",
    shape: "single",
    extensions: ROM_EXT,
    indexerCategory: "4050",
    metadataProviders: ["rawg", "igdb"],
    defaultProvider: "rawg",
    groupLevels: ["system", "maker"],
  },
  video: {
    key: "video",
    label: "Online Videos",
    shape: "collection",
    childLabel: "Video",
    extensions: VIDEO_EXT,
    indexerCategory: "5000",
    metadataProviders: ["youtube"],
    defaultProvider: "youtube",
    groupLevels: ["site"],
  },
  course: {
    key: "course",
    label: "Courses",
    shape: "collection",
    childLabel: "Lesson",
    extensions: [...VIDEO_EXT, ...BOOK_EXT],
    indexerCategory: "5000",
    metadataProviders: [],
    defaultProvider: null, // no viable public search API for arbitrary course platforms; manual-only
    groupLevels: ["site", "creator"],
  },
  adult: {
    key: "adult",
    label: "Adult",
    shape: "single",
    extensions: VIDEO_EXT,
    indexerCategory: "6000",
    metadataProviders: ["theporndb"],
    defaultProvider: "theporndb",
    groupLevels: ["site", "maker", "series"],
  },
};

export const MEDIA_TYPE_KEYS = Object.keys(MEDIA_TYPES);

export function isValidMediaType(type: string): boolean {
  return type in MEDIA_TYPES;
}

export function getMediaTypeConfig(type: string): MediaTypeConfig {
  const config = MEDIA_TYPES[type];
  if (!config) throw new Error(`Unknown media type "${type}"`);
  return config;
}
