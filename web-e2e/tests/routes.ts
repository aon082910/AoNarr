// Route manifest for the sweep. One entry per `path=` in web/src/App.tsx and web/src/main.tsx, with the
// :params resolved from the seed manifest (web-e2e/.auth/seed-manifest.json). The drift spec
// (routes-drift.spec.ts) fails when App.tsx / main.tsx gain a path that is not listed here.
//
// ROUTE_DEFS is static (no file reads) so the drift spec can import it without a seeded instance.
// resolveRoutes() adds the concrete URL per entry from the seed manifest.
import fs from "node:fs";
import { PATHS, type Role } from "../config/shared";
import type { ExpectedBlocked } from "./lib/fixtures";

export interface SeedParams {
  [key: string]: unknown;
  movieId: number;
  seriesId: number;
  episodeMediaId: number;
  episodeId: number;
  artistId: number;
  albumSubItemId: number;
  trackId: number;
  collectionId: number;
  libraryGroupId: number;
  calendarDate: string;
  shareToken: string;
  shareTokenExpired: string;
  shareTokenMissing: string;
  inviteToken: string;
  inviteTokenUsed: string;
  inviteTokenExpired: string;
  inviteTokenMissing: string;
  personTmdbId: number | null;
}

export interface SeedManifest {
  fixedNow: string;
  params: SeedParams;
  mediaRefs: Record<string, number>;
}

/** An /api response that is EXPECTED to be non-2xx on this route, with the reason. */
export interface ExpectedApi {
  /** Matched against the request path + query (e.g. "/api/share/<token>"). */
  pattern: RegExp;
  status: number[];
  reason: string;
}

export interface RouteDef {
  /** Stable slug; used in file names, snapshot names and the ratchet baselines. */
  id: string;
  /** The react-router `path` exactly as written in App.tsx / main.tsx (the drift spec compares these). */
  pattern: string;
  /** Sidebar-ish grouping, for reports only. */
  group: string;
  role: Role;
  /** Concrete URL from the seed params. */
  url: (p: SeedParams) => string;
  /** Text that must be on the page once settled; proves real seed data rendered (not an empty/error state). */
  expectText?: (p: SeedParams, m: SeedManifest) => string;
  /**
   * 'blocking' (default): Classic projects compare the full-page screenshot against the committed baseline.
   * 'capture-only': Classic also only captures, because the page shows live host values that are not masked yet.
   */
  pixel?: "blocking" | "capture-only";
  /** Why this page is time/host dependent (from the seed manifest's timeSensitivePages and README). */
  volatile?: string;
  /** Elements whose text matches are masked in screenshots (live numbers). */
  maskText?: RegExp[];
  /** The seed cannot fill this page (external provider, see seed README "Known gaps"): API failures on it are reported, not fatal. */
  knownGap?: string;
  expectedApi?: ExpectedApi[];
  /** Non-GET /api calls this page makes on its own (kept blocked by the guard, so the instance is never written); they do not fail the route. */
  expectedBlocked?: ExpectedBlocked[];
  /**
   * "report-only": the axe and Tab-walk results of this route are recorded but never ratcheted. For pages whose DATA changes with every
   * test login (the layout then moves, e.g. a table column slides in or out of the mobile viewport, and axe flags a different set of nodes).
   */
  ratchet?: "report-only";
  /** Cap the captured page height (px from the top). For pages whose length is unbounded: /changelog is 141,133 px tall (a full-page PNG times out and would be gigantic). */
  maxHeight?: number;
  /** Skip loading-text detection for these texts (a page that legitimately keeps a "Checking..." label). */
  ignoreLoadingText?: RegExp[];
  /** Part of the ~12 representative routes walked by tabwalk.spec.ts. */
  tabwalk?: boolean;
  /** For the catch-all: the path the app must end up on. */
  redirectsTo?: string;
  /** Another entry with the same pattern is the primary one; this is an extra state of the same route. */
  variantOf?: string;
}

/** SSE pages (Activity, System logs) POST for a single-use stream ticket (web/src/api/client.ts openEventStream). The guard keeps it blocked: the app retries with back-off and the instance is never written. */
const STREAM_TICKET: ExpectedBlocked = { method: "POST", pattern: /^\/api\/auth\/stream-ticket$/, reason: "SSE stream ticket request; blocked by the GET-only guard on purpose" };

const LIVE_NUMBERS = [/\b\d+(\.\d+)?\s?(KB|MB|GB|TB|PB)\b/, /\b\d+(\.\d+)?\s?%/, /\b\d+\s?d(ays?)?\s\d+\s?h/i];

export const ROUTE_DEFS: RouteDef[] = [
  // ---- main shell (App.tsx) ----
  { id: "dashboard", pattern: "/", group: "Home", role: "admin", url: () => "/", tabwalk: true,
    // The dashboard renders "0 item(s)" / "Nothing added yet." BEFORE its data arrives (no loading text), so wait for the real count.
    expectText: (_p, m) => `${(m as any).counts?.mediaItems ?? 59} item(s) across every library`,
    volatile: "Upcoming widget and relative times use the clock (frozen); disk numbers come from the Docker VM disk (seed manifest timeSensitivePages)", pixel: "capture-only", maskText: LIVE_NUMBERS },
  { id: "library-home", pattern: "/library", group: "Library", role: "admin", url: () => "/library",
    // Cards read "0 item(s)" until the counts arrive.
    expectText: (_p, m) => `${(m as any).counts?.byType?.movie ?? 26} item(s)` },
  { id: "library-type", pattern: "/library/:type", group: "Library", role: "admin", url: () => "/library/movie", tabwalk: true,
    volatile: "Unreleased banner compares releaseDate with the current day (the clock is frozen at FIXED_NOW)" },
  { id: "library-group", pattern: "/library/:type/g/:groupId", group: "Library", role: "admin", url: (p) => `/library/rom/g/${p.libraryGroupId}` },
  { id: "library-ungrouped", pattern: "/library/:type/ungrouped", group: "Library", role: "admin", url: () => "/library/rom/ungrouped" },
  { id: "library-all", pattern: "/library/:type/all", group: "Library", role: "admin", url: () => "/library/movie/all" },
  { id: "media-detail", pattern: "/media/:id", group: "Media", role: "admin", url: (p) => `/media/${p.movieId}`, tabwalk: true,
    expectText: (p, m) => nameOf(m, p.movieId),
    // Observed in the first proof-of-life run: the seeded instance has no metadata provider, so these four panel
    // endpoints answer 400 (seed README "Known gaps": Cast / Alternate titles / Ratings panels).
    expectedApi: [{ pattern: /^\/api\/media\/\d+\/(cast|alternate-titles|ratings|collection)$/, status: [400], reason: "no metadata provider on the seeded instance (seed README: Known gaps)" }] },
  { id: "episode-detail", pattern: "/media/:mediaId/episode/:episodeId", group: "Media", role: "admin", url: (p) => `/media/${p.episodeMediaId}/episode/${p.episodeId}` },
  { id: "sub-item-detail", pattern: "/media/:mediaId/item/:subItemId", group: "Media", role: "admin", url: (p) => `/media/${p.artistId}/item/${p.albumSubItemId}` },
  { id: "track-detail", pattern: "/media/:mediaId/item/:subItemId/track/:trackId", group: "Media", role: "admin", url: (p) => `/media/${p.artistId}/item/${p.albumSubItemId}/track/${p.trackId}` },
  { id: "person", pattern: "/people/:tmdbId", group: "Media", role: "admin", url: (p) => `/people/${p.personTmdbId ?? 287}`,
    knownGap: "needs TMDB person data; the seeded instance has no TMDB key and no network (seed README: Known gaps)" },
  { id: "search", pattern: "/search", group: "Home", role: "admin", url: () => "/search" },
  { id: "collections", pattern: "/collections", group: "Library", role: "admin", url: () => "/collections" },
  { id: "collection-detail", pattern: "/collections/:id", group: "Library", role: "admin", url: (p) => `/collections/${p.collectionId}` },
  { id: "requests", pattern: "/requests", group: "Manage", role: "admin", url: () => "/requests" },
  { id: "discover", pattern: "/discover", group: "Manage", role: "admin", url: () => "/discover",
    knownGap: "backed by external metadata providers; renders its empty/error state (seed README: Known gaps)" },
  { id: "ai-providers", pattern: "/ai-providers", group: "Settings", role: "admin", url: () => "/ai-providers" },
  { id: "custom-columns", pattern: "/custom-columns", group: "Settings", role: "admin", url: () => "/custom-columns" },
  { id: "iptv-playlists", pattern: "/iptv-playlists", group: "Settings", role: "admin", url: () => "/iptv-playlists" },
  { id: "changelog", pattern: "/changelog", group: "Home", role: "admin", url: () => "/changelog", maxHeight: 3600 },
  { id: "account", pattern: "/account", group: "Home", role: "admin", url: () => "/account", tabwalk: true },
  { id: "add-media", pattern: "/add", group: "Manage", role: "admin", url: () => "/add", tabwalk: true },
  { id: "add-preview", pattern: "/add/preview", group: "Manage", role: "admin", url: () => "/add/preview", redirectsTo: "/add",
    knownGap: "needs router state from /add (a metadata search result); observed: opened directly it redirects to /add (seed README: Known gaps)" },
  { id: "recommendations", pattern: "/recommendations", group: "Manage", role: "admin", url: () => "/recommendations",
    knownGap: "backed by external metadata providers; renders its empty/error state (seed README: Known gaps)" },
  { id: "watchlist-import", pattern: "/watchlist-import", group: "Manage", role: "admin", url: () => "/watchlist-import" },
  { id: "import-review", pattern: "/import-review", group: "Manage", role: "admin", url: () => "/import-review" },
  { id: "import-lists", pattern: "/import-lists", group: "Manage", role: "admin", url: () => "/import-lists" },
  { id: "calendar", pattern: "/calendar", group: "Activity", role: "admin", url: () => "/calendar", tabwalk: true,
    volatile: "month grid centres on the current day; entries sit 1-13 days after FIXED_NOW (the clock is frozen)" },
  { id: "calendar-day", pattern: "/calendar/:date", group: "Activity", role: "admin", url: (p) => `/calendar/${p.calendarDate}` },
  { id: "missing", pattern: "/missing", group: "Activity", role: "admin", url: () => "/missing", tabwalk: true,
    volatile: "some episodes only age into 'aired' as real time passes (seed manifest timeSensitivePages)" },
  { id: "cutoff-unmet", pattern: "/cutoff-unmet", group: "Activity", role: "admin", url: () => "/cutoff-unmet" },
  { id: "history", pattern: "/history", group: "Activity", role: "admin", url: () => "/history" },
  { id: "blocklist", pattern: "/blocklist", group: "Activity", role: "admin", url: () => "/blocklist" },
  { id: "activity", pattern: "/activity", group: "Activity", role: "admin", url: () => "/activity", tabwalk: true,
    volatile: "live queue SSE stream; stuck-queue warnings appear for rows older than 6 real hours", pixel: "capture-only",
    expectedBlocked: [STREAM_TICKET] },
  { id: "indexers", pattern: "/indexers", group: "Settings", role: "admin", url: () => "/indexers" },
  { id: "download-clients", pattern: "/download-clients", group: "Settings", role: "admin", url: () => "/download-clients" },
  { id: "irc-feeds", pattern: "/irc-feeds", group: "Settings", role: "admin", url: () => "/irc-feeds" },
  { id: "users", pattern: "/users", group: "Settings", role: "admin", url: () => "/users", tabwalk: true,
    volatile: "Active Sessions list grows with every test login", pixel: "capture-only", ratchet: "report-only" },
  { id: "audit-log", pattern: "/audit-log", group: "System", role: "admin", url: () => "/audit-log",
    volatile: "each login appends a real-time row at the top", pixel: "capture-only", ratchet: "report-only" },
  { id: "settings", pattern: "/settings", group: "Settings", role: "admin", url: () => "/settings", tabwalk: true },
  { id: "system", pattern: "/system", group: "System", role: "admin", url: () => "/system", tabwalk: true,
    volatile: "live memory/CPU/uptime/disk values of the container", pixel: "capture-only", maskText: LIVE_NUMBERS },
  { id: "jobs", pattern: "/jobs", group: "System", role: "admin", url: () => "/jobs" },
  { id: "recycle-bin", pattern: "/recycle-bin", group: "System", role: "admin", url: () => "/recycle-bin" },
  { id: "duplicates", pattern: "/duplicates", group: "System", role: "admin", url: () => "/duplicates", tabwalk: true },
  { id: "network-stats", pattern: "/network-stats", group: "System", role: "admin", url: () => "/network-stats",
    volatile: "client stats are live probes of unreachable placeholders", pixel: "capture-only", maskText: LIVE_NUMBERS },
  { id: "media-analyzer", pattern: "/media-analyzer", group: "System", role: "admin", url: () => "/media-analyzer" },
  { id: "api-docs", pattern: "/api-docs", group: "System", role: "admin", url: () => "/api-docs" },
  { id: "remote-library", pattern: "/remote-library", group: "Library", role: "admin", url: () => "/remote-library",
    knownGap: "lists the seeded remote instance but browsing it fails (placeholder URL)" },
  { id: "friend-libraries", pattern: "/friend-libraries", group: "Library", role: "admin", url: () => "/friend-libraries",
    knownGap: "lists two seeded friends but Compare fails (placeholder URL)" },
  { id: "catch-all", pattern: "*", group: "Shell", role: "admin", url: () => "/e2e-this-route-does-not-exist", redirectsTo: "/" },

  // ---- public routes (main.tsx): no session ----
  { id: "share-valid", pattern: "/share/:token", group: "Public", role: "public", url: (p) => `/share/${p.shareToken}` },
  { id: "share-expired", pattern: "/share/:token", group: "Public", role: "public", url: (p) => `/share/${p.shareTokenExpired}`, variantOf: "share-valid",
    expectedApi: [{ pattern: /^\/api\/share\//, status: [404], reason: "expired share token: the seed made it 404 (seed README)" }] },
  { id: "invite-valid", pattern: "/invite/:token", group: "Public", role: "public", url: (p) => `/invite/${p.inviteToken}` },
  { id: "invite-used", pattern: "/invite/:token", group: "Public", role: "public", url: (p) => `/invite/${p.inviteTokenUsed}`, variantOf: "invite-valid",
    expectedApi: [{ pattern: /^\/api\/invite\//, status: [410], reason: "already-used invite token: the seed made it 410 (seed README)" }] },
];

/** Paths in main.tsx / App.tsx that are structural wrappers rather than pages. */
export const STRUCTURAL_PATTERNS = ["/*"];

export interface Route extends RouteDef {
  /** Concrete URL (path + query) to open. */
  href: string;
}

function nameOf(m: SeedManifest, id: number): string {
  for (const [name, value] of Object.entries(m.mediaRefs)) {
    if (value === id && !name.includes(":")) return name;
  }
  throw new Error(`No media name for id ${id} in the seed manifest`);
}

export function loadSeedManifest(): SeedManifest {
  if (!fs.existsSync(PATHS.manifest)) {
    throw new Error(`Seed manifest missing: ${PATHS.manifest}. Start the seeded instance first: npm run seed:start`);
  }
  return JSON.parse(fs.readFileSync(PATHS.manifest, "utf8")) as SeedManifest;
}

export function resolveRoutes(manifest: SeedManifest = loadSeedManifest()): Route[] {
  return ROUTE_DEFS.map((r) => ({ ...r, href: r.url(manifest.params) }));
}

/**
 * Routes for the specs: all of them, or only the ids listed in E2E_ROUTES (comma separated; "tabwalk" = the
 * tab-walk set). The filter exists for quick runs and the proof of life; the drift spec ignores it.
 */
export function selectedRoutes(manifest: SeedManifest = loadSeedManifest()): Route[] {
  const all = resolveRoutes(manifest);
  const wanted = (process.env.E2E_ROUTES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0) return all;
  const ids = new Set(wanted.flatMap((w) => (w === "tabwalk" ? TABWALK_ROUTE_IDS : [w])));
  const unknown = [...ids].filter((id) => !all.some((r) => r.id === id));
  if (unknown.length) throw new Error(`E2E_ROUTES names unknown route id(s): ${unknown.join(", ")}`);
  return all.filter((r) => ids.has(r.id));
}

/** Every distinct pattern the manifest covers. */
export function manifestPatterns(): string[] {
  return [...new Set(ROUTE_DEFS.map((r) => r.pattern))].sort();
}

export const TABWALK_ROUTE_IDS = ROUTE_DEFS.filter((r) => r.tabwalk).map((r) => r.id);
