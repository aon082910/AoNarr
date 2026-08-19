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
  parentGroupId: number | null;
}

export interface MediaInfo {
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  audioChannels: number | null;
  durationSeconds: number | null;
}

export interface MediaItem {
  id: number;
  type: MediaType;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
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
}

export interface DownloadClient {
  id: number;
  name: string;
  type: "qbittorrent" | "sabnzbd" | "http" | "ytdlp";
  host: string | null;
  port: number | null;
  useSsl: 0 | 1;
  username: string | null;
  password: string | null;
  apiKey: string | null;
  category: string | null;
  enabled: 0 | 1;
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
  type?: "title" | "size" | "language" | "releaseGroup";
  patterns?: string[];
  minMb?: number | null;
  maxMb?: number | null;
  languages?: string[];
  negate: boolean;
}

export interface CustomFormat {
  id: number;
  name: string;
  conditionGroups: ConditionGroup[];
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
