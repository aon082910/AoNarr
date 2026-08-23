import { getSetting } from "./settingsStore.js";

export interface WatchedFile {
  /** Raw file path as reported by the media server. */
  path: string;
  /** When it was last played. */
  lastPlayedAt: Date;
}

interface MediaServerConfig {
  type: "plex" | "jellyfin" | "emby";
  url: string;
  token: string;
}

export function getMediaServerConfig(): MediaServerConfig | null {
  const type = getSetting("mediaServerType") as MediaServerConfig["type"] | null;
  const url = getSetting("mediaServerUrl");
  const token = getSetting("mediaServerToken");
  if (!type || !url || !token) return null;
  return { type, url: url.replace(/\/$/, ""), token };
}

async function fetchPlexFiles(cfg: MediaServerConfig, onlyWatched: boolean): Promise<WatchedFile[]> {
  const headers = { Accept: "application/json" };
  const sectionsRes = await fetch(`${cfg.url}/library/sections?X-Plex-Token=${cfg.token}`, { headers });
  if (!sectionsRes.ok) throw new Error(`Plex sections request failed: ${sectionsRes.status}`);
  const sectionsBody = (await sectionsRes.json()) as any;
  const sections: { key: string; type: string }[] = sectionsBody?.MediaContainer?.Directory ?? [];

  const files: WatchedFile[] = [];
  for (const section of sections) {
    if (section.type !== "movie" && section.type !== "show") continue;
    const itemType = section.type === "movie" ? 1 : 4; // 1 = movie, 4 = episode
    const itemsRes = await fetch(
      `${cfg.url}/library/sections/${section.key}/all?type=${itemType}&unwatched=0&X-Plex-Token=${cfg.token}`,
      { headers }
    );
    if (!itemsRes.ok) continue;
    const itemsBody = (await itemsRes.json()) as any;
    const items: any[] = itemsBody?.MediaContainer?.Metadata ?? [];
    for (const item of items) {
      if (onlyWatched && (!item.viewCount || !item.lastViewedAt)) continue;
      for (const media of item.Media ?? []) {
        for (const part of media.Part ?? []) {
          if (part.file) files.push({ path: part.file, lastPlayedAt: item.lastViewedAt ? new Date(item.lastViewedAt * 1000) : new Date(0) });
        }
      }
    }
  }
  return files;
}

async function fetchJellyfinLikeFiles(cfg: MediaServerConfig, basePath: string, onlyWatched: boolean): Promise<WatchedFile[]> {
  const headers = { "X-Emby-Token": cfg.token, Accept: "application/json" };
  const usersRes = await fetch(`${cfg.url}${basePath}/Users`, { headers });
  if (!usersRes.ok) throw new Error(`${cfg.type} users request failed: ${usersRes.status}`);
  const users = (await usersRes.json()) as { Id: string }[];

  const files: WatchedFile[] = [];
  for (const user of users) {
    const playedFilter = onlyWatched ? "&IsPlayed=true" : "";
    const itemsRes = await fetch(
      `${cfg.url}${basePath}/Users/${user.Id}/Items?Recursive=true${playedFilter}&IncludeItemTypes=Movie,Episode&Fields=Path,UserData`,
      { headers }
    );
    if (!itemsRes.ok) continue;
    const body = (await itemsRes.json()) as { Items?: any[] };
    for (const item of body.Items ?? []) {
      const lastPlayed = item.UserData?.LastPlayedDate;
      if (!item.Path || (onlyWatched && !lastPlayed)) continue;
      files.push({ path: item.Path, lastPlayedAt: lastPlayed ? new Date(lastPlayed) : new Date(0) });
    }
  }
  return files;
}

async function fetchFiles(onlyWatched: boolean): Promise<WatchedFile[]> {
  const cfg = getMediaServerConfig();
  if (!cfg) return [];

  if (cfg.type === "plex") return fetchPlexFiles(cfg, onlyWatched);
  if (cfg.type === "jellyfin") return fetchJellyfinLikeFiles(cfg, "", onlyWatched);
  return fetchJellyfinLikeFiles(cfg, "/emby", onlyWatched);
}

/** Returns every file the configured media server considers "watched", each with its last-played time. */
export async function fetchWatchedFiles(): Promise<WatchedFile[]> {
  return fetchFiles(true);
}

/** Returns every file the configured media server's library actually has, watched or not — used
 * to validate AoNarr's own library against what the media server can actually see (stale path,
 * permissions issue, a file AoNarr thinks it has that got moved/deleted outside AoNarr). */
export async function fetchAllLibraryFiles(): Promise<WatchedFile[]> {
  return fetchFiles(false);
}

/** Same 2-segment-tail comparison services/archival.ts's pathTail uses for the same reason (AoNarr
 * and the media server often see the same file under different mount points) — duplicated rather
 * than imported to avoid a circular import (archival.ts already imports fetchWatchedFiles from
 * this module). */
function pathTail(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/").toLowerCase();
}

interface MediaServerItem {
  path: string;
  id: string;
}

export interface MediaServerLibraryItem {
  mediaServerId: string;
  path: string;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
}

/** Plex signals an external id two ways depending on server/agent version: a `Guid` array of
 * `{id: "tmdb://603"}`-style entries (current "new agents"), or a single legacy `guid` string like
 * "com.plexapp.agents.themoviedb://603?lang=en" (old agents, still seen on long-running servers
 * that haven't re-matched their library). Both are parsed so neither vintage silently loses ids. */
function parsePlexExternalIds(item: any): Record<string, string> {
  const ids: Record<string, string> = {};
  const PROVIDER_MAP: Record<string, string> = { themoviedb: "tmdb", thetvdb: "tvdb", imdb: "imdb", tmdb: "tmdb", tvdb: "tvdb" };

  for (const g of item.Guid ?? []) {
    const m = typeof g?.id === "string" ? g.id.match(/^(\w+):\/\/(.+)$/) : null;
    if (m && PROVIDER_MAP[m[1]]) ids[PROVIDER_MAP[m[1]]] = m[2];
  }
  if (typeof item.guid === "string") {
    const m = item.guid.match(/agents\.(\w+):\/\/([^?]+)/);
    if (m && PROVIDER_MAP[m[1]] && !ids[PROVIDER_MAP[m[1]]]) ids[PROVIDER_MAP[m[1]]] = m[2];
  }
  return ids;
}

/** Movies only (shape="single") — TV import would additionally need per-episode season/episode
 * numbers and parent-show matching, a larger job left for a follow-up. */
async function fetchPlexMovieDetails(cfg: MediaServerConfig): Promise<MediaServerLibraryItem[]> {
  const headers = { Accept: "application/json" };
  const sectionsRes = await fetch(`${cfg.url}/library/sections?X-Plex-Token=${cfg.token}`, { headers });
  if (!sectionsRes.ok) throw new Error(`Plex sections request failed: ${sectionsRes.status}`);
  const sectionsBody = (await sectionsRes.json()) as any;
  const sections: { key: string; type: string }[] = sectionsBody?.MediaContainer?.Directory ?? [];

  const results: MediaServerLibraryItem[] = [];
  for (const section of sections) {
    if (section.type !== "movie") continue;
    const itemsRes = await fetch(
      `${cfg.url}/library/sections/${section.key}/all?type=1&X-Plex-Token=${cfg.token}`,
      { headers }
    );
    if (!itemsRes.ok) continue;
    const itemsBody = (await itemsRes.json()) as any;
    const metadata: any[] = itemsBody?.MediaContainer?.Metadata ?? [];
    for (const item of metadata) {
      const file = item.Media?.[0]?.Part?.[0]?.file;
      if (!file || !item.ratingKey) continue;
      results.push({
        mediaServerId: String(item.ratingKey),
        path: file,
        title: item.title,
        year: item.year ?? null,
        overview: item.summary || null,
        posterUrl: item.thumb ? `${cfg.url}${item.thumb}?X-Plex-Token=${cfg.token}` : null,
        externalIds: parsePlexExternalIds(item),
      });
    }
  }
  return results;
}

async function fetchJellyfinMovieDetails(cfg: MediaServerConfig, basePath: string): Promise<MediaServerLibraryItem[]> {
  const headers = { "X-Emby-Token": cfg.token, Accept: "application/json" };
  const usersRes = await fetch(`${cfg.url}${basePath}/Users`, { headers });
  if (!usersRes.ok) throw new Error(`${cfg.type} users request failed: ${usersRes.status}`);
  const users = (await usersRes.json()) as { Id: string }[];
  if (users.length === 0) return [];

  const itemsRes = await fetch(
    `${cfg.url}${basePath}/Users/${users[0].Id}/Items?Recursive=true&IncludeItemTypes=Movie&Fields=Path,Overview,ProviderIds,ProductionYear,ImageTags`,
    { headers }
  );
  if (!itemsRes.ok) throw new Error(`${cfg.type} items request failed: ${itemsRes.status}`);
  const body = (await itemsRes.json()) as { Items?: any[] };

  const results: MediaServerLibraryItem[] = [];
  for (const item of body.Items ?? []) {
    if (!item.Path || !item.Id) continue;
    const externalIds: Record<string, string> = {};
    if (item.ProviderIds?.Tmdb) externalIds.tmdb = item.ProviderIds.Tmdb;
    if (item.ProviderIds?.Imdb) externalIds.imdb = item.ProviderIds.Imdb;
    if (item.ProviderIds?.Tvdb) externalIds.tvdb = item.ProviderIds.Tvdb;
    results.push({
      mediaServerId: String(item.Id),
      path: item.Path,
      title: item.Name,
      year: item.ProductionYear ?? null,
      overview: item.Overview || null,
      posterUrl: item.ImageTags?.Primary ? `${cfg.url}${basePath}/Items/${item.Id}/Images/Primary?api_key=${cfg.token}` : null,
      externalIds,
    });
  }
  return results;
}

/** Fetches every movie the configured media server's library has, with the metadata (title,
 * year, overview, poster, external ids) needed to create or match an AoNarr media_item from it —
 * unlike fetchPlexItems/fetchJellyfinLikeItems above, which only keep path+id (enough for
 * watch-state matching, not for populating a real library entry). */
export async function fetchMediaServerMovies(): Promise<MediaServerLibraryItem[]> {
  const cfg = getMediaServerConfig();
  if (!cfg) throw new Error("No media server configured");
  if (cfg.type === "plex") return fetchPlexMovieDetails(cfg);
  return fetchJellyfinMovieDetails(cfg, cfg.type === "jellyfin" ? "" : "/emby");
}

async function fetchPlexItems(cfg: MediaServerConfig): Promise<MediaServerItem[]> {
  const headers = { Accept: "application/json" };
  const sectionsRes = await fetch(`${cfg.url}/library/sections?X-Plex-Token=${cfg.token}`, { headers });
  if (!sectionsRes.ok) throw new Error(`Plex sections request failed: ${sectionsRes.status}`);
  const sectionsBody = (await sectionsRes.json()) as any;
  const sections: { key: string; type: string }[] = sectionsBody?.MediaContainer?.Directory ?? [];

  const items: MediaServerItem[] = [];
  for (const section of sections) {
    if (section.type !== "movie" && section.type !== "show") continue;
    const itemType = section.type === "movie" ? 1 : 4;
    const itemsRes = await fetch(
      `${cfg.url}/library/sections/${section.key}/all?type=${itemType}&unwatched=0&X-Plex-Token=${cfg.token}`,
      { headers }
    );
    if (!itemsRes.ok) continue;
    const itemsBody = (await itemsRes.json()) as any;
    const metadata: any[] = itemsBody?.MediaContainer?.Metadata ?? [];
    for (const item of metadata) {
      for (const media of item.Media ?? []) {
        for (const part of media.Part ?? []) {
          if (part.file && item.ratingKey) items.push({ path: part.file, id: String(item.ratingKey) });
        }
      }
    }
  }
  return items;
}

/**
 * Tells the configured media server to pick up a just-imported file, instead of leaving it to
 * whatever periodic scan interval the media server itself is configured with — the same "Connect"
 * capability Sonarr/Radarr call a notification. Plex supports a *targeted* refresh scoped to one
 * path (`?path=`), which only rescans that folder rather than the whole library section — cheap
 * enough to call on every import, so this fires it against every movie/show section rather than
 * trying to guess which one the file belongs to (Plex just no-ops for a path outside a section).
 * Jellyfin/Emby have no equivalent lightweight per-path trigger via a simple REST call, so this
 * falls back to their full-library refresh endpoint for those two — heavier, but still far better
 * than waiting for their own scan interval. Never throws — this is a best-effort nicety alongside
 * the import that already succeeded, not something that should fail the import itself.
 */
export async function refreshMediaServerLibrary(filePath: string): Promise<void> {
  const cfg = getMediaServerConfig();
  if (!cfg) return;

  try {
    if (cfg.type === "plex") {
      const headers = { Accept: "application/json" };
      const sectionsRes = await fetch(`${cfg.url}/library/sections?X-Plex-Token=${cfg.token}`, { headers });
      if (!sectionsRes.ok) return;
      const sectionsBody = (await sectionsRes.json()) as any;
      const sections: { key: string; type: string }[] = sectionsBody?.MediaContainer?.Directory ?? [];
      for (const section of sections) {
        if (section.type !== "movie" && section.type !== "show") continue;
        await fetch(
          `${cfg.url}/library/sections/${section.key}/refresh?path=${encodeURIComponent(filePath)}&X-Plex-Token=${cfg.token}`,
          { method: "PUT", headers }
        ).catch(() => {});
      }
    } else {
      const basePath = cfg.type === "jellyfin" ? "" : "/emby";
      await fetch(`${cfg.url}${basePath}/Library/Refresh`, {
        method: "POST",
        headers: { "X-Emby-Token": cfg.token },
      });
    }
  } catch {
    // Best-effort — the import already succeeded regardless of whether the media server noticed.
  }
}

/**
 * Plex's webhook payload carries no file path at all (its Metadata object is a much lighter
 * subset than the real API's — no Media/Part/file, just RatingKey/Key/GUID/title fields), so a
 * webhook handler needs this follow-up API call to resolve the ratingKey it DOES get into an
 * actual file path, the same way fetchPlexItems() above already does for the polling path.
 */
export async function resolvePlexFilePath(ratingKey: string): Promise<string | null> {
  const cfg = getMediaServerConfig();
  if (!cfg || cfg.type !== "plex") return null;
  const res = await fetch(`${cfg.url}/library/metadata/${ratingKey}?X-Plex-Token=${cfg.token}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as any;
  const item = body?.MediaContainer?.Metadata?.[0];
  const file = item?.Media?.[0]?.Part?.[0]?.file;
  return typeof file === "string" && file ? file : null;
}

async function fetchJellyfinLikeItems(cfg: MediaServerConfig, basePath: string): Promise<{ items: MediaServerItem[]; userId: string | null }> {
  const headers = { "X-Emby-Token": cfg.token, Accept: "application/json" };
  const usersRes = await fetch(`${cfg.url}${basePath}/Users`, { headers });
  if (!usersRes.ok) throw new Error(`${cfg.type} users request failed: ${usersRes.status}`);
  const users = (await usersRes.json()) as { Id: string }[];
  if (users.length === 0) return { items: [], userId: null };

  const itemsRes = await fetch(
    `${cfg.url}${basePath}/Users/${users[0].Id}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Fields=Path`,
    { headers }
  );
  if (!itemsRes.ok) throw new Error(`${cfg.type} items request failed: ${itemsRes.status}`);
  const body = (await itemsRes.json()) as { Items?: any[] };

  const items: MediaServerItem[] = [];
  for (const item of body.Items ?? []) {
    if (item.Path && item.Id) items.push({ path: item.Path, id: String(item.Id) });
  }
  return { items, userId: users[0].Id };
}

/**
 * Pushes a manual "mark watched"/"mark unwatched" action (from a media detail page) to the
 * configured media server, so its own watched state stays in sync with AoNarr's rather than only
 * ever flowing the other way (media server -> AoNarr, via the webhook and fetchWatchedFiles).
 * Resolves the media server's own item id fresh on every call by path-tail match — a full library
 * fetch is more than a single toggle strictly needs, but this is a low-frequency manual admin
 * action, not something called in a hot loop, so the simplicity is worth it over caching an id
 * that could go stale if the media server re-imports/re-scans.
 */
export async function pushWatchState(filePath: string, watched: boolean): Promise<void> {
  const cfg = getMediaServerConfig();
  if (!cfg) return;
  const needle = pathTail(filePath);

  if (cfg.type === "plex") {
    const items = await fetchPlexItems(cfg);
    const match = items.find((i) => pathTail(i.path) === needle);
    if (!match) throw new Error("No matching item found on the media server for this file");
    const action = watched ? "scrobble" : "unscrobble";
    const res = await fetch(
      `${cfg.url}/:/${action}?key=${match.id}&identifier=com.plexapp.plugins.library&X-Plex-Token=${cfg.token}`,
      { method: "PUT" }
    );
    if (!res.ok) throw new Error(`Plex ${action} failed: HTTP ${res.status}`);
    return;
  }

  const basePath = cfg.type === "jellyfin" ? "" : "/emby";
  const { items, userId } = await fetchJellyfinLikeItems(cfg, basePath);
  if (!userId) throw new Error(`No ${cfg.type} user found to mark watch state for`);
  const match = items.find((i) => pathTail(i.path) === needle);
  if (!match) throw new Error("No matching item found on the media server for this file");
  const res = await fetch(`${cfg.url}${basePath}/Users/${userId}/PlayedItems/${match.id}`, {
    method: watched ? "POST" : "DELETE",
    headers: { "X-Emby-Token": cfg.token },
  });
  if (!res.ok) throw new Error(`${cfg.type} mark-watched failed: HTTP ${res.status}`);
}
