import { db } from "../db/index.js";
import { log } from "./logger.js";
import { translateTrashFormat, type TrashCustomFormat } from "./trashFormats.js";

const CF_DIR: Record<"radarr" | "sonarr", string> = {
  radarr: "docs/json/radarr/cf",
  sonarr: "docs/json/sonarr/cf",
};

/** New formats synced in for the first time get scoped to the app's own library types rather than
 * left unrestricted, since a Radarr-only format (e.g. a resolution/size tier) has no reason to also
 * apply to TV libraries. A user can always broaden the scope afterward like any other format. */
const APP_MEDIA_TYPES: Record<"radarr" | "sonarr", string[]> = {
  radarr: ["movie"],
  sonarr: ["series", "anime"],
};

interface GithubContentEntry {
  name: string;
  download_url: string;
  type: string;
}

async function listTrashFiles(app: "radarr" | "sonarr"): Promise<GithubContentEntry[]> {
  const res = await fetch(`https://api.github.com/repos/TRaSH-Guides/Guides/contents/${CF_DIR[app]}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "AoNarr" },
  });
  if (!res.ok) throw new Error(`GitHub API request failed: HTTP ${res.status}`);
  const entries = (await res.json()) as GithubContentEntry[];
  return entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));
}

/** Fetches every format file's raw JSON with a small concurrency cap — sequential would be slow
 * for a 100+ file directory, unbounded parallel would be rude to raw.githubusercontent.com. */
async function fetchAllWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface TrashSyncResult {
  added: number;
  updated: number;
  unsupported: string[];
  error?: string;
}

export async function syncTrashFormats(app: "radarr" | "sonarr"): Promise<TrashSyncResult> {
  const result: TrashSyncResult = { added: 0, updated: 0, unsupported: [] };

  let files: GithubContentEntry[];
  try {
    files = await listTrashFiles(app);
  } catch (err) {
    result.error = `Failed to list TRaSH-Guides ${app} formats: ${(err as Error).message}`;
    log.warn(`[trashSync] ${result.error}`);
    return result;
  }

  const fetched = await fetchAllWithConcurrency(files, 8, async (file): Promise<TrashCustomFormat | null> => {
    try {
      const res = await fetch(file.download_url);
      if (!res.ok) return null;
      return (await res.json()) as TrashCustomFormat;
    } catch {
      return null;
    }
  });

  const mediaTypes = APP_MEDIA_TYPES[app];

  for (const trash of fetched) {
    if (!trash?.trash_id || !trash.name || !Array.isArray(trash.specifications)) continue;
    const { groups } = translateTrashFormat(trash);
    if (groups.length === 0) {
      result.unsupported.push(trash.name);
      continue;
    }

    try {
      const existing = (await db.prepare("SELECT id FROM custom_formats WHERE trash_id = ?").get(trash.trash_id)) as
        | { id: number }
        | undefined;
      if (existing) {
        await db.prepare("UPDATE custom_formats SET name = ?, patterns = ? WHERE id = ?").run(trash.name, JSON.stringify(groups), existing.id);
        result.updated++;
      } else {
        await db
          .prepare("INSERT INTO custom_formats (name, patterns, media_types, trash_id) VALUES (?, ?, ?, ?)")
          .run(trash.name, JSON.stringify(groups), JSON.stringify(mediaTypes), trash.trash_id);
        result.added++;
      }
    } catch (err) {
      // Most likely a name collision with an existing manually-created format (custom_formats.name
      // is UNIQUE) — skip it rather than aborting the rest of the sync over one clash.
      log.warn(`[trashSync] failed to sync "${trash.name}":`, (err as Error).message);
    }
  }

  log.info(`[trashSync] ${app}: added ${result.added}, updated ${result.updated}, unsupported ${result.unsupported.length}`);
  return result;
}
