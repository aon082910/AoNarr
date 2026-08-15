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
