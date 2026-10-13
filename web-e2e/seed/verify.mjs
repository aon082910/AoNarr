#!/usr/bin/env node
// Read-only check of the seeded instance: logs in with the generated test credentials (never printed),
// GETs every list endpoint the UI uses to show counts, and reports status + row count for each.
//   node web-e2e/seed/verify.mjs
// Exit code 1 when any check is flagged (non-2xx, or fewer rows than expected). GET requests only,
// and only against the local throwaway instance - the update-check endpoint is skipped on purpose
// because it would try to reach the internet.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dayOffset } from "./lib/util.mjs";

const H = { "Content-Type": "application/json", "X-Requested-With": "AoNarr" };

function count(data) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    if (Array.isArray(data.movies) && Array.isArray(data.episodes)) return data.movies.length + data.episodes.length + (data.subItems?.length ?? 0);
    if (typeof data.total === "number") return data.total;
    if (Array.isArray(data.items)) return data.items.length;
    if (Array.isArray(data.rows)) return data.rows.length;
    if (Array.isArray(data.backups)) return data.backups.length;
    const vals = Object.values(data);
    if (vals.length && vals.every((v) => typeof v === "number")) return vals.reduce((a, b) => a + b, 0);
    return Object.keys(data).length;
  }
  return data == null ? 0 : 1;
}

export async function verify({ base, creds, manifest }) {
  const out = [];
  let flagged = 0;
  const login = async (username, password) => {
    const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ username, password }) });
    if (!res.ok) throw new Error(`login as ${username} failed: ${res.status}`);
    return (await res.json()).token;
  };
  const get = async (token, route) => {
    const res = await fetch(`${base}/api${route}`, { headers: token ? { ...H, "X-Session-Token": token } : H });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    return { status: res.status, data };
  };
  const check = async (who, token, route, min = 1) => {
    const { status, data } = await get(token, route);
    const n = status >= 200 && status < 300 ? count(data) : null;
    const ok = status >= 200 && status < 300 && n >= min;
    if (!ok) flagged++;
    out.push({ who, route, status, count: n, ok });
    return data;
  };

  const adminToken = await login(creds.adminUsername, creds.adminPassword);
  const hhToken = await login(creds.householdUsername, creds.householdPassword);
  const p = manifest.params;

  // ---- admin list endpoints (the ones the UI renders counts from)
  const adminChecks = [
    ["/media-types", 12], ["/dashboard/library-counts", 40], ["/dashboard/recently-added", 10], ["/dashboard/recent", 10], ["/dashboard/recently-watched", 5],
    ["/dashboard/library-sizes", 5], [`/wanted/calendar?start=${dayOffset(0)}&end=${dayOffset(14)}`, 8], ["/wanted/missing", 30], ["/wanted/cutoff-unmet?page=1&pageSize=60", 10],
    ["/activity/queue?limit=60&offset=0", 5], ["/activity/history?limit=60&offset=0", 20], ["/activity/timeline?limit=60&offset=0", 20], ["/blocklist?limit=60&offset=0", 5],
    ["/root-folders", 10], ["/quality-profiles", 3], ["/qualities", 10], ["/tags", 4], ["/collections", 4], [`/collections/${p.collectionId}`, 1], [`/collections/${p.smartCollectionId}`, 1],
    ["/custom-formats", 3], ["/release-profiles", 1], ["/delay-profiles", 1], ["/indexers", 3], ["/download-clients", 3], ["/irc-feeds", 1], ["/ai-providers", 1], ["/custom-columns", 1],
    ["/iptv/playlists", 1], ["/iptv/filler-clips", 1], ["/iptv/playlists/1/items", 1], ["/users", 3], ["/users/sessions", 1], ["/users/invites", 3],
    ["/requests?limit=50&offset=0", 5], ["/requests/stats", 1], ["/audit-log?page=1&pageSize=100", 50], ["/import-lists", 2], ["/import-review?status=pending&limit=60&offset=0", 3],
    ["/import-review/counts", 1], ["/import-exclusions", 2], ["/recycle-bin", 3], ["/corrupt-media-review", 1], ["/duplicates", 1], ["/friend-libraries", 1], ["/remote-instances", 1],
    ["/remote-path-mappings", 1], ["/jobs", 20], ["/system/status", 3], ["/system/health", 3], ["/system/network-stats", 1], ["/system/resources", 1], ["/system/log-files", 0], ["/system/backups", 3],
    ["/media-analysis", 10], ["/library-groups?mediaType=rom", 1], ["/library-views?mediaType=movie", 1], ["/subtitles/providers", 1], ["/changelog", 1], ["/settings", 1],
    [`/media/${p.movieId}`, 1], [`/media/${p.movieId}/history`, 1], [`/media/${p.seriesId}`, 1], [`/media/${p.episodeMediaId}/episodes/${p.episodeId}`, 1],
    [`/media/${p.artistId}`, 1], [`/media/${p.artistId}/subitems/${p.albumSubItemId}`, 1], [`/media/subitems/${p.albumSubItemId}/tracks`, 5],
    [`/media/${p.artistId}/subitems/${p.albumSubItemId}/tracks/${p.trackId}`, 1], [`/media/${p.authorId}/subitems/${p.bookSubItemId}`, 1], [`/media/${p.movieId}/share`, 1],
  ];
  for (const [route, min] of adminChecks) await check("admin", adminToken, route, min);
  for (const t of ["movie", "series", "anime", "sports", "ppv", "artist", "author", "audiobook", "comic", "manga", "rom", "video", "podcast", "course"]) {
    await check("admin", adminToken, `/media?type=${t}&limit=100`, 1);
    await check("admin", adminToken, `/media/stats?type=${t}`, 1);
  }
  await check("admin", adminToken, "/media?status=cutoffUnmet&limit=100", 3);
  await check("admin", adminToken, "/media?status=unmatched&limit=100", 1);
  await check("admin", adminToken, "/library-search?q=harbor", 1);

  // ---- household view
  for (const [route, min] of [["/auth/me", 1], ["/media?type=movie&limit=100", 5], ["/media?type=series&limit=100", 3], ["/dashboard/recently-added", 5], ["/dashboard/library-counts", 3], ["/requests?limit=50&offset=0", 3], ["/requests/stats/me", 1], ["/collections", 3], [`/media/${p.movieId}`, 1]]) {
    await check("household", hhToken, route, min);
  }
  const blocked = await get(hhToken, "/media?type=rom&limit=10");
  out.push({ who: "household", route: "/media?type=rom (library not granted: expect 0)", status: blocked.status, count: count(blocked.data), ok: count(blocked.data) === 0 });

  // ---- public pages
  for (const [route, wantStatus] of [["/health", 200], ["/auth/setup-status", 200], [`/share/${p.shareToken}`, 200], [`/share/${p.shareTokenExpired}`, 404], [`/share/${p.shareTokenMissing}`, 404], [`/invite/${p.inviteToken}`, 200], [`/invite/${p.inviteTokenUsed}`, 410], [`/invite/${p.inviteTokenExpired}`, 410], [`/invite/${p.inviteTokenMissing}`, 404]]) {
    const { status, data } = await get(null, route);
    const ok = status === wantStatus;
    if (!ok) flagged++;
    out.push({ who: "public", route, status, count: data ? count(data) : 0, ok, expected: wantStatus });
  }

  // ---- UI shell + response headers Playwright cares about
  const ui = await fetch(`${base}/`);
  const html = await ui.text();
  const csp = ui.headers.get("content-security-policy");
  out.push({ who: "ui", route: "GET /", status: ui.status, count: html.length, ok: ui.status === 200 && /<div id="root">/.test(html) });
  if (!(ui.status === 200 && /<div id="root">/.test(html))) flagged++;
  const sw = await fetch(`${base}/sw.js`);
  const swCsp = sw.headers.get("content-security-policy");

  for (const r of out) {
    console.log(`${r.ok ? "ok  " : "FLAG"} ${r.who.padEnd(9)} ${String(r.status).padEnd(4)} ${String(r.count ?? "-").padEnd(6)} ${r.route}${r.expected ? `  (expected ${r.expected})` : ""}`);
  }
  console.log(`CSP on /: ${csp ?? "(none)"}`);
  console.log(`CSP on /sw.js: ${swCsp ?? "(none)"}`);
  console.log(`checks: ${out.length}, flagged: ${flagged}`);
  return flagged;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.DO_NOT_TRACK = "1";
  const here = path.dirname(fileURLToPath(import.meta.url));
  const auth = path.join(path.dirname(here), ".auth");
  const creds = JSON.parse(fs.readFileSync(path.join(auth, "test-creds.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(auth, "seed-manifest.json"), "utf8"));
  const base = process.env.AONARR_E2E_URL ?? manifest.baseUrl;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
    console.error(`refusing to verify ${base}: only the local throwaway instance is allowed`);
    process.exit(2);
  }
  const failures = await verify({ base, creds, manifest });
  process.exit(failures ? 1 : 0);
}
