#!/usr/bin/env node
// Seeds the throwaway aonarr-e2e instance so every page renders realistic, non-empty, fictional content.
//
//   node web-e2e/seed/seed.mjs            (start.sh runs this for you)
//
// Phase A (HTTP API, as the test admin): freeze the scheduler, create household users, indexers and
//   download clients - everything that needs hashing/encryption or has real validation.
// Phase B (direct SQLite, inside the container): media, history, queue, audit rows and the rest - the
//   things the API cannot create (history, blocklist, recycle bin, duplicates, backdated audit rows)
//   or that would call external metadata providers if created through the API.
//
// Deterministic: all dates derive from FIXED_NOW (2026-10-13T12:00:00Z). Credentials come from
// web-e2e/.auth/test-creds.json and are never printed. Targets 127.0.0.1 only.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPlan } from "./lib/fixtures.mjs";
import { FIXED_NOW, dayOffset } from "./lib/util.mjs";
import { verify } from "./verify.mjs";

process.env.DO_NOT_TRACK = "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E = path.dirname(HERE);
const AUTH_DIR = path.join(E2E, ".auth");
const TMP_DIR = path.join(E2E, ".tmp");
const CONTAINER = "aonarr-e2e";
const BASE = process.env.AONARR_E2E_URL ?? "http://127.0.0.1:8989";

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error(`refusing to seed ${BASE}: the seed only ever targets the local throwaway instance`);
  process.exit(2);
}

const t0 = Date.now();
const log = (m) => console.log(`[seed +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const creds = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, "test-creds.json"), "utf8"));
const H = { "Content-Type": "application/json", "X-Requested-With": "AoNarr" };

async function call(method, route, token, body) {
  const res = await fetch(`${BASE}/api${route}`, {
    method,
    headers: token ? { ...H, "X-Session-Token": token } : H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${(json?.error ?? text).toString().slice(0, 200)}`);
  return json;
}

function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...opts });
}

// -------------------------------------------------------------------------------- Phase A
log("logging in as the test admin");
const login = await call("POST", "/auth/login", null, { username: creds.adminUsername, password: creds.adminPassword });
const token = login.token;
const adminId = login.user.id;

// Idempotence guard: this seed is for a fresh instance only.
const existing = await call("GET", "/media?limit=1", token);
if ((existing?.total ?? 0) > 0) {
  console.error("the instance already has media: run web-e2e/seed/start.sh to get a fresh one (the seed never merges into existing data)");
  process.exit(3);
}

log("keeping seeded disk-usage samples (the app wipes them once unless this flag is set)");
await call("PUT", "/settings/diskUsageSamplesUsableSpace", token, { value: "1" });

await call("PUT", "/settings/backupDir", token, { value: "/config/backups" });

log("freezing the scheduler so nothing mutates the fixtures while tests run");
const jobs = await call("GET", "/jobs", token);
for (const j of jobs) {
  if (j.scheduleType === "interval") await call("PATCH", `/jobs/${j.key}/schedule`, token, { schedule: "86400" });
  else await call("PATCH", `/jobs/${j.key}/schedule`, token, { schedule: "0 0 1 1 *" });
}

const rand = (n = 18) => crypto.randomBytes(n).toString("base64url");
log("creating household users");
const mkUser = (body) => call("POST", "/users", token, body);
const household = await mkUser({
  username: creds.householdUsername, password: creds.householdPassword,
  allowedTypes: ["movie", "series", "anime", "artist", "author", "audiobook", "comic"], maxContentRating: "TV-14", maxPendingRequests: 5, autoApprove: false,
});
const alex = await mkUser({ username: "guest-alex", password: rand(), allowedTypes: ["movie"], maxContentRating: "PG", autoApprove: true });
const sam = await mkUser({ username: "guest-sam", password: rand(), allowedTypes: ["series", "anime"], maxContentRating: "TV-14", autoApprove: false });

log("creating indexers and download clients (all point at http://127.0.0.1:9, where nothing listens)");
const mkIndexer = (body) => call("POST", "/indexers", token, body);
const indexers = [];
for (const b of [
  { name: "Northline Torznab", protocol: "torznab", url: "http://127.0.0.1:9/torznab/api", apiKey: "placeholder-not-a-key", categories: "2000,5000", priority: 10 },
  { name: "Harbor Newznab", protocol: "newznab", url: "http://127.0.0.1:9/newznab/api", apiKey: "placeholder-not-a-key", categories: "2000,5000,3000,7000", priority: 15 },
  { name: "Community RSS", protocol: "rss", url: "http://127.0.0.1:9/rss/feed.xml", priority: 25 },
  { name: "Direct Download Mirror", protocol: "ddl", url: "http://127.0.0.1:9/ddl", priority: 50, enabled: false },
]) {
  const row = await mkIndexer(b);
  indexers.push({ id: row.id, name: row.name, protocol: row.protocol });
}
const clients = [];
for (const b of [
  { name: "qBittorrent (placeholder)", type: "qbittorrent", host: "127.0.0.1", port: 9, username: "e2e", password: "placeholder", category: "aonarr" },
  { name: "SABnzbd (placeholder)", type: "sabnzbd", host: "127.0.0.1", port: 9, apiKey: "placeholder-not-a-key", category: "aonarr-tv" },
  { name: "Direct HTTP downloads", type: "http" },
  { name: "Blackhole (disabled)", type: "blackhole", enabled: false },
]) {
  const row = await call("POST", "/download-clients", token, b);
  clients.push({ id: row.id, name: row.name, type: row.type });
}

// -------------------------------------------------------------------------------- Phase B
log("building the SQL plan");
const built = buildPlan({
  adminId,
  users: {
    household: { id: household.id, username: household.username },
    alex: { id: alex.id, username: alex.username },
    sam: { id: sam.id, username: sam.username },
  },
  indexers,
  clients,
});

fs.mkdirSync(TMP_DIR, { recursive: true });
const planFile = path.join(TMP_DIR, "plan.json");
fs.writeFileSync(planFile, JSON.stringify({ ...built.plan, fixedNow: FIXED_NOW.toISOString() }));

log(`applying plan inside ${CONTAINER} (${built.counts.mediaItems} media items, ${built.counts.episodes} episodes, ${built.counts.sparseFiles} placeholder files)`);
docker(["exec", "-u", "0", CONTAINER, "sh", "-c", "mkdir -p /media /downloads && chown 99:100 /media /downloads"]);
docker(["cp", path.join(HERE, "lib", "container-apply.mjs"), `${CONTAINER}:/tmp/aonarr-e2e-apply.mjs`]);
docker(["cp", planFile, `${CONTAINER}:/tmp/aonarr-e2e-plan.json`]);
let applyOut;
try {
  applyOut = docker(["exec", "-u", "99:100", CONTAINER, "node", "/tmp/aonarr-e2e-apply.mjs", "/tmp/aonarr-e2e-plan.json"]);
} finally {
  docker(["exec", "-u", "0", CONTAINER, "rm", "-f", "/tmp/aonarr-e2e-apply.mjs", "/tmp/aonarr-e2e-plan.json"]);
  fs.rmSync(planFile, { force: true });
}
const applied = JSON.parse(applyOut.trim().split("\n").pop());
log(`applied: ${Object.values(applied.applied).reduce((a, b) => a + b, 0)} rows, ${applied.files} sparse files`);

// -------------------------------------------------------------------------------- manifest
const manifest = {
  generatedBy: "web-e2e/seed/seed.mjs",
  fixedNow: FIXED_NOW.toISOString(),
  baseUrl: BASE,
  // The UI keeps its credential in localStorage under these keys (web/src/api/client.ts, public/theme-init.js).
  storageKeys: {
    sessionToken: "aonarr_session_token",
    apiKey: "aonarr_api_key",
    theme: "aonarr_theme",
    design: "aonarr_design",
    layoutWidth: "aonarr_layout_width",
    sidebarCollapsed: "aonarr_sidebar_collapsed",
    navPosition: "aonarr_nav_position",
    recentSearches: "aonarr_recent_searches",
  },
  users: {
    admin: { id: adminId, username: creds.adminUsername, role: "admin" },
    household: { id: household.id, username: creds.householdUsername, role: "user", allowedTypes: household.allowedTypes, maxContentRating: "TV-14" },
    others: [
      { id: alex.id, username: alex.username, allowedTypes: ["movie"], note: "random unrecorded password: not loginable" },
      { id: sam.id, username: sam.username, allowedTypes: ["series", "anime"], note: "random unrecorded password: not loginable" },
    ],
  },
  indexers,
  downloadClients: clients,
  params: built.params,
  counts: { ...built.counts, byType: built.byType },
  mediaRefs: built.refs,
  // Concrete URL for every parameterised route in web/src/App.tsx and main.tsx.
  routeExamples: (() => {
    const p = built.params;
    return {
      "/library/:type": ["/library/movie", "/library/series", "/library/anime", "/library/sports", "/library/ppv", "/library/artist", "/library/author", "/library/audiobook", "/library/comic", "/library/manga", "/library/rom", "/library/video", "/library/podcast", "/library/course", "/library/adult"],
      "/library/:type/g/:groupId": [`/library/rom/g/${p.libraryGroupId}`],
      "/library/:type/ungrouped": ["/library/rom/ungrouped", "/library/movie/ungrouped"],
      "/library/:type/all": ["/library/movie/all", "/library/series/all"],
      "/media/:id": [`/media/${p.movieId}`, `/media/${p.movieMissingId}`, `/media/${p.movieUnreleasedId}`, `/media/${p.seriesId}`, `/media/${p.seriesPartialId}`, `/media/${p.artistId}`, `/media/${p.authorId}`, `/media/${p.audiobookId}`, `/media/${p.comicId}`, `/media/${p.romId}`, `/media/${p.podcastId}`, `/media/${p.courseId}`, `/media/${p.animeId}`, `/media/${p.sportsId}`, `/media/${p.ppvId}`, `/media/${p.mangaId}`, `/media/${p.videoChannelId}`],
      "/media/:mediaId/episode/:episodeId": [`/media/${p.episodeMediaId}/episode/${p.episodeId}`, `/media/${p.episodeMissing.mediaId}/episode/${p.episodeMissing.episodeId}`],
      "/media/:mediaId/item/:subItemId": [`/media/${p.artistId}/item/${p.albumSubItemId}`, `/media/${p.authorId}/item/${p.bookSubItemId}`, `/media/${p.audiobookId}/item/${p.audiobookSubItemId}`, `/media/${p.comicId}/item/${p.comicSubItemId}`, `/media/${p.podcastId}/item/${p.podcastSubItemId}`],
      "/media/:mediaId/item/:subItemId/track/:trackId": [`/media/${p.artistId}/item/${p.albumSubItemId}/track/${p.trackId}`, `/media/${p.audiobookId}/item/${p.audiobookSubItemId}/track/${p.audiobookTrackId}`],
      "/people/:tmdbId": [],
      "/collections/:id": [`/collections/${p.collectionId}`, `/collections/${p.smartCollectionId}`],
      "/calendar/:date": [`/calendar/${p.calendarDate}`, `/calendar/${dayOffset(0)}`],
      "/share/:token": [`/share/${p.shareToken}`, `/share/${p.shareTokenExpired}`, `/share/${p.shareTokenMissing}`],
      "/invite/:token": [`/invite/${p.inviteToken}`, `/invite/${p.inviteTokenUsed}`, `/invite/${p.inviteTokenExpired}`, `/invite/${p.inviteTokenMissing}`],
    };
  })(),
  routeNotes: {
    "/people/:tmdbId": "Cannot render offline: the page asks the server for TMDB person data and the instance has no TMDB key and no network. personTmdbId is null on purpose.",
    "/add/preview": "Needs router state from /add (a metadata search result); no metadata provider is reachable, so it renders its empty state.",
    "/discover": "Backed by external metadata providers; renders its empty or error state.",
    "/recommendations": "Backed by external metadata providers; renders its empty or error state.",
    "/search": "Results appear only after a query is typed (the page keeps the query in React state, not the URL). Try 'harbor' (5 library hits). aonarr_recent_searches can pre-fill the Recent chips.",
    "/library/adult": "Intentionally empty: no Adult content is seeded.",
    "/watchlist-import": "Upload form page; there is nothing to seed.",
    "/api-docs": "Static OpenAPI document; non-empty without seeding.",
    "/remote-library": "Lists the seeded remote instance, but browsing it fails (placeholder URL).",
    "/friend-libraries": "Lists two seeded friends; Compare fails (placeholder URL).",
    "/network-stats": "Download-client stats are unavailable (placeholder clients); the queue breakdown is real.",
  },
  // Pages whose output depends on the real clock or on state the tests change, so a pixel baseline needs care.
  timeSensitivePages: [
    { route: "/", why: "Upcoming widget and 'Recently added' relative times are computed against the real current day, not FIXED_NOW." },
    { route: "/calendar", why: "Month grid centres on the real today; entries sit 1-13 days after FIXED_NOW (2026-10-14 .. 2026-10-26)." },
    { route: "/calendar/:date", why: "Same: events exist only for dates in 2026-10-14 .. 2026-10-26." },
    { route: "/library/movie", why: "The Unreleased banner compares releaseDate with the real current day; Starling Protocol, Ember & Ash and Lighthouse at the End of the World flip to Missing after their release dates." },
    { route: "/missing", why: "Lists monitored items regardless of air date, but the Kestrel County and Moonlit Dungeon episodes only age into 'aired' as real time passes." },
    { route: "/system", why: "Disk numbers are live statfs values of the container disk; stuck-queue warnings appear for queue rows older than 6 real hours; uptime and memory are live." },
    { route: "/activity", why: "Relative 'x minutes ago' labels and the live queue SSE stream; queue rows are older than 6 real hours by 2026-10-13T18:00Z." },
    { route: "/jobs", why: "Next-run times are computed from the real clock; last-run columns are empty because no job has run." },
    { route: "/users", why: "Active sessions list: the seeded sessions expire 2026-11-12, and every test login adds a session." },
    { route: "/audit-log", why: "Each login the test run performs appends a real-time row at the top." },
    { route: "/history", why: "Reads fixtures only, but relative timestamps render against the real clock." },
    { route: "/network-stats", why: "Client stats are live probes of unreachable placeholders." },
    { route: "/background-jobs widget", why: "In-memory scan/refresh progress; empty on a fresh instance and entries expire 60 s after finishing." },
  ],
  dataNotes: [
    "All posters/backdrops/covers are data: URI SVGs generated by lib/art.mjs; their text uses the host's generic sans-serif font.",
    "Library files are sparse placeholders under /media and /downloads inside the container (apparent size only, no disk used, not valid media).",
    "Root folder free/total space is the real statfs of the container disk; disk_usage_samples were generated against it.",
  ],
};
fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.writeFileSync(path.join(AUTH_DIR, "seed-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
log("wrote web-e2e/.auth/seed-manifest.json");

// -------------------------------------------------------------------------------- verify
log("verifying");
const failures = await verify({ base: BASE, creds, manifest });
log(`seed finished in ${((Date.now() - t0) / 1000).toFixed(1)}s${failures ? ` (${failures} check(s) flagged)` : ""}`);
