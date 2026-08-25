/** Any key published by GET /api/media-types (movie, series, anime, artist, author, comic, rom, video, course, adult). */
export type MediaType = string;

export interface MediaTypeInfo {
  key: MediaType;
  label: string;
  shape: "single" | "episodic" | "collection";
  childLabel: string | null;
  hasMetadataSearch: boolean;
  multiFilePerChild: boolean;
  groupLevels: string[];
}

export interface LibraryGroup {
  id: number;
  mediaType: MediaType;
  kind: string;
  name: string;
  overview: string | null;
  parentGroupId: number | null;
  itemCount?: number;
  haveCount?: number;
  missingCount?: number;
}

export interface AudioStreamInfo {
  codec: string | null;
  channels: number | null;
  channelLayout: string | null;
  language: string | null;
  bitrateKbps: number | null;
  default: boolean;
}

export interface SubtitleStreamInfo {
  codec: string | null;
  language: string | null;
  forced: boolean;
  default: boolean;
}

export type HdrFormat = "none" | "hdr10" | "hdr10plus" | "hlg" | "dolby-vision" | "dolby-vision-hdr10" | "unknown";

export interface MediaInfo {
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  audioChannels: number | null;
  durationSeconds: number | null;
  colorTransfer?: string | null;
  colorPrimaries?: string | null;
  colorSpace?: string | null;
  bitDepth?: number | null;
  hdrFormat?: HdrFormat;
  frameRate?: number | null;
  audioStreams?: AudioStreamInfo[];
  subtitleStreams?: SubtitleStreamInfo[];
}

export interface MediaItem {
  id: number;
  type: MediaType;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: string | null;
  path: string | null;
  rootFolderId: number | null;
  qualityProfileId: number | null;
  monitored: 0 | 1;
  hasFile: 0 | 1;
  quality: string | null;
  protected: 0 | 1;
  status: string;
  groupId: number | null;
  extraMetadata: Record<string, { title: string; year: number | null; overview: string | null; posterUrl: string | null }>;
  addedAt: string;
  mediaInfo: MediaInfo | null;
  contentRating: string | null;
  /** Episode/album-level download progress for "episodic"/"collection"-shape types (series, anime,
   * music, books, ...) — absent for "single"-shape types (movies, ROMs, adult), which have no
   * children and whose own hasFile is the whole picture. */
  childCount?: number;
  childHaveCount?: number;
  releaseDate: string | null;
  minimumAvailability: "announced" | "inCinemas" | "released" | null;
}

export interface Indexer {
  id: number;
  name: string;
  protocol: "torznab" | "newznab" | "rss" | "ddl";
  url: string;
  apiKey: string | null;
  categories: string;
  mediaTypes: string;
  enabled: 0 | 1;
  priority: number;
  config: string | null;
  useFlareSolverr: 0 | 1;
  health?: IndexerHealth;
}

export interface IndexerHealth {
  totalChecks: number;
  successCount: number;
  successRate: number | null;
  avgResponseTimeMs: number | null;
  lastCheckedAt: string | null;
  lastSuccess: boolean | null;
  lastError: string | null;
}

export interface DownloadClient {
  id: number;
  name: string;
  type: "qbittorrent" | "sabnzbd" | "http" | "ytdlp" | "realdebrid" | "alldebrid" | "blackhole" | "slskd";
  host: string | null;
  port: number | null;
  useSsl: 0 | 1;
  username: string | null;
  password: string | null;
  apiKey: string | null;
  category: string | null;
  enabled: 0 | 1;
  audioOnly: 0 | 1;
}

export interface QualityProfile {
  id: number;
  name: string;
  allowedQualities: string[];
  cutoff: string;
  minFormatScore: number;
}

export interface RootFolder {
  id: number;
  path: string;
  mediaType: MediaType;
  freeBytes?: number | null;
  totalBytes?: number | null;
  percentUsed?: number | null;
  quotaPercent?: number | null;
  pauseGrabsAtQuota?: 0 | 1;
}

export interface Quality {
  id: number;
  name: string;
  rank: number;
  minSizeMb: number | null;
  maxSizeMb: number | null;
  preferredSizeMb: number | null;
}

export interface Tag {
  id: number;
  name: string;
  retentionDays: number | null;
}

export interface SmartFilter {
  type?: string;
  monitored?: 0 | 1;
  hasFile?: 0 | 1;
  tagId?: number;
  addedAfterDays?: number;
}

export interface Collection {
  id: number;
  name: string;
  description: string | null;
  itemCount?: number;
  retentionDays: number | null;
  smartFilter: SmartFilter | null;
}

export interface Track {
  id: number;
  subItemId: number;
  trackNumber: number;
  title: string;
  durationSeconds: number | null;
  hasFile: 0 | 1;
  filePath: string | null;
}

export interface ConditionGroup {
  type?: "title" | "size" | "language" | "releaseGroup" | "source" | "resolution" | "year" | "releaseFlags";
  patterns?: string[];
  minMb?: number | null;
  maxMb?: number | null;
  languages?: string[];
  sources?: string[];
  resolutions?: string[];
  minYear?: number | null;
  maxYear?: number | null;
  flags?: string[];
  negate: boolean;
}

export interface CustomFormat {
  id: number;
  name: string;
  conditionGroups: ConditionGroup[];
  mediaTypes: MediaType[]; // empty = applies to every library type
}

export interface QueueItem {
  id: number;
  mediaItemId: number;
  title: string;
  status: string;
  progress: number;
  size: number | null;
  quality: string | null;
  addedAt: string;
  retryCount: number;
}

export interface User {
  id: number;
  username: string;
  role: string;
  createdAt: string;
  allowedTypes: string[];
  maxPendingRequests: number | null;
  autoApprove: 0 | 1;
  maxContentRating: string | null;
}

export interface Session {
  token: string;
  userId: number;
  username: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  userAgent: string | null;
}

export interface RequestStats {
  userId: number;
  username: string;
  totalRequests: number;
  pending: number;
  approved: number;
  rejected: number;
  approvalRatePercent: number | null;
  storageBytes: number;
}

export interface MediaRequest {
  id: number;
  userId: number;
  type: MediaType;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: string | null;
  status: "pending" | "approved" | "rejected";
  mediaItemId: number | null;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AuthMe {
  isAdmin: boolean;
  user?: { id: number; username: string; role: string; allowedTypes: string[]; totpEnabled?: boolean };
}

export interface SearchResult {
  indexerId: number;
  indexerName: string;
  title: string;
  size: number;
  seeders: number | null;
  leechers: number | null;
  publishDate: string | null;
  downloadUrl: string;
  protocol: "torrent" | "usenet";
  parsedQuality: string;
  matchesTarget: boolean;
  allowedByProfile: boolean;
  sizeAllowed: boolean;
  formatScore: number;
  formatMatches: string[];
  blocklisted: boolean;
}

export interface BlocklistEntry {
  id: number;
  mediaItemId: number;
  releaseTitle: string;
  reason: string | null;
  createdAt: string;
  mediaTitle: string;
}

export interface ImportExclusion {
  id: number;
  type: MediaType;
  title: string;
  year: number | null;
  externalId: string | null;
  externalProvider: string | null;
  reason: string | null;
  createdAt: string;
}

export interface JobStatus {
  key: string;
  name: string;
  scheduleType: "cron" | "interval";
  schedule: string;
  running: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | "cancelled" | null;
  lastError: string | null;
  lastDurationMs: number | null;
}

export interface RecycleBinEntry {
  id: number;
  mediaItemId: number | null;
  mediaType: MediaType;
  title: string;
  originalPath: string;
  sizeBytes: number | null;
  deletedAt: string;
  restoring: boolean;
  restoreError: string | null;
}

export interface SavedLibraryView {
  id: number;
  mediaType: MediaType;
  name: string;
  config: {
    sortKey: string;
    statusFilter: string;
    tagFilter: number | "all";
    contentRatingFilter: string;
    viewMode: string;
    posterSize: string;
    listColumns: string[];
    posterFields: string[];
  };
  createdAt: string;
}

export interface CorruptMediaReviewEntry {
  id: number;
  mediaItemId: number;
  mediaType: MediaType;
  title: string;
  filePath: string;
  reason: string;
  detectedAt: string;
}

export interface DuplicateGroupItem {
  id: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  hasFile: boolean;
  path: string | null;
  monitored: boolean;
  addedAt: string | null;
  childCount: number;
  suggestedKeeper: boolean;
  quality: string | null;
  contentRating: string | null;
  matchedProviders: string[];
}

export interface DuplicateGroup {
  type: MediaType;
  title: string;
  year: number | null;
  key: string;
  items: DuplicateGroupItem[];
}
