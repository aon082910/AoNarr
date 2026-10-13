// Assembles the whole SQL plan (everything the HTTP API cannot or should not create) plus the
// manifest of ids the route sweep needs. Pure function of FIXED_NOW and the ids the API phase
// produced - no clock reads, no randomness outside the seeded rng() streams.
import { buildMedia } from "./media.mjs";
import { poster, square } from "./art.mjs";
import { FIXED_NOW, ago, sqlTs, dayOffset, rng, hexId, safeName, pad2 } from "./util.mjs";

export const ROOT_DEFS = [
  { key: "movie", id: 1, path: "/media/movies", type: "movie", name: "Movies", quota: 90, minFree: 200 },
  { key: "movie4k", id: 2, path: "/media/movies-4k", type: "movie", name: "Movies (4K)", quota: null, minFree: 500 },
  { key: "series", id: 3, path: "/media/tv", type: "series", name: "TV Shows", quota: 85, minFree: 150 },
  { key: "anime", id: 4, path: "/media/anime", type: "anime", name: "Anime", quota: null, minFree: null },
  { key: "artist", id: 5, path: "/media/music", type: "artist", name: "Music", quota: null, minFree: 50 },
  { key: "author", id: 6, path: "/media/books", type: "author", name: "Books", quota: null, minFree: null },
  { key: "audiobook", id: 7, path: "/media/audiobooks", type: "audiobook", name: "Audiobooks", quota: null, minFree: null },
  { key: "comic", id: 8, path: "/media/comics", type: "comic", name: "Comics", quota: null, minFree: null },
  { key: "rom", id: 9, path: "/media/roms", type: "rom", name: "ROMs", quota: null, minFree: null },
  { key: "sports", id: 10, path: "/media/sports", type: "sports", name: "Sports", quota: null, minFree: null },
  { key: "podcast", id: 11, path: "/media/podcasts", type: "podcast", name: "Podcasts", quota: null, minFree: null },
  { key: "course", id: 12, path: "/media/courses", type: "course", name: "Courses", quota: null, minFree: null },
  { key: "ppv", id: 13, path: "/media/ppv", type: "ppv", name: "Sports PPV", quota: null, minFree: null },
  { key: "manga", id: 14, path: "/media/manga", type: "manga", name: "Manga", quota: null, minFree: null },
  { key: "video", id: 15, path: "/media/videos", type: "video", name: "Online Videos", quota: null, minFree: null },
];

const TAGS = [
  { id: 1, name: "4k", retention: null },
  { id: 2, name: "kids", retention: null },
  { id: 3, name: "keep", retention: null },
  { id: 4, name: "new", retention: null },
  { id: 5, name: "watch-once", retention: 30 },
];

const pick = (obj, cols) => Object.fromEntries(cols.map((c) => [c, obj[c] ?? null]));

const ITEM_COLS = ["id", "type", "title", "sort_title", "year", "overview", "poster_url", "external_ids", "path", "root_folder_id", "quality_profile_id", "monitored", "has_file", "quality", "protected", "status", "added_at", "release_date", "backdrop_url", "rating", "runtime_minutes", "size_bytes", "studio", "media_info", "content_rating", "group_id", "extra_metadata", "minimum_availability", "series_type", "digital_release_date", "physical_release_date", "genres"];
const EPISODE_COLS = ["id", "media_item_id", "season_number", "episode_number", "title", "air_date", "overview", "monitored", "has_file", "quality", "file_path", "media_info", "size_bytes", "absolute_episode_number"];
const SEASON_COLS = ["id", "media_item_id", "season_number", "poster_url"];
const SUB_COLS = ["id", "media_item_id", "title", "release_date", "external_id", "external_provider", "monitored", "has_file", "quality", "file_path", "series_name", "series_position", "narrator", "media_info", "poster_url", "size_bytes", "overview"];
const TRACK_COLS = ["id", "sub_item_id", "track_number", "title", "duration_seconds", "has_file", "file_path"];

function releaseName(title, year, quality, group) {
  const t = title.replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, ".");
  const tag = {
    "Remux-2160p": "2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.7.1",
    "Bluray-1080p": "1080p.BluRay.DTS.5.1.x264",
    "WEBDL-1080p": "1080p.WEB-DL.DDP5.1.H.264",
    "WEBDL-720p": "720p.WEB-DL.DD5.1.H.264",
    "HDTV-720p": "720p.HDTV.x264",
  }[quality] ?? "1080p.WEB-DL.H.264";
  return `${t}${year ? "." + year : ""}.${tag}-${group}`;
}

const GROUPS = ["LANTERN", "GRAYSCALE", "ORCHID", "NORTHTIDE", "EMBERFALL", "KESTREL"];

/**
 * @param {{
 *   adminId: number,
 *   users: { household: {id:number,username:string}, alex: {id:number,username:string}, sam: {id:number,username:string} },
 *   indexers: {id:number,name:string,protocol:string}[],
 *   clients: {id:number,name:string,type:string}[],
 * }} api
 */
export function buildPlan(api) {
  const ops = [];
  const dirs = [];
  const r = rng("fixtures");
  const sql = (s, params = []) => ops.push({ kind: "sql", sql: s, params });
  const insert = (table, rows, cols) => {
    if (!rows.length) return;
    const c = cols ?? Object.keys(rows[0]);
    ops.push({ kind: "insert", table, cols: c, rows: rows.map((row) => c.map((k) => (row[k] === undefined ? null : row[k]))) });
  };

  // ----------------------------------------------------------------- foundations
  const roots = Object.fromEntries(ROOT_DEFS.map((d) => [d.key, { id: d.id, path: d.path }]));
  insert(
    "root_folders",
    ROOT_DEFS.map((d) => ({
      id: d.id, path: d.path, media_type: d.type, name: d.name, last_scanned_at: sqlTs(ago({ days: 1, hours: 2 })),
      quota_percent: d.quota, pause_grabs_at_quota: d.quota ? 1 : 0, min_free_space_gb: d.minFree,
    }))
  );
  for (const d of ROOT_DEFS) dirs.push(d.path);
  dirs.push("/downloads", "/downloads/complete", "/downloads/incomplete");

  insert("quality_profiles", [
    { id: 2, name: "HD-1080p", allowed_qualities: JSON.stringify(["HDTV-1080p", "WEBDL-1080p", "Bluray-1080p"]), cutoff: "WEBDL-1080p", min_format_score: 0, max_size_gb: 25 },
    { id: 3, name: "Ultra HD", allowed_qualities: JSON.stringify(["WEBDL-2160p", "Bluray-2160p", "Remux-2160p"]), cutoff: "Bluray-2160p", min_format_score: 50, max_size_gb: null },
  ]);
  const profiles = { any: 1, hd: 2, uhd: 3 };

  insert("tags", TAGS.map((t) => ({ id: t.id, name: t.name, retention_days: t.retention })));
  insert("library_groups", [
    { id: 1, media_type: "rom", kind: "system", name: "Portable Classic", sort_name: "portable classic", overview: "Handheld cartridge systems from the 1990s.", created_at: sqlTs(ago({ days: 40 })) },
    { id: 2, media_type: "rom", kind: "system", name: "Pocket Console", sort_name: "pocket console", overview: "Compact home-and-travel console library.", created_at: sqlTs(ago({ days: 40 })) },
  ]);
  const groups = { "Portable Classic": 1, "Pocket Console": 2 };

  const CF = [
    { id: 1, name: "Remux", patterns: [{ type: "source", sources: ["Remux"], negate: false }], types: ["movie", "series"] },
    { id: 2, name: "Avoid Bad Groups", patterns: [{ type: "releaseGroup", patterns: ["^(NOGRP|SAMPLE)$"], negate: false }], types: null },
    { id: 3, name: "Proper / Repack", patterns: [{ type: "releaseFlags", flags: ["proper", "repack"], negate: false }], types: null },
    { id: 4, name: "Freeleech", patterns: [{ type: "indexerFlag", indexerFlags: ["freeleech"], negate: false }], types: ["movie", "series", "anime"] },
  ];
  insert("custom_formats", CF.map((c) => ({ id: c.id, name: c.name, patterns: JSON.stringify(c.patterns), media_types: c.types ? JSON.stringify(c.types) : null, trash_id: null })));
  insert("quality_profile_format_scores", [
    { quality_profile_id: 1, custom_format_id: 3, score: 5 },
    { quality_profile_id: 2, custom_format_id: 3, score: 5 },
    { quality_profile_id: 2, custom_format_id: 4, score: 10 },
    { quality_profile_id: 3, custom_format_id: 1, score: 100 },
    { quality_profile_id: 3, custom_format_id: 2, score: -1000 },
  ]);
  insert("release_profiles", [
    { id: 1, name: "No cam rips", enabled: 1, must_contain: "[]", must_not_contain: JSON.stringify(["CAM", "HDCAM", "TELESYNC"]), preferred: JSON.stringify([{ term: "REPACK", score: 10 }]), media_types: JSON.stringify(["movie"]), indexer_ids: null, tag_ids: null },
    { id: 2, name: "Prefer dual audio (anime)", enabled: 1, must_contain: "[]", must_not_contain: "[]", preferred: JSON.stringify([{ term: "Dual Audio", score: 25 }]), media_types: JSON.stringify(["anime"]), indexer_ids: null, tag_ids: null },
  ]);
  insert("delay_profiles", [
    { id: 1, tag_id: null, enable_usenet: 1, enable_torrent: 1, usenet_delay_minutes: 0, torrent_delay_minutes: 20, bypass_if_highest_quality: 1, order_index: 0 },
    { id: 2, tag_id: 1, enable_usenet: 1, enable_torrent: 1, usenet_delay_minutes: 0, torrent_delay_minutes: 60, bypass_if_highest_quality: 0, order_index: 1 },
  ]);

  // ----------------------------------------------------------------- media
  const media = buildMedia({ roots, profiles, groups });
  const refs = media.refs;
  insert("media_items", media.items.map((i) => pick(i, ITEM_COLS)), ITEM_COLS);
  insert("seasons", media.seasons.map((s) => pick(s, SEASON_COLS)), SEASON_COLS);
  insert("episodes", media.episodes.map((e) => pick(e, EPISODE_COLS)), EPISODE_COLS);
  insert("sub_items", media.subItems.map((s) => pick(s, SUB_COLS)), SUB_COLS);
  insert("tracks", media.tracks.map((t) => pick(t, TRACK_COLS)), TRACK_COLS);

  const tagIdByName = Object.fromEntries(TAGS.map((t) => [t.name, t.id]));
  const itemTags = [];
  for (const [idStr, m] of Object.entries(media.meta)) for (const t of m.tags) itemTags.push({ media_item_id: Number(idStr), tag_id: tagIdByName[t] });
  for (const k of ["Echoes of Kestrel Bay", "Brass Monkeys of Dunmore"]) itemTags.push({ media_item_id: refs[k], tag_id: 5 });
  insert("media_item_tags", itemTags);

  const epId = (show, s, e) => media.episodes.find((x) => x.media_item_id === refs[show] && x.season_number === s && x.episode_number === e)?.id ?? null;
  const itemById = new Map(media.items.map((i) => [i.id, i]));

  // collections
  const neon = [refs["Neon Harbor"], refs["Neon Harbor II: Undertow"], refs["Neon Harbor III: Afterglow"]];
  insert("collections", [
    { id: 1, name: "Neon Harbor Saga", description: "The complete harbor trilogy, including the unreleased finale.", retention_days: null, smart_filter: null },
    { id: 2, name: "Cozy Evenings", description: "A film, a series and an album for a slow night in.", retention_days: null, smart_filter: null },
    { id: 3, name: "Keepers", description: "Everything tagged keep.", retention_days: null, smart_filter: JSON.stringify({ tagId: 3 }) },
    { id: 4, name: "Family Night", description: "Safe picks for the whole household.", retention_days: null, smart_filter: null },
  ]);
  insert("collection_items", [
    ...neon.map((id, i) => ({ collection_id: 1, media_item_id: id, position: i })),
    { collection_id: 2, media_item_id: refs["Saltwater Hymn"], position: 0 },
    { collection_id: 2, media_item_id: refs["Harbor Lights"], position: 1 },
    { collection_id: 2, media_item_id: refs["The Velvet Lanterns"], position: 2 },
    { collection_id: 4, media_item_id: refs["The Cartographer's Daughter"], position: 0 },
    { collection_id: 4, media_item_id: refs["Cartwheel Court"], position: 1 },
    { collection_id: 4, media_item_id: refs["Long Way to Lumen"], position: 2 },
  ]);

  // public share links + invites (deterministic tokens so the manifest never changes between runs)
  const tokens = {
    share: hexId("e2e-share-valid"),
    shareExpired: hexId("e2e-share-expired"),
    shareMissing: hexId("e2e-share-never-created"),
    invite: hexId("e2e-invite-valid", 40),
    inviteUsed: hexId("e2e-invite-used", 40),
    inviteExpired: hexId("e2e-invite-expired", 40),
    inviteMissing: hexId("e2e-invite-never-created", 40),
  };
  insert("share_links", [
    { id: 1, token: tokens.share, media_item_id: refs["The Lantern Keepers"], created_at: sqlTs(ago({ days: 6 })), expires_at: null },
    { id: 2, token: tokens.shareExpired, media_item_id: refs["Harbor Lights"], created_at: sqlTs(ago({ days: 70 })), expires_at: "2026-09-01T00:00:00.000Z" },
  ]);
  insert("user_invites", [
    { id: 1, token: tokens.invite, allowed_types: JSON.stringify(["movie", "series"]), max_content_rating: "PG-13", role: "user", created_at: sqlTs(ago({ days: 2 })), expires_at: null, used_at: null, used_by_user_id: null },
    { id: 2, token: tokens.inviteUsed, allowed_types: JSON.stringify(["movie"]), max_content_rating: "PG", role: "user", created_at: sqlTs(ago({ days: 40 })), expires_at: null, used_at: "2026-09-10T18:22:00.000Z", used_by_user_id: api.users.alex.id },
    { id: 3, token: tokens.inviteExpired, allowed_types: JSON.stringify(["series", "anime"]), max_content_rating: "TV-14", role: "user", created_at: sqlTs(ago({ days: 60 })), expires_at: "2026-09-20T00:00:00.000Z", used_at: null, used_by_user_id: null },
  ]);

  // ----------------------------------------------------------------- people
  const setUserSql = (id, created, extra = {}) => {
    sql("UPDATE users SET created_at = ?, display_name = COALESCE(?, display_name), bio = COALESCE(?, bio), social_links = COALESCE(?, social_links) WHERE id = ?", [
      sqlTs(created), extra.displayName ?? null, extra.bio ?? null, extra.social ? JSON.stringify(extra.social) : null, id,
    ]);
  };
  setUserSql(api.adminId, ago({ days: 140 }), { displayName: "Test Admin", bio: "Throwaway administrator for the redesign test instance." });
  setUserSql(api.users.household.id, ago({ days: 120 }), { displayName: "Jordan Household", bio: "Movie nights and weekend marathons.", social: [{ label: "Fan page", url: "http://127.0.0.1:9/jordan" }] });
  setUserSql(api.users.alex.id, ago({ days: 62 }), { displayName: "Alex Guest" });
  setUserSql(api.users.sam.id, ago({ days: 45 }), { displayName: "Sam Guest", bio: "Mostly anime." });
  sql("UPDATE users SET auto_approve = 1 WHERE id = ?", [api.users.alex.id]);

  insert("sessions", [
    { token: hexId("e2e-session-household-1", 64), user_id: api.users.household.id, created_at: sqlTs(ago({ days: 3 })), expires_at: "2026-11-12T12:00:00.000Z", last_used_at: sqlTs(ago({ hours: 5 })), user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36" },
    { token: hexId("e2e-session-household-2", 64), user_id: api.users.household.id, created_at: sqlTs(ago({ days: 9 })), expires_at: "2026-11-12T12:00:00.000Z", last_used_at: sqlTs(ago({ days: 1, hours: 3 })), user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile Safari/604.1" },
    { token: hexId("e2e-session-alex-1", 64), user_id: api.users.alex.id, created_at: sqlTs(ago({ days: 12 })), expires_at: "2026-11-12T12:00:00.000Z", last_used_at: sqlTs(ago({ days: 2 })), user_agent: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0" },
  ]);

  // requests
  const reqRows = [
    { id: 1, u: api.users.household, type: "movie", title: "Glimmer Cove", year: 2026, ov: "A lighthouse keeper's daughter finds a message in a bottle addressed to her.", status: "pending", days: 1 },
    { id: 2, u: api.users.household, type: "series", title: "Orbit Kitchen", year: 2026, ov: "A cooking competition aboard a slowly rotating space station.", status: "pending", days: 2 },
    { id: 3, u: api.users.household, type: "author", title: "Feather & Flint", year: null, ov: "A fantasy series about two rival firekeepers.", status: "pending", days: 3 },
    { id: 4, u: api.users.household, type: "movie", title: "Tidebreakers", year: 2025, ov: "A struggling surf club trains for a regional cup.", status: "approved", mediaKey: "Tidebreakers", days: 29, resolved: 28 },
    { id: 5, u: api.users.household, type: "movie", title: "The Glass Orchard", year: 2024, ov: "In a greenhouse kingdom, every wish grows as a fruit.", status: "approved", mediaKey: "The Glass Orchard", days: 28, resolved: 27 },
    { id: 6, u: api.users.household, type: "series", title: "Reality Dating Island", year: 2025, ov: "Strangers are stranded on an island and asked to fall in love.", status: "rejected", days: 33, resolved: 32, note: "Not a fit for the household library." },
    { id: 7, u: api.users.alex, type: "movie", title: "Dino Drift", year: 2026, ov: "Prehistoric animals take up street racing.", status: "pending", days: 4 },
    { id: 8, u: api.users.alex, type: "movie", title: "Starling Protocol", year: 2026, ov: "An analyst notices a flock of satellites behaving like birds.", status: "approved", mediaKey: "Starling Protocol", days: 13, resolved: 13 },
    { id: 9, u: api.users.sam, type: "anime", title: "Hollow Knights Academy", year: 2026, ov: "First-years at a school for knight-errants discover the library is alive.", status: "pending", days: 5 },
  ];
  insert("requests", reqRows.map((q) => ({
    id: q.id, user_id: q.u.id, type: q.type, title: q.title, year: q.year, overview: q.ov, poster_url: poster(q.title, q.year ? String(q.year) : undefined),
    external_ids: JSON.stringify({ tmdb: String(990000 + q.id) }), status: q.status, media_item_id: q.mediaKey ? refs[q.mediaKey] : null, note: q.note ?? null,
    created_at: sqlTs(ago({ days: q.days, hours: 3 })), resolved_at: q.resolved != null ? sqlTs(ago({ days: q.resolved, hours: 1 })) : null,
  })));

  // ----------------------------------------------------------------- indexers: health samples
  const idxHealth = [];
  api.indexers.forEach((ix, k) => {
    for (let n = 0; n < 24; n++) {
      const failing = (ix.protocol === "rss" && n % 3 === 0) || (k === 3 && n % 2 === 0);
      idxHealth.push({
        indexer_id: ix.id, success: failing ? 0 : 1, response_time_ms: failing ? null : 180 + Math.round(r() * 900),
        error: failing ? "connect ECONNREFUSED 127.0.0.1:9" : null, checked_at: sqlTs(ago({ hours: 3 + n * 2.5 })),
      });
    }
  });
  insert("indexer_health", idxHealth);
  const IX = api.indexers;
  const CL = api.clients;
  const clientByType = (t) => CL.find((c) => c.type === t)?.id ?? CL[0].id;

  // ----------------------------------------------------------------- queue
  const qbit = clientByType("qbittorrent");
  const sab = clientByType("sabnzbd");
  const queueRows = [];
  const q = (o) => queueRows.push({
    id: queueRows.length + 1, media_item_id: o.media, episode_id: o.ep ?? null, sub_item_id: o.sub ?? null, season_number: o.season ?? null, title: o.title,
    indexer_id: o.ix, download_client_id: o.client, download_id: hexId("dl-" + o.title, 40), size: o.size, quality: o.quality ?? null, status: o.status,
    progress: o.progress, added_at: sqlTs(o.added), updated_at: sqlTs(o.updated ?? o.added), last_progress_at: o.status === "downloading" ? sqlTs(o.updated ?? o.added) : null,
    download_path: o.path ?? null, import_started_at: null, import_skipped_reason: o.skipped ?? null, import_resume_state: 0, retry_count: o.retry ?? 0,
  });
  q({ media: refs["Copperfield Mutiny"], title: "Copperfield.Mutiny.2026.1080p.WEB-DL.DDP5.1.H.264-LANTERN", ix: IX[0].id, client: qbit, size: 5_400_000_000, quality: "WEBDL-1080p", status: "downloading", progress: 0.47, added: ago({ minutes: 52 }), updated: ago({ minutes: 1 }) });
  q({ media: refs["Kestrel County"], ep: epId("Kestrel County", 2, 4), title: "Kestrel.County.S02E04.1080p.WEB-DL.DDP5.1.H.264-KESTREL", ix: IX[0].id, client: qbit, size: 1_900_000_000, quality: "WEBDL-1080p", status: "downloading", progress: 0.12, added: ago({ minutes: 14 }), updated: ago({ minutes: 1 }) });
  q({ media: refs["Tales of the Clockwork Hollow"], ep: epId("Tales of the Clockwork Hollow", 1, 9), title: "Tales.of.the.Clockwork.Hollow.S01E09.1080p.WEB-DL.AAC2.0.H.264-GRAYSCALE", ix: IX[1].id, client: sab, size: 1_400_000_000, quality: "WEBDL-1080p", status: "downloading", progress: 0.88, added: ago({ minutes: 33 }), updated: ago({ minutes: 1 }) });
  q({ media: refs["Mapmakers of Aldermere"], season: 1, title: "Mapmakers.of.Aldermere.S01.1080p.WEB-DL.DDP5.1.H.264-ORCHID", ix: IX[1].id, client: sab, size: 18_600_000_000, quality: "WEBDL-1080p", status: "downloading", progress: 0.63, added: ago({ hours: 2, minutes: 10 }), updated: ago({ minutes: 2 }) });
  q({ media: refs["Tidebreakers"], title: "Tidebreakers.2025.1080p.BluRay.DTS.5.1.x264-NORTHTIDE", ix: IX[0].id, client: qbit, size: 9_800_000_000, quality: "Bluray-1080p", status: "queued", progress: 0, added: ago({ minutes: 20 }) });
  q({ media: refs["The Quiet Division"], ep: epId("The Quiet Division", 2, 7), title: "The.Quiet.Division.S02E07.1080p.WEB-DL.DDP5.1.H.264-EMBERFALL", ix: IX[1].id, client: sab, size: 2_100_000_000, quality: "WEBDL-1080p", status: "queued", progress: 0, added: ago({ minutes: 9 }) });
  q({ media: refs["The Glass Orchard"], title: "The.Glass.Orchard.2024.1080p.WEB-DL.DDP5.1.H.264-LANTERN", ix: IX[0].id, client: qbit, size: 4_300_000_000, quality: "WEBDL-1080p", status: "queued", progress: 0, added: ago({ days: 2, hours: 4 }) });
  q({ media: refs["Orlo Finch Tonight"], ep: epId("Orlo Finch Tonight", 1, 6), title: "Orlo.Finch.Tonight.2026.10.05.720p.HDTV.x264-KESTREL", ix: IX[2].id, client: qbit, size: 820_000_000, quality: "HDTV-720p", status: "completed", progress: 1, added: ago({ hours: 5 }), updated: ago({ hours: 4 }), path: "/downloads/complete/Orlo.Finch.Tonight.2026.10.05.720p.HDTV.x264-KESTREL", skipped: "No video file found in the download folder (only a .nfo and a sample)." });
  q({ media: refs["Moonlit Dungeon Diaries"], ep: epId("Moonlit Dungeon Diaries", 1, 2), title: "Moonlit.Dungeon.Diaries.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRAYSCALE", ix: IX[1].id, client: sab, size: 1_300_000_000, quality: "WEBDL-1080p", status: "failed", progress: 0.31, added: ago({ hours: 11 }), updated: ago({ hours: 9 }), retry: 2 });
  q({ media: refs["The Quiet Division"], ep: epId("The Quiet Division", 2, 8), title: "The.Quiet.Division.S02E08.720p.HDTV.x264-NOGRP", ix: IX[2].id, client: qbit, size: 640_000_000, quality: "HDTV-720p", status: "failed", progress: 0.02, added: ago({ days: 1, hours: 6 }), updated: ago({ days: 1, hours: 5 }), retry: 1 });
  insert("queue", queueRows);

  // ----------------------------------------------------------------- history
  const hist = [];
  const addHist = (media, type, data, when) => hist.push({ media_item_id: media, event_type: type, data: JSON.stringify(data), created_at: sqlTs(when) });
  let grp = 0;
  for (const it of media.items) {
    if (it.type === "movie" && it.has_file) {
      const added = new Date(it.added_at.replace(" ", "T") + "Z");
      const rel = releaseName(it.title, it.year, it.quality, GROUPS[grp++ % GROUPS.length]);
      const ix = IX[grp % 2];
      addHist(it.id, "grabbed", { title: rel, indexer: ix.name, indexerId: ix.id, quality: it.quality, size: it.size_bytes, protocol: ix.protocol === "newznab" ? "usenet" : "torrent" }, new Date(added.getTime() + 2 * 3600e3));
      addHist(it.id, "imported", { title: it.title, fileName: it.path.split("/").pop(), destPath: it.path, quality: it.quality }, new Date(added.getTime() + 3.2 * 3600e3));
      if (grp % 3 === 0) addHist(it.id, "subtitleDownloaded", { language: "eng", fileName: it.path.split("/").pop().replace(/\.mkv$/, ".en.srt") }, new Date(added.getTime() + 4 * 3600e3));
    }
  }
  const showsForHist = ["Harbor Lights", "The Quiet Division", "Kestrel County", "Salt & Static", "Cartwheel Court", "Tales of the Clockwork Hollow", "Orlo Finch Tonight", "Premier Harbor League 2026"];
  for (const key of showsForHist) {
    const id = refs[key];
    const eps = media.episodes.filter((e) => e.media_item_id === id && e.has_file).slice(-5);
    eps.forEach((e, i) => {
      const air = e.air_date ? new Date(e.air_date + "T02:00:00Z") : ago({ days: 20 });
      let when = new Date(Math.min(air.getTime() + 20 * 3600e3, FIXED_NOW.getTime() - (8 - i) * 3600e3));
      const rel = releaseName(`${key} S${pad2(e.season_number)}E${pad2(e.episode_number)}`, null, e.quality, GROUPS[(grp++) % GROUPS.length]);
      const ix = IX[(i + 1) % 2];
      addHist(id, "grabbed", { title: rel, indexer: ix.name, indexerId: ix.id, quality: e.quality, size: e.size_bytes, protocol: ix.protocol === "newznab" ? "usenet" : "torrent" }, when);
      addHist(id, "imported", { title: `${key} S${pad2(e.season_number)}E${pad2(e.episode_number)}`, fileName: e.file_path.split("/").pop(), destPath: e.file_path, quality: e.quality }, new Date(when.getTime() + 25 * 60e3));
    });
  }
  for (const key of ["The Velvet Lanterns", "Orchard Kings", "Odalys Renwick", "Wren Hallowell"]) {
    const id = refs[key];
    const sub = media.subItems.find((s) => s.media_item_id === id && s.has_file);
    if (!sub) continue;
    addHist(id, "grabbed", { title: `${key} - ${sub.title} (FLAC)`, indexer: IX[0].name, indexerId: IX[0].id, quality: sub.quality, protocol: "torrent" }, ago({ days: 18, hours: 3 }));
    addHist(id, "imported", { title: sub.title, fileName: sub.title, destPath: sub.file_path, quality: sub.quality }, ago({ days: 18, hours: 2 }));
  }
  const failures = [
    [refs["Copperfield Mutiny"], "Download failed: release was removed from the indexer", 1],
    [refs["Tidebreakers"], "Import failed: sample file only (14 MB)", 2],
    [refs["The Glass Orchard"], "Download stalled for 24 hours and was cancelled", 3],
    [refs["Mapmakers of Aldermere"], "Import failed: password-protected archive", 4],
    [refs["Moonlit Dungeon Diaries"], "Download failed: SABnzbd reported an unpack error", 0.4],
    [refs["Midnight Orchid (2)"], "Import failed: wrong language (FRENCH)", 5],
    [refs["The Quiet Division"], "Import failed: no video file found", 1.5],
    [refs["Kestrel County"], "Download failed: connection timed out", 6],
  ];
  failures.forEach(([id, reason, d], i) => {
    const it = itemById.get(id);
    addHist(id, "failed", { title: releaseName(it.title, it.year, "WEBDL-1080p", GROUPS[(i + 2) % GROUPS.length]), reason }, ago({ days: d, hours: 1 }));
  });
  addHist(refs["Dust of a Thousand Suns"], "auto_archived", { reason: "Watched by every household member and untouched for 90 days", fileName: "Dust of a Thousand Suns (2011).mkv" }, ago({ days: 12 }));
  insert("history", hist);

  // ----------------------------------------------------------------- blocklist
  const blRows = [
    ["Midnight Orchid (2)", "Midnight.Orchid.2018.FRENCH.1080p.WEB-DL.x264-NOGRP", "Wrong language (FRENCH)", 5],
    ["Tidebreakers", "Tidebreakers.2025.1080p.WEB-DL.SAMPLE-NOGRP", "Sample file only", 2],
    ["The Glass Orchard", "The.Glass.Orchard.2024.2160p.UHD.BluRay.x265-NOGRP", "Failed import: corrupt archive", 3],
    ["Mapmakers of Aldermere", "Mapmakers.of.Aldermere.S01.720p.HDTV.x264-NOGRP", "Password-protected archive", 4],
    ["Copperfield Mutiny", "Copperfield.Mutiny.2026.1080p.CAM.x264-NOGRP", "Cam rip (release profile)", 1],
    ["Kestrel County", "Kestrel.County.S02E04.1080p.WEB-DL.DDP5.1.H.264-FAKE", "Fake / mislabeled release", 6],
    ["The Quiet Division", "The.Quiet.Division.S02E09.1080p.WEB-DL.x264-NOGRP", "Failed import: no video file", 1],
    ["Moonlit Dungeon Diaries", "Moonlit.Dungeon.Diaries.S01E02.1080p.WEB-DL.x264-NOGRP", "Unpack error", 0.4],
    ["Starling Protocol", "Starling.Protocol.2026.1080p.TELESYNC.x264-NOGRP", "Telesync (release profile)", 0.5],
    ["Mega Maze Runner", "Mega.Maze.Runner.1994.REPACK.zip", "Wrong platform", 7],
  ];
  insert("blocklist", blRows.map(([key, title, reason, d], i) => ({ id: i + 1, media_item_id: refs[key], release_title: title, indexer_id: IX[i % IX.length].id, reason, created_at: sqlTs(ago({ days: d, hours: 2 })) })));

  // ----------------------------------------------------------------- watch events (Recently Watched)
  const we = [];
  const watch = (media, ep, sub, when) => we.push({ media_item_id: media, episode_id: ep, sub_item_id: sub, watched_at: sqlTs(when) });
  watch(refs["Winterlight Station"], null, null, ago({ hours: 20 }));
  watch(refs["Kestrel County"], epId("Kestrel County", 2, 3), null, ago({ days: 1, hours: 4 }));
  watch(refs["Harbor Lights"], epId("Harbor Lights", 3, 8), null, ago({ days: 1, hours: 20 }));
  watch(refs["The Lantern Keepers"], null, null, ago({ days: 2, hours: 6 }));
  watch(refs["Cartwheel Court"], epId("Cartwheel Court", 2, 5), null, ago({ days: 2, hours: 21 }));
  watch(refs["Saltwater Hymn"], null, null, ago({ days: 3, hours: 2 }));
  watch(refs["The Velvet Lanterns"], null, media.subItems.find((s) => s.title === "Slow Fires").id, ago({ days: 3, hours: 18 }));
  watch(refs["Tales of the Clockwork Hollow"], epId("Tales of the Clockwork Hollow", 1, 8), null, ago({ days: 4, hours: 9 }));
  watch(refs["A Quiet Orbit"], null, null, ago({ days: 5, hours: 1 }));
  watch(refs["Paper Moon Heist"], null, null, ago({ days: 6, hours: 7 }));
  watch(refs["The Quiet Division"], epId("The Quiet Division", 2, 5), null, ago({ days: 7 }));
  watch(refs["Neon Harbor"], null, null, ago({ days: 9 }));
  insert("watch_events", we);

  // ----------------------------------------------------------------- recycle bin + corrupt review + duplicates
  insert("recycle_bin", [
    { id: 1, media_item_id: null, media_type: "movie", title: "Pocket Full of Thunder", original_path: "/media/movies/Pocket Full of Thunder (2009)/Pocket Full of Thunder (2009) [WEBDL-1080p].mkv", recycle_path: "/config/recycle-bin/movie/Pocket Full of Thunder (2009) [WEBDL-1080p]-1760300000-a1b2.mkv", size_bytes: 4_480_000_000, deleted_at: sqlTs(ago({ days: 3 })), restoring: 0, restore_error: null },
    { id: 2, media_item_id: refs["Midnight Orchid (2)"], media_type: "movie", title: "Midnight Orchid", original_path: "/media/movies/Midnight Orchid (2018)/Midnight Orchid (2018) [HDTV-720p].mkv", recycle_path: "/config/recycle-bin/movie/Midnight Orchid (2018) [HDTV-720p]-1760200000-c3d4.mkv", size_bytes: 1_920_000_000, deleted_at: sqlTs(ago({ days: 5 })), restoring: 0, restore_error: null },
    { id: 3, media_item_id: null, media_type: "series", title: "Reality Dating Island", original_path: "/media/tv/Reality Dating Island (2025)/Season 01/Reality Dating Island - S01E01 [HDTV-720p].mkv", recycle_path: "/config/recycle-bin/series/Reality Dating Island - S01E01 [HDTV-720p]-1760100000-e5f6.mkv", size_bytes: 610_000_000, deleted_at: sqlTs(ago({ days: 8 })), restoring: 0, restore_error: null },
    { id: 4, media_item_id: null, media_type: "artist", title: "Orchard Kings - Grafted (draft)", original_path: "/media/music/Orchard Kings/Grafted (2022)/01 - Graft.flac", recycle_path: "/config/recycle-bin/artist/01 - Graft-1760000000-0a1b.flac", size_bytes: 31_000_000, deleted_at: sqlTs(ago({ days: 11 })), restoring: 0, restore_error: null },
    { id: 5, media_item_id: null, media_type: "author", title: "Tomas Aldecott - Notes from the Observatory", original_path: "/media/books/Tomas Aldecott/Notes from the Observatory.epub", recycle_path: "/config/recycle-bin/author/Notes from the Observatory-1759900000-2c3d.epub", size_bytes: 2_300_000, deleted_at: sqlTs(ago({ days: 14 })), restoring: 0, restore_error: "Original folder no longer exists - choose a different destination." },
  ]);
  insert("corrupt_media_review", [
    { id: 1, table_name: "media_items", row_id: refs["Velvet Static"], media_item_id: refs["Velvet Static"], media_type: "movie", file_path: itemById.get(refs["Velvet Static"]).path, title: "Velvet Static", reason: "ffprobe: moov atom not found", detected_at: sqlTs(ago({ days: 2 })) },
    { id: 2, table_name: "media_items", row_id: refs["Ghosts of Marigold Lane"], media_item_id: refs["Ghosts of Marigold Lane"], media_type: "movie", file_path: itemById.get(refs["Ghosts of Marigold Lane"]).path, title: "Ghosts of Marigold Lane", reason: "Duration mismatch: container says 94 min, stream ends at 61 min", detected_at: sqlTs(ago({ days: 2 })) },
  ]);
  insert("duplicate_group_seen", [{ id: 1, type: "movie", normalized_key: "movie::midnight orchid::2018", first_seen_at: sqlTs(ago({ days: 9 })), dismissed: 0 }]);

  // ----------------------------------------------------------------- imports and lists
  const listRows = [
    { id: 1, name: "Trakt - Weekly Watchlist", type: "trakt", url: "http://127.0.0.1:9/trakt/users/demo/watchlist", enabled: 1, quality_profile_id: 2, last_synced_at: sqlTs(ago({ hours: 7 })), last_added_count: 3, last_error: null, min_rating: 6.5, min_votes: 1000, exclude_genres: JSON.stringify(["reality", "documentary"]), root_folder_id: 1, created_at: sqlTs(ago({ days: 80 })), require_review: 1 },
    { id: 2, name: "IMDb - Top Sci-Fi", type: "imdb", url: "http://127.0.0.1:9/imdb/list/ls000000001", enabled: 1, quality_profile_id: 3, last_synced_at: sqlTs(ago({ hours: 7, minutes: 3 })), last_added_count: 0, last_error: "connect ECONNREFUSED 127.0.0.1:9", min_rating: null, min_votes: null, exclude_genres: null, root_folder_id: 2, created_at: sqlTs(ago({ days: 60 })), require_review: 0 },
    { id: 3, name: "TMDB - Upcoming Family", type: "tmdb", url: "http://127.0.0.1:9/tmdb/list/8000001", enabled: 0, quality_profile_id: 1, last_synced_at: null, last_added_count: null, last_error: null, min_rating: 6, min_votes: 500, exclude_genres: null, root_folder_id: 1, created_at: sqlTs(ago({ days: 20 })), require_review: 0 },
  ];
  insert("import_lists", listRows);
  const rv = [
    [1, "movie", "Glass Harbor", 2024, "pending", 1], [1, "movie", "Tin Soldier's Return", 2023, "pending", 1], [1, "series", "The Orchard Murders", 2025, "pending", 2],
    [1, "movie", "Aurora Station (Director's Cut)", 2022, "pending", 2], [2, "movie", "Quasar Run", 2021, "pending", 3], [1, "series", "Lanternfish", 2026, "pending", 3],
    [1, "movie", "Bellwether", 2019, "resolved", 6], [1, "movie", "Nightjar", 2018, "dismissed", 7], [2, "movie", "Orbital Decay", 2020, "dismissed", 8],
  ];
  insert("import_review_items", rv.map(([lid, type, title, year, status, d], i) => ({ id: i + 1, source: listRows[lid - 1].name, import_list_id: lid, type, title, year, status, created_at: sqlTs(ago({ days: d })), resolved_at: status === "pending" ? null : sqlTs(ago({ days: d - 1 })) })));
  insert("import_exclusions", [
    { id: 1, type: "movie", title: "Frozen Wasteland 4", year: 2023, external_id: "880001", external_provider: "tmdb", reason: "Not interested", created_at: sqlTs(ago({ days: 50 })) },
    { id: 2, type: "series", title: "Reality Dating Island", year: 2025, external_id: "880002", external_provider: "tmdb", reason: "Rejected request", created_at: sqlTs(ago({ days: 32 })) },
    { id: 3, type: "movie", title: "Bad Santa Claus Returns", year: 2022, external_id: "880003", external_provider: "tmdb", reason: "Wrong tone for the household", created_at: sqlTs(ago({ days: 28 })) },
    { id: 4, type: "anime", title: "Isekai Vending Machine", year: 2025, external_id: "880004", external_provider: "anilist", reason: "Duplicate of an existing series", created_at: sqlTs(ago({ days: 15 })) },
  ]);

  // ----------------------------------------------------------------- calendar, columns, views
  insert("custom_calendar_events", [
    { id: 1, title: "Family movie night", date: dayOffset(1), note: "Pick from Family Night", created_at: sqlTs(ago({ days: 4 })) },
    { id: 2, title: "Storage review", date: dayOffset(5), note: "Check root folder quotas", created_at: sqlTs(ago({ days: 3 })) },
    { id: 3, title: "Kestrel County watch party", date: dayOffset(9), note: "Season 2, episode 6", created_at: sqlTs(ago({ days: 2 })) },
  ]);
  insert("custom_columns", [
    { id: 1, media_type: "movie", label: "Video codec", path: "mediaInfo.videoCodec", position: 0 },
    { id: 2, media_type: null, label: "Studio / network", path: "studio", position: 1 },
  ]);
  insert("saved_library_views", [
    { id: 1, media_type: "movie", name: "Missing, newest first", config: JSON.stringify({ sortKey: "added", statusFilter: "missing", tagFilter: "all", contentRatingFilter: "all", viewMode: "poster", posterSize: "medium" }), created_at: sqlTs(ago({ days: 10 })) },
    { id: 2, media_type: "movie", name: "4K remuxes", config: JSON.stringify({ sortKey: "sizeOnDisk", statusFilter: "downloaded", tagFilter: "1", contentRatingFilter: "all", viewMode: "table" }), created_at: sqlTs(ago({ days: 9 })) },
  ]);

  // ----------------------------------------------------------------- integrations (all unreachable placeholders)
  insert("ai_providers", [
    { id: 1, name: "Local model (placeholder)", type: "local", base_url: "http://127.0.0.1:9/v1", api_key: null, model: "demo-model", enabled: 1, is_default: 1 },
    { id: 2, name: "Cloud model (placeholder)", type: "cloud", base_url: "http://127.0.0.1:9/cloud/v1", api_key: "placeholder-not-a-key", model: "demo-large", enabled: 0, is_default: 0 },
  ]);
  insert("irc_feeds", [
    { id: 1, name: "Example announce channel", host: "127.0.0.1", port: 9, use_ssl: 0, nickname: "aonarr-e2e", sasl_user: null, sasl_pass: null, channel: "#announce", announce_regex: "New: (?<title>.+) - (?<url>https?://\\S+)", protocol: "torrent", enabled: 0, created_at: sqlTs(ago({ days: 30 })), announcers: "announcebot" },
  ]);
  insert("friend_libraries", [
    { id: 1, name: "Casey's Plex", type: "plex", url: "http://127.0.0.1:9/plex", token: "placeholder-not-a-token", created_at: sqlTs(ago({ days: 44 })) },
    { id: 2, name: "Dana's Jellyfin", type: "jellyfin", url: "http://127.0.0.1:9/jellyfin", token: "placeholder-not-a-token", created_at: sqlTs(ago({ days: 12 })) },
  ]);
  insert("remote_instances", [{ id: 1, name: "Cabin instance", url: "http://127.0.0.1:9", api_key: "placeholder-not-a-key", created_at: sqlTs(ago({ days: 50 })) }]);
  insert("remote_path_mappings", [{ id: 1, download_client_id: qbit, remote_path: "/data/torrents/complete", local_path: "/downloads/complete", created_at: sqlTs(ago({ days: 70 })) }]);
  insert("subtitle_providers", [{ id: 1, name: "OpenSubtitles (placeholder)", type: "opensubtitles", api_key: null, languages: "eng,spa", enabled: 1, config: null }]);
  insert("release_group_stats", [
    { release_group: "LANTERN", successes: 31, failures: 1 }, { release_group: "GRAYSCALE", successes: 24, failures: 2 }, { release_group: "ORCHID", successes: 12, failures: 0 },
    { release_group: "NORTHTIDE", successes: 9, failures: 3 }, { release_group: "NOGRP", successes: 1, failures: 14 },
  ]);

  // IPTV
  insert("iptv_filler_clips", [
    { id: 1, name: "Station ident (10s)", url: "http://127.0.0.1:9/filler/ident.mp4", category: "idents", enabled: 1 },
    { id: 2, name: "Intermission card (30s)", url: "http://127.0.0.1:9/filler/intermission.mp4", category: "bumpers", enabled: 1 },
  ]);
  insert("iptv_playlists", [
    { id: 1, name: "Weeknight Marathon", enabled: 1, insert_after_minutes: 45, insert_after_each_item: 0, filler_url: null },
    { id: 2, name: "Retro Block", enabled: 0, insert_after_minutes: null, insert_after_each_item: 1, filler_url: "http://127.0.0.1:9/filler/ident.mp4" },
  ]);
  insert("iptv_playlist_items", [
    { id: 1, playlist_id: 1, position: 0, title: "Harbor Lights S03E07", external_url: null, media_item_id: refs["Harbor Lights"], episode_id: epId("Harbor Lights", 3, 7), duration_seconds: 2820 },
    { id: 2, playlist_id: 1, position: 1, title: "Harbor Lights S03E08", external_url: null, media_item_id: refs["Harbor Lights"], episode_id: epId("Harbor Lights", 3, 8), duration_seconds: 2820 },
    { id: 3, playlist_id: 1, position: 2, title: "A Quiet Orbit", external_url: null, media_item_id: refs["A Quiet Orbit"], episode_id: null, duration_seconds: 8280 },
    { id: 4, playlist_id: 1, position: 3, title: "Community channel (external)", external_url: "http://127.0.0.1:9/stream/live.m3u8", media_item_id: null, episode_id: null, duration_seconds: null },
    { id: 5, playlist_id: 2, position: 0, title: "Brass Monkeys of Dunmore", external_url: null, media_item_id: refs["Brass Monkeys of Dunmore"], episode_id: null, duration_seconds: 5820 },
  ]);
  insert("iptv_playlist_fillers", [{ id: 1, playlist_id: 1, filler_clip_id: 1, position: 0 }, { id: 2, playlist_id: 1, filler_clip_id: 2, position: 1 }]);

  // ----------------------------------------------------------------- audit log
  const rA = rng("audit");
  const actors = [
    { id: api.adminId, name: "e2e-admin", w: 5 },
    { id: api.users.household.id, name: api.users.household.username, w: 4 },
    { id: api.users.alex.id, name: api.users.alex.username, w: 2 },
    { id: api.users.sam.id, name: api.users.sam.username, w: 1 },
  ];
  const wheel = actors.flatMap((a) => Array(a.w).fill(a));
  const media_names = media.items.filter((i) => i.type === "movie" || i.type === "series").map((i) => i.title);
  const auditRows = [];
  let aId = 1000;
  for (let n = 0; n < 150; n++) {
    const a = wheel[Math.floor(rA() * wheel.length)];
    const when = ago({ days: n * 0.2, hours: Math.floor(rA() * 5), minutes: Math.floor(rA() * 59) });
    let ev;
    let detail = null;
    let who = a;
    const roll = rA();
    if (roll < 0.42) ev = "login";
    else if (roll < 0.47) ev = "logout";
    else if (roll < 0.52) { ev = "login_failed"; detail = null; who = { id: null, name: ["admin", "root", "test", a.name][Math.floor(rA() * 4)] }; }
    else if (a.id === api.adminId) {
      const choices = [
        ["media_added", () => media_names[Math.floor(rA() * media_names.length)]],
        ["request_approved", () => ["Tidebreakers", "The Glass Orchard", "Starling Protocol"][Math.floor(rA() * 3)]],
        ["request_rejected", () => "Reality Dating Island"],
        ["media_rematched", () => media_names[Math.floor(rA() * media_names.length)]],
        ["media_deleted", () => "1 item(s) via bulk remove"],
        ["user_permissions_changed", () => `${api.users.alex.username}: allowed libraries → movie`],
        ["recycle_bin_restore_all", () => "2 item(s)"],
        ["corrupt_media_dismissed", () => "Velvet Static"],
        ["backup_downloaded", () => "aonarr-backup-2026-10.zip"],
      ];
      const c = choices[Math.floor(rA() * choices.length)];
      ev = c[0];
      detail = c[1]();
    } else {
      ev = rA() < 0.7 ? "request_submitted" : "login";
      if (ev === "request_submitted") detail = ["Glimmer Cove", "Orbit Kitchen", "Dino Drift", "Hollow Knights Academy"][Math.floor(rA() * 4)];
    }
    auditRows.push({ id: aId++, user_id: who.id, username: who.name, event_type: ev, detail, created_at: sqlTs(when) });
  }
  insert("audit_log", auditRows);
  // rows the API phase wrote while seeding (setup events): pin them to a fixed, plausible morning
  sql("UPDATE audit_log SET created_at = datetime('2026-10-06 09:00:00', '+' || (id * 7) || ' minutes') WHERE id < 1000");

  // ----------------------------------------------------------------- disk samples (resolved in the container against real statfs)
  ops.push({ kind: "disk_samples", folderIds: ROOT_DEFS.map((d) => d.id), perDayBytes: { 1: 6e9, 2: 14e9, 3: 4e9, 4: 2e9, 5: 1e9, 6: 2e7, 7: 3e8, 8: 5e8, 9: 2e8, 10: 8e8, 11: 1e8, 12: 3e8, 13: 5e8, 14: 1e8, 15: 3e8 }, days: 14, fixedNowMs: FIXED_NOW.getTime() });

  // ----------------------------------------------------------------- manifest
  const first = (pred) => media.items.find(pred);
  const album = media.subItems.find((s) => s.title === "Slow Fires");
  const albumTrack = media.tracks.find((t) => t.sub_item_id === album.id && t.track_number === 1);
  const book = media.subItems.find((s) => s.title === "The Tin Lighthouse");
  const audiobookSub = media.subItems.find((s) => s.title.startsWith("The Tin Lighthouse (Unabridged)"));
  const audiobookTrack = media.tracks.find((t) => t.sub_item_id === audiobookSub.id && t.track_number === 1);
  const comicSub = media.subItems.find((s) => s.title === "Captain Marrow #1");
  const podcastSub = media.subItems.find((s) => s.title === "A Brief History of Umbrellas");
  const kestrelEp = epId("Kestrel County", 2, 1);
  const ep = (show, s, e) => ({ mediaId: refs[show], episodeId: epId(show, s, e) });
  const p = {
    movieId: refs["The Lantern Keepers"],
    movieMissingId: refs["Tidebreakers"],
    movieUnreleasedId: refs["Neon Harbor III: Afterglow"],
    movieUnmonitoredId: refs["Dust of a Thousand Suns"],
    movieDuplicateIds: [refs["Midnight Orchid"], refs["Midnight Orchid (2)"]],
    seriesId: refs["Harbor Lights"],
    seriesPartialId: refs["The Quiet Division"],
    seriesAiringId: refs["Kestrel County"],
    seriesMissingId: refs["Mapmakers of Aldermere"],
    episodeMediaId: refs["Kestrel County"],
    episodeId: kestrelEp,
    episodeMissing: ep("The Quiet Division", 2, 7),
    animeId: refs["Tales of the Clockwork Hollow"],
    sportsId: refs["Premier Harbor League 2026"],
    courseId: refs["Intro to Watercolor Landscapes"],
    artistId: refs["The Velvet Lanterns"],
    albumSubItemId: album.id,
    trackId: albumTrack.id,
    authorId: refs["Odalys Renwick"],
    bookSubItemId: book.id,
    audiobookId: refs["Odalys Renwick (audiobook)"],
    audiobookSubItemId: audiobookSub.id,
    audiobookTrackId: audiobookTrack.id,
    comicId: refs["Captain Marrow"],
    comicSubItemId: comicSub.id,
    romId: refs["Turbo Tortoise Racing"],
    podcastId: refs["The Late Lantern Podcast"],
    podcastSubItemId: podcastSub.id,
    collectionId: 1,
    smartCollectionId: 3,
    libraryGroupId: 1,
    calendarDate: dayOffset(2),
    calendarDateBusy: dayOffset(2),
    shareToken: tokens.share,
    shareTokenExpired: tokens.shareExpired,
    shareTokenMissing: tokens.shareMissing,
    inviteToken: tokens.invite,
    inviteTokenUsed: tokens.inviteUsed,
    inviteTokenExpired: tokens.inviteExpired,
    inviteTokenMissing: tokens.inviteMissing,
    personTmdbId: null,
    ppvId: refs["Rumble Night: Titans of the Ring"],
    mangaId: refs["Rin of the Seven Bridges"],
    videoChannelId: refs["Workshop Wednesdays"],
  };
  const counts = {
    mediaItems: media.items.length, seasons: media.seasons.length, episodes: media.episodes.length, subItems: media.subItems.length, tracks: media.tracks.length,
    sparseFiles: media.files.length, queue: queueRows.length, history: hist.length, blocklist: blRows.length, auditRows: auditRows.length, requests: reqRows.length,
  };
  const byType = {};
  for (const i of media.items) byType[i.type] = (byType[i.type] ?? 0) + 1;
  // Placeholder backup bundles (empty sparse files with fixed mtimes) so System -> Backups lists something.
  const backups = [
    [ago({ days: 0, hours: 9 }), 18.4],
    [ago({ days: 1, hours: 9 }), 18.1],
    [ago({ days: 2, hours: 9 }), 17.8],
    [ago({ days: 7, hours: 9 }), 16.2],
  ].map(([when, mb]) => ({
    path: `/config/backups/aonarr-backup-${when.toISOString().replace(/[:.]/g, "-")}.aonarrbackup`,
    size: Math.round(mb * 1024 * 1024),
    mtimeMs: when.getTime(),
  }));
  counts.backups = backups.length;
  return { plan: { ops, dirs, files: [...media.files, ...backups] }, params: p, tokens, counts, byType, refs, media: { episodes: media.episodes.length } };
}
