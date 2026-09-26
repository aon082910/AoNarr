import { parseStringPromise } from "xml2js";
import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";
import { encryptValue } from "./encryption.js";
import { DEFAULT_INDEXER_MEDIA_TYPES, indexerApiError } from "./indexerClient.js";
import { disableUnsyncedDuplicates, withSyncFields } from "./prowlarrSync.js";

interface JackettIndexer {
  id: string;
  name: string | null;
}

/**
 * Jackett's JSON management API (/api/v2.0/indexers) only accepts its UI login cookie — it never
 * reads an API key, so a server-to-server call gets redirected to the login page. The Torznab
 * "all" aggregate endpoint does take the API key, and `t=indexers` lists the configured indexers.
 */
async function fetchConfiguredJackettIndexers(jackettUrl: string, apiKey: string): Promise<JackettIndexer[]> {
  const url = new URL(`${jackettUrl}/api/v2.0/indexers/all/results/torznab/api`);
  url.searchParams.set("t", "indexers");
  url.searchParams.set("configured", "true");
  url.searchParams.set("apikey", apiKey);
  const res = await fetch(url.toString(), { headers: { Accept: "application/xml, text/xml" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed: any = await parseStringPromise(await res.text(), { explicitArray: true, mergeAttrs: false });
  const apiError = indexerApiError(parsed);
  if (apiError) throw new Error(`Jackett error ${apiError.code}: ${apiError.description}`);
  if (!parsed || typeof parsed !== "object" || !("indexers" in parsed)) {
    throw new Error("unexpected response (no <indexers> list) — check the Jackett URL");
  }
  const entries: any[] = parsed.indexers?.indexer ?? [];
  return entries
    .filter((e) => String(e?.$?.configured ?? "true").toLowerCase() !== "false")
    .map((e) => {
      const title = e?.title?.[0];
      return { id: String(e?.$?.id ?? ""), name: typeof title === "string" ? title : (title?._ ?? null) };
    })
    .filter((e) => e.id);
}

/**
 * Pulls the configured-indexer list from a Jackett instance and mirrors it into AoNarr's own
 * indexers table — the same idea as `prowlarrSync.ts`, but Jackett's per-indexer proxy URL shape is
 * different: indexer ids are string slugs (e.g. "eztv"), not integers, there's no protocol field
 * (Jackett is torrent-only — no usenet/newznab), and the per-indexer Torznab proxy path is
 * `/api/v2.0/indexers/{id}/results/torznab` (AoNarr's existing torznab client appends `/api` and
 * its own `t=`/`apikey=` params itself, same as it does for a direct/Prowlarr indexer).
 * Matches existing rows by the Jackett indexer id stashed in `config` on a prior sync (or, for a
 * row whose config was lost, by its proxy URL), so re-running updates rather than duplicating.
 */
export async function syncFromJackett(): Promise<{ synced: number; error?: string }> {
  const jackettUrl = getSetting("jackettUrl")?.replace(/\/+$/, "");
  const apiKey = getSetting("jackettApiKey");
  if (!jackettUrl || !apiKey) return { synced: 0, error: "Jackett URL and API key must both be set" };

  let indexers: JackettIndexer[];
  try {
    indexers = await fetchConfiguredJackettIndexers(jackettUrl, apiKey);
  } catch (err) {
    return { synced: 0, error: `Failed to reach Jackett: ${(err as Error).message}` };
  }

  let synced = 0;
  for (const idx of indexers) {
    try {
      const url = `${jackettUrl}/api/v2.0/indexers/${encodeURIComponent(idx.id)}/results/torznab`;
      const encryptedApiKey = encryptValue(apiKey);

      const existing = ((await db.prepare(`SELECT id, config, enabled FROM indexers WHERE config LIKE ?`).get(`%"jackettId":"${idx.id}"%`)) ??
        (await db.prepare("SELECT id, config, enabled FROM indexers WHERE url = ? ORDER BY id").get(url))) as
        | { id: number; config: string | null; enabled: number }
        | undefined;

      if (existing) {
        // Jackett's own API has no per-indexer enable/disable concept to mirror the way Prowlarr's
        // `idx.enable` does — every indexer it returns is just "configured". `enabled` here is
        // purely an AoNarr-side admin preference, so an update must never touch it, or a user who
        // disabled this indexer in AoNarr finds it silently flipped back on the next sync.
        await db.prepare("UPDATE indexers SET name = ?, protocol = 'torznab', url = ?, api_key = ?, config = ? WHERE id = ?").run(
          idx.name,
          url,
          encryptedApiKey,
          withSyncFields(existing.config, { jackettId: idx.id }),
          existing.id
        );
        await disableUnsyncedDuplicates({ id: existing.id, url, enabled: !!Number(existing.enabled) }, "jackettId", "jackettSync");
      } else {
        await db
          .prepare("INSERT INTO indexers (name, protocol, url, api_key, media_types, enabled, config) VALUES (?, 'torznab', ?, ?, ?, 1, ?)")
          .run(idx.name, url, encryptedApiKey, DEFAULT_INDEXER_MEDIA_TYPES, JSON.stringify({ jackettId: idx.id }));
      }
      synced++;
    } catch (err) {
      log.warn(`[jackettSync] failed to sync indexer "${idx.name}":`, (err as Error).message);
    }
  }

  return { synced };
}
