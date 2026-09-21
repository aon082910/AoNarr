/**
 * Central definition of every library type AoNarr manages. Adding a new library is meant to be
 * mostly a matter of adding an entry here — the scheduler, importer, indexer category mapping,
 * and naming defaults are all driven by `shape` rather than hardcoded per-type branches.
 *
 * Shapes:
 * - "single": one file per item (Movies, ROMs) — grabbed/imported as a unit.
 * - "episodic": season/episode children — uses the `episodes` table. Covers provider-backed shows
 *   (TV Shows, Anime) as well as folder-only shows with no metadata provider at all (Courses,
 *   Adult): a folder becomes the "show" (its title always comes from the folder/filename, never
 *   from a provider match — see libraryScan.ts's guessSeriesTitle), and the files inside become
 *   its "episodes". `sequentialEpisodeFallback` is what lets the latter group default season/
 *   episode numbers when a file carries no scene-style marker instead of being skipped.
 * - "collection": an open-ended list of named children (Music albums, Books, Comics issues,
 *   Online Video uploads) — uses the generic `sub_items` table. `multiFilePerChild`
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
  /** Episodic-only: a file with no season/episode marker at all is still turned into an episode
   * (season 1, sequential episode number) instead of being skipped — for folder-as-show types with
   * no metadata provider to ever backfill a real episode list (Courses, Adult). Provider-backed
   * episodic types (series/anime/sports) must leave this unset — a marker-less file for those
   * stays skipped, exactly as before. */
  sequentialEpisodeFallback?: boolean;
  /** Nested grouping levels above the media_item itself, outermost first — e.g. ["system",
   * "maker"] would mean System -> Maker -> Game. Empty/absent means items of this type aren't
   * grouped (browsed as a flat list). No current type sets this — ROM/Online Videos/Courses/
   * Adult all used to (System/Maker, Site, Site/Creator, Site/Maker/Series respectively), but
   * browsing by an extra manually-curated folder level on top of the actual show/item, plus the
   * "N item(s) haven't been matched to a group yet" nag that came with it, wasn't worth it for
   * any of them in practice — a course/adult/ROM folder already *is* the item, one level, no
   * grouping needed above it. The underlying library_groups table/routes/UI stay intact for a
   * future type that genuinely wants this. */
  groupLevels?: string[];
  /** The on-disk metadata sidecar convention this type's files use, if any — see
   * services/sidecarMetadata.ts, which Scan/Refresh check before falling back to today's
   * filename/folder-guessing. Left unset for types with no real-world sidecar convention (ROMs,
   * Online Videos, Podcasts) rather than a poor-fit guess. */
  sidecarFormat?: "kodi-video" | "kodi-music" | "comicinfo" | "opf";
}

const VIDEO_EXT = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"];
const AUDIO_EXT = [".mp3", ".flac", ".m4a", ".ogg", ".wav"];
const BOOK_EXT = [".epub", ".mobi", ".pdf", ".azw3", ".m4b"];
const AUDIOBOOK_EXT = [".m4b", ".mp3", ".m4a"];
const COMIC_EXT = [".cbz", ".cbr", ".pdf"];
const ROM_EXT = [".zip", ".7z", ".nes", ".sfc", ".smc", ".gba", ".gbc", ".gb", ".n64", ".z64", ".nds", ".3ds", ".iso", ".chd"];

/** Extensions ffprobe can actually read (real video/audio containers) — used to skip pointlessly
 * running ffprobe against a file it was never going to understand (an ebook, comic archive, ROM,
 * etc.), which just produced a scary-looking "[ffprobe] could not probe ..." warning in the logs
 * for something that was never broken. */
const PROBEABLE_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, ".m4b"]);

export function isProbeableFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return PROBEABLE_EXT.has(filePath.slice(dot).toLowerCase());
}

export const MEDIA_TYPES: Record<string, MediaTypeConfig> = {
  movie: {
    key: "movie",
    label: "Movies",
    shape: "single",
    extensions: VIDEO_EXT,
    indexerCategory: "2000",
    metadataProviders: ["tmdb", "omdb", "trakt"],
    defaultProvider: "tmdb",
    sidecarFormat: "kodi-video",
  },
  series: {
    key: "series",
    label: "TV Shows",
    shape: "episodic",
    extensions: VIDEO_EXT,
    indexerCategory: "5000",
    metadataProviders: ["tmdb", "tvdb", "tvmaze", "trakt"],
    defaultProvider: "tmdb",
    sidecarFormat: "kodi-video",
  },
  anime: {
    key: "anime",
    label: "Anime",
    shape: "episodic",
    extensions: VIDEO_EXT,
    indexerCategory: "5070",
    metadataProviders: ["anilist", "tvdb", "tmdb"],
    defaultProvider: "anilist",
    sidecarFormat: "kodi-video",
  },
  sports: {
    key: "sports",
    label: "Sports",
    shape: "episodic",
    extensions: VIDEO_EXT,
    // 5060 is Newznab/Torznab's own "TV/Sport" subcategory; 5000 (the parent TV category) is
    // included alongside it the same way rom.indexerCategory lists both a specific and a parent
    // category — most indexers file WWE/UFC/league-broadcast releases under one or the other
    // inconsistently, so searching both catches what a 5060-only search would miss.
    indexerCategory: "5060,5000",
    // A promotion/league (WWE, UFC, Premier League) is modeled the same way any other TV show is
    // — a "series" with dated "episodes" for each event/match/broadcast — which is exactly how
    // TVDB and TVmaze already catalog this content themselves (WWE Raw, UFC events, etc. are real
    // entries there), so this reuses the identical series search/episode-fetch code with zero new
    // provider integration. TheSportsDB (a sports-specific database) was investigated and turned
    // out not to be viable as a default: its free tier is a locked demo (10 soccer leagues only,
    // 1-result search caps) with real coverage gated behind a paid key — see CHANGELOG.
    metadataProviders: ["tvdb", "tvmaze", "trakt"],
    defaultProvider: "tvdb",
    sidecarFormat: "kodi-video",
  },
  ppv: {
    key: "ppv",
    label: "Sports PPV",
    // A weekly/nightly broadcast (Raw, Smackdown, a league's regular season) fits "sports" above —
    // recurring, dated, naturally episodic. A pay-per-view (WrestleMania, an numbered UFC event) is
    // the opposite: a single self-contained release with its own poster/title/year, no season or
    // recurring-show structure at all — a movie in every way that matters here. TMDB (this type's
    // metadata source, same as Movies) actually catalogs many of these as standalone entries for
    // exactly that reason, so this shares Movies' shape and provider list rather than inventing
    // anything new.
    shape: "single",
    extensions: VIDEO_EXT,
    // Same reasoning as sports.indexerCategory: a PPV release could be filed under either Movies
    // (2000) or TV/Sport (5060) depending on the indexer, so both are searched.
    indexerCategory: "2000,5060",
    metadataProviders: ["tmdb", "omdb", "trakt"],
    defaultProvider: "tmdb",
    sidecarFormat: "kodi-video",
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
    sidecarFormat: "kodi-music",
  },
  author: {
    key: "author",
    label: "Books",
    shape: "collection",
    childLabel: "Book",
    extensions: BOOK_EXT,
    indexerCategory: "7000",
    // audnexus has no book-search/list capability of its own — it's an author bio/photo
    // enrichment source only (see searchAuthorsAudnexus), included here so "Fetch from audnexus"
    // shows up as an Additional Metadata Source on an author's own page, the same role Fanart.tv
    // plays for movies/series/artists.
    metadataProviders: ["openlibrary", "googlebooks", "itunes", "hardcover", "goodreads", "audnexus"],
    defaultProvider: "openlibrary",
    sidecarFormat: "opf",
  },
  audiobook: {
    key: "audiobook",
    label: "Audiobooks",
    shape: "collection",
    childLabel: "Book",
    extensions: AUDIOBOOK_EXT,
    indexerCategory: "3030",
    // Reuses the book-metadata providers too (a narrated edition still shares the same underlying
    // work), plus Audible, which is audiobook-specific — the first provider actually built for
    // this type rather than borrowed from Books — and audnexus for author bio/photo enrichment
    // (same non-search, enrichment-only role as in Books above).
    metadataProviders: ["openlibrary", "googlebooks", "audible", "audnexus"],
    defaultProvider: "openlibrary",
    multiFilePerChild: true,
    sidecarFormat: "opf",
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
    sidecarFormat: "comicinfo",
  },
  manga: {
    key: "manga",
    label: "Manga",
    shape: "collection",
    childLabel: "Chapter",
    extensions: COMIC_EXT,
    indexerCategory: "7020",
    metadataProviders: ["anilist", "mangadex"],
    // MangaDex, not AniList, is the default: AniList is a tracker/database with no per-chapter
    // listing, so a manga matched through it would sit at "0 total" chapters forever (the same
    // fetchCollectionChildrenFor() gap issue #5 ran into) — MangaDex's own chapter feed is what
    // actually populates the Chapters list at add-time, mirroring how Comics defaults to ComicVine
    // for the same reason.
    defaultProvider: "mangadex",
    sidecarFormat: "comicinfo",
  },
  rom: {
    key: "rom",
    label: "ROMs",
    shape: "single",
    extensions: ROM_EXT,
    // Torznab's cat= param takes a comma-separated list natively (searchTorznabNewznab passes this
    // straight through, no parsing needed on this end) — 4050 alone (PC/Games) was missing every
    // console release entirely, and PC/Software and anything filed under the catch-all "Other"
    // category were both invisible too. 1000 (Console) and 4000 (PC) are parent categories, which
    // most indexers treat as covering their own subcategories (1010 NDS, 1020 PSP, 1030 Wii,
    // 1040/1050 Xbox/360, 1060 Wiiware/VC, 1070 Xbox One, 1080 PS3, 1090 Other under Console;
    // 4010/4020/4030/4040/4060/4070 plus 4050 itself under PC) without needing every one spelled
    // out; 8000 (Other) catches anything an indexer couldn't categorize more specifically.
    indexerCategory: "1000,4000,4050,8000",
    metadataProviders: ["rawg", "igdb", "screenscraper", "thegamesdb"],
    defaultProvider: "rawg",
  },
  video: {
    key: "video",
    label: "Online Videos",
    shape: "collection",
    childLabel: "Video",
    extensions: VIDEO_EXT,
    indexerCategory: "5000",
    metadataProviders: ["youtube", "vimeo"],
    defaultProvider: "youtube",
  },
  podcast: {
    key: "podcast",
    label: "Podcasts",
    shape: "collection",
    childLabel: "Episode",
    extensions: AUDIO_EXT,
    indexerCategory: "3000",
    // Not indexer-searched — episodes come straight from the show's own RSS feed (see
    // scheduler.ts's checkPodcastFeeds), the same "channel monitoring" pattern Online Videos
    // already uses for YouTube. iTunes' free, keyless podcast search API resolves a show name to
    // its feed URL at add-time; the feed itself is the only thing actually polled afterward.
    metadataProviders: ["itunes"],
    defaultProvider: "itunes",
  },
  course: {
    key: "course",
    label: "Courses",
    // A course folder is a "show" (its title is the folder name, never a provider match — there is
    // no viable public search API for arbitrary course platforms, same as before) and its lesson
    // files are its "episodes" — this is what lets a course keep a complete lesson list (including
    // ones with no season/module structure at all) the same way a TV show keeps a complete episode
    // list, instead of a flat unordered Lessons table.
    shape: "episodic",
    sequentialEpisodeFallback: true,
    extensions: [...VIDEO_EXT, ...BOOK_EXT],
    indexerCategory: "5000",
    metadataProviders: [],
    defaultProvider: null,
    sidecarFormat: "kodi-video",
  },
  adult: {
    key: "adult",
    label: "Adult",
    // A folder is a "show" (its title is the folder name, never a ThePornDB match) and its video
    // files are its "episodes" — ThePornDB stays as enrichment only (overview/poster), the same
    // role TMDB plays for Series, and can never rename the folder-derived title.
    shape: "episodic",
    sequentialEpisodeFallback: true,
    extensions: VIDEO_EXT,
    indexerCategory: "6000",
    metadataProviders: ["theporndb"],
    defaultProvider: "theporndb",
    sidecarFormat: "kodi-video",
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

/** Every type key sharing one shape — e.g. for building a `has_file`-aware SQL condition that
 * needs to treat all episodic types (or all collection types) the same way. Derived from
 * MEDIA_TYPES rather than hardcoded, so it can't drift out of sync when a new type is added. */
export function typeKeysByShape(shape: MediaShape): string[] {
  return Object.values(MEDIA_TYPES)
    .filter((t) => t.shape === shape)
    .map((t) => t.key);
}

/** A media_item's real shape, accounting for `legacy_shape` — a row stamped with one (only ever
 * "single" or "collection", on adult/course rows that predate their type's switch to "episodic")
 * keeps rendering/behaving under that OLD shape until an admin explicitly runs "Convert to
 * Episodic" for its library, at which point the stamp is cleared and it falls through to its
 * type's real, current shape below. Every other row (legacyShape null/undefined — the overwhelming
 * majority, and every row of every other type) is completely unaffected. */
export function effectiveShape(item: { type: string; legacyShape?: string | null }): MediaShape {
  return (item.legacyShape as MediaShape | null | undefined) ?? getMediaTypeConfig(item.type).shape;
}
