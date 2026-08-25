import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

interface JackettIndexer {
  id: string;
  name: string;
  configured: boolean;
}

/**
 * Pulls the configured-indexer list from a Jackett instance and mirrors it into AoNarr's own
 * indexers table — the same idea as `prowlarrSync.ts`, but Jackett's management API and per-indexer
 * proxy URL shape are different: indexer ids are string slugs (e.g. "eztv"), not integers, there's
 * no protocol field (Jackett is torrent-only — no usenet/newznab), and the per-indexer Torznab
 * proxy path is `/api/v2.0/indexers/{id}/results/torznab` (AoNarr's existing torznab client appends
 * `/api` and its own `t=`/`apikey=` params itself, same as it does for a direct/Prowlarr indexer).
 * Matches existing rows by the Jackett indexer id stashed in `config` on a prior sync, so re-running
 * updates rather than duplicating.
 */
export async function syncFromJackett(): Promise<{ synced: number; error?: string }> {
  const jackettUrl = getSetting("jackettUrl")?.replace(/\/+$/, "");
  const apiKey = getSetting("jackettApiKey");
  if (!jackettUrl || !apiKey) return { synced: 0, error: "Jackett URL and API key must both be set" };

  let indexers: JackettIndexer[];
  try {
    const res = await fetch(`${jackettUrl}/api/v2.0/indexers?configured=true`, { headers: { "X-Api-Key": apiKey } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    indexers = (await res.json()) as JackettIndexer[];
  } catch (err) {
    return { synced: 0, error: `Failed to reach Jackett: ${(err as Error).message}` };
  }

  let synced = 0;
  for (const idx of indexers) {
    try {
      const url = `${jackettUrl}/api/v2.0/indexers/${encodeURIComponent(idx.id)}/results/torznab`;
      const config = JSON.stringify({ jackettId: idx.id });

      const existing = (await db.prepare(`SELECT id FROM indexers WHERE config LIKE ?`).get(`%"jackettId":"${idx.id}"%`)) as
        | { id: number }
        | undefined;

      if (existing) {
        await db.prepare("UPDATE indexers SET name = ?, protocol = 'torznab', url = ?, api_key = ?, enabled = 1 WHERE id = ?").run(
          idx.name,
          url,
          apiKey,
          existing.id
        );
      } else {
        await db
          .prepare("INSERT INTO indexers (name, protocol, url, api_key, enabled, config) VALUES (?, 'torznab', ?, ?, 1, ?)")
          .run(idx.name, url, apiKey, config);
      }
      synced++;
    } catch (err) {
      log.warn(`[jackettSync] failed to sync indexer "${idx.name}":`, (err as Error).message);
    }
  }

  return { synced };
}
