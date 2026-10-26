import { parseStringPromise } from "xml2js";
import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";
import { encryptValue } from "./encryption.js";
import { indexerApiError } from "./indexerClient.js";
import { resetSearchBackoff } from "./searchBackoff.js";
import { disableUnsyncedDuplicates, mediaTypesFromCategoryIds, parseIndexerConfig, syncedMediaTypes, withSyncFields } from "./prowlarrSync.js";

interface JackettIndexer {
  id: string;
  name: string | null;
  /** The category ids (and subcategory ids) its <caps> lists. */
  categoryIds: number[];
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
      const categories: any[] = e?.caps?.[0]?.categories?.[0]?.category ?? [];
      const categoryIds = categories
        .flatMap((c) => [c?.$?.id, ...(c?.subcat ?? []).map((sub: any) => sub?.$?.id)])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);
      return { id: String(e?.$?.id ?? ""), name: typeof title === "string" ? title : (title?._ ?? null), categoryIds };
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
  // A new indexer, or one that now covers other media types, can find what the others could not.
  let reach = false;
  for (const idx of indexers) {
    try {
      const url = `${jackettUrl}/api/v2.0/indexers/${encodeURIComponent(idx.id)}/results/torznab`;
      const encryptedApiKey = encryptValue(apiKey);

      const existing = ((await db.prepare(`SELECT id, config, enabled, media_types FROM indexers WHERE config LIKE ?`).get(`%"jackettId":"${idx.id}"%`)) ??
        (await db.prepare("SELECT id, config, enabled, media_types FROM indexers WHERE url = ? ORDER BY id").get(url))) as
        | { id: number; config: string | null; enabled: number; media_types: string | null }
        | undefined;

      if (existing) {
        const mediaTypes = syncedMediaTypes(existing.media_types, parseIndexerConfig(existing.config).syncedMediaTypes, idx.categoryIds);
        // Jackett's own API has no per-indexer enable/disable concept to mirror the way Prowlarr's
        // `idx.enable` does — every indexer it returns is just "configured". `enabled` here is
        // purely an AoNarr-side admin preference, so an update must never touch it, or a user who
        // disabled this indexer in AoNarr finds it silently flipped back on the next sync.
        await db.prepare("UPDATE indexers SET name = ?, protocol = 'torznab', url = ?, api_key = ?, config = ?, media_types = ? WHERE id = ?").run(
          idx.name,
          url,
          encryptedApiKey,
          withSyncFields(existing.config, { jackettId: idx.id, syncedMediaTypes: mediaTypes }),
          mediaTypes,
          existing.id
        );
        await disableUnsyncedDuplicates({ id: existing.id, url, enabled: !!Number(existing.enabled) }, "jackettId", "jackettSync");
        if (mediaTypes !== existing.media_types) reach = true;
      } else {
        await db
          .prepare("INSERT INTO indexers (name, protocol, url, api_key, media_types, enabled, config) VALUES (?, 'torznab', ?, ?, ?, 1, ?)")
          .run(idx.name, url, encryptedApiKey, mediaTypesFromCategoryIds(idx.categoryIds), JSON.stringify({ syncedMediaTypes: mediaTypesFromCategoryIds(idx.categoryIds), jackettId: idx.id }));
        reach = true;
      }
      synced++;
    } catch (err) {
      log.warn(`[jackettSync] failed to sync indexer "${idx.name}":`, (err as Error).message);
    }
  }
  if (reach) await resetSearchBackoff();

  return { synced };
}
