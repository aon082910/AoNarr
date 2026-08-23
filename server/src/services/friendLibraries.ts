import { db } from "../db/index.js";

export interface FriendLibraryConfig {
  id: number;
  name: string;
  type: "plex" | "jellyfin" | "emby";
  url: string;
  token: string;
}

export interface FriendLibraryItem {
  title: string;
  year: number | null;
  type: "movie" | "series";
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function fetchPlexTitles(cfg: FriendLibraryConfig): Promise<FriendLibraryItem[]> {
  const headers = { Accept: "application/json" };
  const sectionsRes = await fetch(`${cfg.url.replace(/\/$/, "")}/library/sections?X-Plex-Token=${cfg.token}`, { headers });
  if (!sectionsRes.ok) throw new Error(`Plex sections request failed: ${sectionsRes.status}`);
  const sectionsBody = (await sectionsRes.json()) as any;
  const sections: { key: string; type: string }[] = sectionsBody?.MediaContainer?.Directory ?? [];

  const items: FriendLibraryItem[] = [];
  for (const section of sections) {
    if (section.type !== "movie" && section.type !== "show") continue;
    const itemsRes = await fetch(`${cfg.url.replace(/\/$/, "")}/library/sections/${section.key}/all?X-Plex-Token=${cfg.token}`, { headers });
    if (!itemsRes.ok) continue;
    const itemsBody = (await itemsRes.json()) as any;
    const metadata: any[] = itemsBody?.MediaContainer?.Metadata ?? [];
    for (const m of metadata) {
      if (!m.title) continue;
      items.push({ title: m.title, year: m.year ?? null, type: section.type === "movie" ? "movie" : "series" });
    }
  }
  return items;
}

async function fetchJellyfinLikeTitles(cfg: FriendLibraryConfig, basePath: string): Promise<FriendLibraryItem[]> {
  const url = cfg.url.replace(/\/$/, "");
  const headers = { "X-Emby-Token": cfg.token, Accept: "application/json" };
  const usersRes = await fetch(`${url}${basePath}/Users`, { headers });
  if (!usersRes.ok) throw new Error(`${cfg.type} users request failed: ${usersRes.status}`);
  const users = (await usersRes.json()) as { Id: string }[];
  if (users.length === 0) return [];

  const itemsRes = await fetch(
    `${url}${basePath}/Users/${users[0].Id}/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProductionYear`,
    { headers }
  );
  if (!itemsRes.ok) throw new Error(`${cfg.type} items request failed: ${itemsRes.status}`);
  const body = (await itemsRes.json()) as { Items?: any[] };

  const items: FriendLibraryItem[] = [];
  for (const item of body.Items ?? []) {
    if (!item.Name || (item.Type !== "Movie" && item.Type !== "Series")) continue;
    items.push({ title: item.Name, year: item.ProductionYear ?? null, type: item.Type === "Movie" ? "movie" : "series" });
  }
  return items;
}

async function fetchFriendTitles(cfg: FriendLibraryConfig): Promise<FriendLibraryItem[]> {
  if (cfg.type === "plex") return fetchPlexTitles(cfg);
  if (cfg.type === "jellyfin") return fetchJellyfinLikeTitles(cfg, "");
  return fetchJellyfinLikeTitles(cfg, "/emby");
}

async function loadLocalTitles(): Promise<Map<string, Set<number | null>>> {
  const rows = (await db.prepare("SELECT title, year, type FROM media_items WHERE type IN ('movie', 'series')").all()) as {
    title: string;
    year: number | null;
    type: string;
  }[];
  const map = new Map<string, Set<number | null>>();
  for (const r of rows) {
    const key = `${r.type}:${normalizeTitle(r.title)}`;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(r.year);
  }
  return map;
}

function isPresentLocally(item: FriendLibraryItem, localTitles: Map<string, Set<number | null>>): boolean {
  const years = localTitles.get(`${item.type}:${normalizeTitle(item.title)}`);
  if (!years) return false;
  if (item.year == null || years.has(null)) return true;
  for (const y of years) {
    if (y != null && Math.abs(y - item.year) <= 1) return true;
  }
  return false;
}

/**
 * Compares a friend's shared Plex/Jellyfin/Emby library against this instance's own library
 * (title + year, since the friend's files live on their own server under their own paths — a
 * path-based comparison like the one AoNarr does against its own configured media server doesn't
 * apply here) and returns everything they have that isn't in this library at all.
 */
export async function compareFriendLibrary(friend: FriendLibraryConfig): Promise<FriendLibraryItem[]> {
  const friendItems = await fetchFriendTitles(friend);
  const localTitles = await loadLocalTitles();
  const seen = new Set<string>();
  const missing: FriendLibraryItem[] = [];
  for (const item of friendItems) {
    const dedupeKey = `${item.type}:${normalizeTitle(item.title)}:${item.year ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (!isPresentLocally(item, localTitles)) missing.push(item);
  }
  return missing.sort((a, b) => a.title.localeCompare(b.title));
}
