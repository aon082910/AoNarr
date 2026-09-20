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
  /** Radarr-style search gate for "single"-shape types (movies): null/"announced" searches as
   * soon as added (today's behavior), "inCinemas" waits until releaseDate has passed, "released"
   * waits releaseDate plus the configured delay (settings' minimumAvailabilityReleasedDelayDays)
   * — an approximation of a digital/home release window since AoNarr only stores one release date
   * per item, not TMDB's separate per-type release dates. */
  minimumAvailability: "announced" | "inCinemas" | "released" | null;
  /** "daily" (talk shows, news — named/searched by air date instead of season/episode) vs
   * null/"standard" (the default). Only meaningful for "episodic"-shape types (series, anime). */
  seriesType: "standard" | "daily" | null;
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
}

export interface RootFolder {
  id: number;
  path: string;
  mediaType: MediaType;
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
}

export interface HistoryEvent {
  id: number;
  mediaItemId: number;
  eventType: "grabbed" | "imported" | "failed" | "deleted" | "subtitleDownloaded";
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
}
