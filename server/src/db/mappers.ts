/** better-sqlite3 returns raw column names (snake_case); map rows to the camelCase API types. */

export function mediaItemFromRow(row: any) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    sortTitle: row.sort_title,
    year: row.year,
    overview: row.overview,
    posterUrl: row.poster_url,
    externalIds: row.external_ids,
    path: row.path,
    rootFolderId: row.root_folder_id,
    qualityProfileId: row.quality_profile_id,
    monitored: row.monitored,
    hasFile: row.has_file,
    quality: row.quality,
    protected: row.protected,
    status: row.status,
    addedAt: row.added_at,
    mediaInfo: row.media_info ? JSON.parse(row.media_info) : null,
    contentRating: row.content_rating,
    groupId: row.group_id,
    extraMetadata: row.extra_metadata ? JSON.parse(row.extra_metadata) : {},
    releaseDate: row.release_date,
    minimumAvailability: row.minimum_availability,
    seriesType: row.series_type,
  };
}

export function libraryGroupFromRow(row: any) {
  return {
    id: row.id,
    mediaType: row.media_type,
    kind: row.kind,
    name: row.name,
    overview: row.overview,
    parentGroupId: row.parent_group_id,
  };
}

export function episodeFromRow(row: any) {
  return {
    id: row.id,
    mediaItemId: row.media_item_id,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    title: row.title,
    airDate: row.air_date,
    overview: row.overview,
    monitored: row.monitored,
    hasFile: row.has_file,
    quality: row.quality,
    filePath: row.file_path,
    mediaInfo: row.media_info ? JSON.parse(row.media_info) : null,
  };
}

export function subItemFromRow(row: any) {
  return {
    id: row.id,
    mediaItemId: row.media_item_id,
    title: row.title,
    releaseDate: row.release_date,
    externalId: row.external_id,
    externalProvider: row.external_provider,
    monitored: row.monitored,
    hasFile: row.has_file,
    quality: row.quality,
    filePath: row.file_path,
    mediaInfo: row.media_info ? JSON.parse(row.media_info) : null,
    posterUrl: row.poster_url ?? null,
  };
}

export function indexerFromRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    url: row.url,
    apiKey: row.api_key,
    categories: row.categories,
    mediaTypes: row.media_types,
    enabled: row.enabled,
    priority: row.priority,
    config: row.config,
    useFlareSolverr: row.use_flaresolverr,
  };
}

export function downloadClientFromRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    host: row.host,
    port: row.port,
    useSsl: row.use_ssl,
    username: row.username,
    password: row.password,
    apiKey: row.api_key,
    category: row.category,
    enabled: row.enabled,
    audioOnly: row.audio_only,
  };
}

export function qualityProfileFromRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    allowedQualities: JSON.parse(row.allowed_qualities),
    cutoff: row.cutoff,
    minFormatScore: row.min_format_score,
  };
}

export function rootFolderFromRow(row: any) {
  return {
    id: row.id,
    path: row.path,
    mediaType: row.media_type,
    lastScannedAt: row.last_scanned_at,
    quotaPercent: row.quota_percent,
    pauseGrabsAtQuota: row.pause_grabs_at_quota,
  };
}

export function queueItemFromRow(row: any) {
  return {
    id: row.id,
    mediaItemId: row.media_item_id,
    episodeId: row.episode_id,
    subItemId: row.sub_item_id,
    seasonNumber: row.season_number,
    title: row.title,
    indexerId: row.indexer_id,
    downloadClientId: row.download_client_id,
    downloadId: row.download_id,
    size: row.size,
    quality: row.quality,
    status: row.status,
    progress: row.progress,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    retryCount: row.retry_count ?? 0,
  };
}

export function historyEventFromRow(row: any) {
  return {
    id: row.id,
    mediaItemId: row.media_item_id,
    eventType: row.event_type,
    data: row.data,
    createdAt: row.created_at,
  };
}

export function qualityFromRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    rank: row.rank,
    minSizeMb: row.min_size_mb,
    maxSizeMb: row.max_size_mb,
    preferredSizeMb: row.preferred_size_mb,
  };
}

export function tagFromRow(row: any) {
  return { id: row.id, name: row.name, retentionDays: row.retention_days };
}

export function customFormatFromRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    conditionGroups: JSON.parse(row.patterns),
    mediaTypes: row.media_types ? JSON.parse(row.media_types) : [],
    trashId: row.trash_id ?? null,
  };
}

export function trackFromRow(row: any) {
  return {
    id: row.id,
    subItemId: row.sub_item_id,
    trackNumber: row.track_number,
    title: row.title,
    durationSeconds: row.duration_seconds,
    hasFile: row.has_file,
    filePath: row.file_path,
  };
}

export function collectionFromRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    retentionDays: row.retention_days,
    smartFilter: row.smart_filter ? JSON.parse(row.smart_filter) : null,
  };
}

export function userFromRow(row: any) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at,
    maxPendingRequests: row.max_pending_requests,
    autoApprove: row.auto_approve,
    maxContentRating: row.max_content_rating,
  };
}

export function requestFromRow(row: any) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    year: row.year,
    overview: row.overview,
    posterUrl: row.poster_url,
    externalIds: row.external_ids,
    status: row.status,
    mediaItemId: row.media_item_id,
    note: row.note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function importReviewItemFromRow(row: any) {
  return {
    id: row.id,
    source: row.source,
    importListId: row.import_list_id,
    type: row.type,
    title: row.title,
    year: row.year,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function subtitleProviderFromRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    apiKey: row.api_key,
    languages: row.languages,
    enabled: row.enabled,
    config: row.config ? JSON.parse(row.config) : null,
  };
}

export function iptvPlaylistFromRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    insertAfterMinutes: row.insert_after_minutes,
    insertAfterEachItem: row.insert_after_each_item,
  };
}

export function iptvPlaylistItemFromRow(row: any) {
  return {
    id: row.id,
    playlistId: row.playlist_id,
    position: row.position,
    title: row.title,
    externalUrl: row.external_url,
    mediaItemId: row.media_item_id,
    episodeId: row.episode_id,
    durationSeconds: row.duration_seconds,
  };
}

export function iptvFillerClipFromRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    category: row.category,
    enabled: row.enabled,
  };
}

export function aiProviderFromRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.model,
    enabled: row.enabled,
    isDefault: row.is_default,
  };
}

export function customColumnFromRow(row: any) {
  return {
    id: row.id,
    mediaType: row.media_type,
    label: row.label,
    path: row.path,
    position: row.position,
  };
}

export function savedLibraryViewFromRow(row: any) {
  return {
    id: row.id,
    mediaType: row.media_type,
    name: row.name,
    config: JSON.parse(row.config),
    createdAt: row.created_at,
  };
}
