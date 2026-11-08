/** Any key from services/mediaTypes.ts's MEDIA_TYPES registry (movie, series, anime, artist, author, comic, rom, video, course, adult). */
export type MediaType = string;

export type MonitorStatus = 0 | 1;

export interface MediaItem {
  id: number;
  type: MediaType;
  title: string;
  sortTitle: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: string | null; // JSON string: { tmdb, tvdb, musicbrainz, goodreads, ... }
  path: string | null;
  rootFolderId: number | null;
  qualityProfileId: number | null;
  monitored: MonitorStatus;
  hasFile: MonitorStatus;
  quality: string | null;
  status: string; // e.g. "continuing", "ended", "announced", "released"
  addedAt: string;
  releaseDate: string | null;
  /** Movies only, from TMDB's separate /movie/{id}/release_dates endpoint — the earliest Digital/
   * Physical release dates, when TMDB has recorded them (most movies don't have these populated,
   * even once otherwise fully matched). See isReleaseAvailableForSearch, which prefers these over
   * the flat delay-based approximation whenever they're available. */
  digitalReleaseDate?: string | null;
  physicalReleaseDate?: string | null;
  /** Radarr-style search gate for "single"-shape types (movies): null/"announced" searches as
   * soon as added (today's behavior), "inCinemas" waits until releaseDate has passed, "released"
   * waits for the earliest of digitalReleaseDate/physicalReleaseDate when TMDB has one, else
   * releaseDate plus the configured delay (settings' minimumAvailabilityReleasedDelayDays) as an
   * approximation of a digital/home release window. */
  minimumAvailability: "announced" | "inCinemas" | "released" | null;
  /** "daily" (talk shows, news — named/searched by air date instead of season/episode) vs
   * null/"standard" (the default). Only meaningful for "episodic"-shape types (series, anime). */
  seriesType: "standard" | "daily" | null;
  /** Episodic items: the title's folder name below its root folder, fixed at the first import (or taken from the files
   * already there), so a title change does not split the show across two folders. Null until then. */
  libraryFolder: string | null;
  /** What a refresh does with an episode, album or book the provider lists after the first sync: all, none or new (null: the behavior from before this setting). */
  monitorNewItems: string | null;
  metadataProfileId: number | null;
  /** The import list that added the item. */
  sourceListId: number | null;
  /** Single-shape items only (movies/ROMs/adult) — when runAutoSearch last actually searched this
   * item, null if never. See scheduler.ts's per-cycle cap and oldest-searched-first ordering. */
  lastAutoSearchedAt?: string | null;
  /** Automatic searches in a row that grabbed nothing for this item (single-shape items only) — see services/searchBackoff.ts. */
  autoSearchMisses?: number;
}

export interface Episode {
  id: number;
  mediaItemId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: string | null;
  monitored: MonitorStatus;
  hasFile: MonitorStatus;
  quality: string | null;
  filePath: string | null;
}

/** Sub-items for artist (album) and author (book) media types. */
export interface SubItem {
  id: number;
  mediaItemId: number;
  title: string;
  releaseDate: string | null;
  monitored: MonitorStatus;
  hasFile: MonitorStatus;
  quality: string | null;
  filePath: string | null;
}

/** Not a fixed union at the type-system level — validated against the registered adapter set in
 * services/indexerClient.ts at the application layer, same reasoning as MediaType. */
export type IndexerProtocol = string;

/** DDL protocol config: the search source is a JSON API the admin points AoNarr at (never a
 * hardcoded or scraped site) — this describes how to pull an array of results out of its
 * response and which fields map to what. All field paths are dot-paths, e.g. "data.items". */
export interface DdlIndexerConfig {
  resultsPath: string | null; // null/"" = response is already the array
  titleField: string;
  sizeField: string | null;
  downloadUrlField: string;
  seedersField: string | null;
  publishDateField: string | null;
}

export interface Indexer {
  id: number;
  name: string;
  protocol: IndexerProtocol;
  url: string;
  apiKey: string | null;
  categories: string; // comma-separated category ids
  mediaTypes: string; // comma-separated MediaType this indexer applies to
  enabled: MonitorStatus;
  priority: number;
  /** Torrents with fewer seeders than this are rejected (0 = no minimum). */
  minimumSeeders?: number;
  /** Used only for an item that carries one of these tags; empty = every item. */
  tagIds?: number[];
  /** Read by the RSS sync. */
  enableRss?: number;
  /** Used by the scheduled searches. */
  enableAutomaticSearch?: number;
  /** Used by a search the admin starts. */
  enableInteractiveSearch?: number;
  /** Seed goals for torrents from this indexer; null falls back to the global goals. */
  seedRatio?: number | null;
  seedTimeMinutes?: number | null;
  /** The download client this indexer's releases go to; null picks one by protocol. */
  downloadClientId?: number | null;
  config: string | null; // JSON, protocol-specific (currently only "ddl" uses this)
  useFlareSolverr: MonitorStatus;
  queryLimitPerHour: number | null; // proactive rate cap — see indexerClient.ts's isOverQueryLimit
}

/** Same reasoning as IndexerProtocol — validated at the application layer. */
export type DownloadClientType = string;

export interface DownloadClient {
  id: number;
  name: string;
  type: DownloadClientType;
  host: string | null;
  port: number | null;
  useSsl: MonitorStatus;
  username: string | null;
  password: string | null;
  apiKey: string | null;
  category: string | null;
  enabled: MonitorStatus;
  audioOnly: MonitorStatus;
  /** Which release protocol(s) this client should be used for — only meaningful for a debrid
   * client type that can genuinely handle more than one (currently just TorBox, which caches both
   * torrents and Usenet; Real-Debrid/AllDebrid only ever do torrents). Null means "not configured",
   * which pickClientForProtocol treats as the historical torrent-only default so existing setups
   * are unaffected until an admin opts a client into another protocol. */
  downloadTypes: string[] | null;
  /** Used only for an item that carries one of these tags; empty = every item. */
  tagIds?: number[];
  /** 1 to 50, lower is preferred; clients of equal priority are ranked as before. */
  priority?: number;
  /** A reverse proxy's sub-path, e.g. "/qbittorrent". */
  urlBase?: string | null;
  /** The category a title of each media type is grabbed under; `category` is the default. */
  categoryByType?: Record<string, string> | null;
}

export interface QualityProfile {
  id: number;
  name: string;
  allowedQualities: string; // JSON array of quality names, ordered worst->best
  cutoff: string; // quality name at which upgrading stops
  minFormatScore?: number;
  /** Hard ceiling on release size, independent of any per-quality min/max size bounds (see
   * services/quality.ts's sizeWithinQualityBounds) — rejects a release outright if it's over this
   * regardless of which quality it parsed as. Null/undefined means no limit. */
  maxSizeGb?: number | null;
  /** True (the default): never pick a quality above the cutoff while one at or below it is on offer.
   * False: pick the best allowed quality, the cutoff only stops upgrades (Sonarr/Radarr). */
  preferCutoffQuality?: boolean;
  /** False: a file already on disk is never replaced by a better release. */
  upgradeAllowed?: boolean;
  /** Above 0: a file whose custom-format score is lower keeps being upgraded at the quality cutoff. */
  cutoffFormatScore?: number;
  /** The least a same-quality release must add to the file's score to replace it. */
  minUpgradeFormatScore?: number;
  /** The language a release must be in (a name from services/languages); null accepts every language. */
  language?: string | null;
}

export interface RootFolder {
  id: number;
  path: string;
  mediaType: MediaType;
  defaultQualityProfileId?: number | null;
  defaultMetadataProfileId?: number | null;
  defaultMonitor?: string | null;
  defaultMonitorNewItems?: string | null;
  defaultTagIds?: number[];
  /** Only scanned and served: no import goes into it, and its folder may be read-only. */
  readOnly?: boolean;
}

export type QueueStatus = "queued" | "downloading" | "completed" | "failed" | "importing" | "imported";

export interface QueueItem {
  id: number;
  mediaItemId: number;
  episodeId: number | null;
  subItemId: number | null;
  seasonNumber: number | null;
  title: string;
  indexerId: number | null;
  downloadClientId: number | null;
  downloadId: string | null;
  size: number | null;
  quality: string | null;
  status: QueueStatus;
  progress: number;
  addedAt: string;
  updatedAt: string;
  retryCount: number;
  /** Remote-path-mapping-translated location of this download on disk, as AoNarr sees it — set by
   * pollQueue when the download client reports one (qBittorrent's save_path/content_path,
   * SABnzbd's history "storage" field) and a mapping is configured for that client. Null when the
   * client reported no path, no mapping applies, or that adapter doesn't support it — importer.ts
   * falls back to its existing downloads-directory-wide fuzzy scan in that case. */
  downloadPath: string | null;
  /** Why a 'completed' row's import was skipped and is waiting for a manual import. */
  importSkippedReason?: string | null;
  /** How the release was confirmed to be this item when grabbed (services/releaseIdentity.ts's
   * matchType), null for rows older than the identity gate or for types it doesn't judge. */
  matchType?: string | null;
  /** What grabbed it: 'auto' (scheduled/bulk search), 'interactive' (manual search), 'irc', 'retry'. */
  grabSource?: string | null;
  /** The release's protocol, publish date and info hash as grabbed: what a blocklist row needs to block that release. */
  protocol?: string | null;
  publishDate?: string | null;
  infoHash?: string | null;
}

export interface HistoryEvent {
  id: number;
  mediaItemId: number;
  eventType: "grabbed" | "held" | "imported" | "failed" | "deleted" | "subtitleDownloaded";
  data: string | null; // JSON blob
  createdAt: string;
}

export interface SearchResult {
  indexerId: number | null;
  indexerName: string;
  title: string;
  size: number;
  seeders: number | null;
  leechers: number | null;
  publishDate: string | null;
  downloadUrl: string;
  protocol: "torrent" | "usenet" | "http" | "slskd";
  category: string | null;
  /** Torznab's downloadvolumefactor attribute — 0 = freeleech, 0.5 = halfleech, 1 = normal, null =
   * not reported by this indexer. See customFormatScoring.ts's "indexerFlag" condition type. */
  downloadVolumeFactor?: number | null;
  /** An external id the indexer itself reported for this specific release, via Torznab's `imdb`/
   * `tmdbid` attrs (not every indexer sends these) — a much stronger identity signal than anything
   * extracted from the title text, since it comes from the indexer's own catalog data rather than
   * a regex guess. See scheduler.ts's chooseBestResult for how this and a title-parsed id are used
   * together to prefer a confirmed match without ever excluding an unconfirmed one. */
  imdbId?: string | null;
  tmdbId?: string | null;
  /** The show's tvdb id as the indexer reports it (`tvdbid`): the identity gate accepts a release
   * whose id is the series' own, as Sonarr's FindSeries does. */
  tvdbId?: string | null;
  /** Torznab's `infohash` and `magneturl` attributes, when the feed carries them. */
  infoHash?: string | null;
  magnetUrl?: string | null;
  /** Torznab's `uploadvolumefactor` (2 = double upload) and `tag` attributes (freeleech, internal,
   * scene, ...), the rest of what Sonarr reads as indexer flags. */
  uploadVolumeFactor?: number | null;
  indexerTags?: string[];
}
