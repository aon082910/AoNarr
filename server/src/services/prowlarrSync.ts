import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

interface ProwlarrIndexer {
  id: number;
  name: string;
  protocol: "torrent" | "usenet";
  enable: boolean;
}

/**
 * Pulls the indexer list from a Prowlarr instance and mirrors it into AoNarr's own indexers
 * table, using Prowlarr's own per-indexer Torznab/Newznab-compatible proxy endpoint
 * (`{prowlarrUrl}/{indexerId}`, which AoNarr's existing torznab/newznab client already knows how
 * to talk to — it just appends `/api` and the apikey itself) rather than each indexer's real
 * upstream URL. That means indexer credentials/config stay managed in Prowlarr; AoNarr only needs
 * Prowlarr's own instance API key. Matches existing rows by the Prowlarr indexer id stashed in
 * `config` on a prior sync, so re-running updates rather than duplicating.
 */
export async function syncFromProwlarr(): Promise<{ synced: number; error?: string }> {
  const prowlarrUrl = getSetting("prowlarrUrl")?.replace(/\/+$/, "");
  const apiKey = getSetting("prowlarrApiKey");
  if (!prowlarrUrl || !apiKey) return { synced: 0, error: "Prowlarr URL and API key must both be set" };

  let indexers: ProwlarrIndexer[];
  try {
    const res = await fetch(`${prowlarrUrl}/api/v1/indexer`, { headers: { "X-Api-Key": apiKey } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    indexers = (await res.json()) as ProwlarrIndexer[];
  } catch (err) {
    return { synced: 0, error: `Failed to reach Prowlarr: ${(err as Error).message}` };
  }

  let synced = 0;
  for (const idx of indexers) {
    try {
      const protocol = idx.protocol === "usenet" ? "newznab" : "torznab";
      const url = `${prowlarrUrl}/${idx.id}`;
      const config = JSON.stringify({ prowlarrId: idx.id });

      const existing = (await db.prepare(`SELECT id FROM indexers WHERE config LIKE ?`).get(`%"prowlarrId":${idx.id}%`)) as
        | { id: number }
        | undefined;

      if (existing) {
        await db
          .prepare("UPDATE indexers SET name = ?, protocol = ?, url = ?, api_key = ?, enabled = ? WHERE id = ?")
          .run(idx.name, protocol, url, apiKey, idx.enable ? 1 : 0, existing.id);
      } else {
        await db
          .prepare("INSERT INTO indexers (name, protocol, url, api_key, enabled, config) VALUES (?, ?, ?, ?, ?, ?)")
          .run(idx.name, protocol, url, apiKey, idx.enable ? 1 : 0, config);
      }
      synced++;
    } catch (err) {
      log.warn(`[prowlarrSync] failed to sync indexer "${idx.name}":`, (err as Error).message);
    }
  }

  return { synced };
}
