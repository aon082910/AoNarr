import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";
import { encryptValue } from "./encryption.js";
import { DEFAULT_INDEXER_MEDIA_TYPES } from "./indexerClient.js";

interface ProwlarrIndexer {
  id: number;
  name: string;
  protocol: "torrent" | "usenet";
  enable: boolean;
}

/** The keys a Prowlarr/Jackett sync stores in `indexers.config` to find its own row again. */
export const SYNC_ID_KEYS = ["prowlarrId", "jackettId"] as const;
/** Sync bookkeeping that must survive an edit like the ids do: the Prowlarr enable flag seen on the
 * last sync, so only a change made in Prowlarr is mirrored, and the synced row a copy was once
 * disabled as a duplicate of (see disableUnsyncedDuplicates). */
const SYNC_STATE_KEYS = ["prowlarrEnabled", "duplicateOf"] as const;

function parseIndexerConfig(config: unknown): Record<string, unknown> {
  if (config && typeof config === "object" && !Array.isArray(config)) return { ...(config as Record<string, unknown>) };
  if (typeof config !== "string" || !config) return {};
  try {
    const parsed = JSON.parse(config);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * `nextConfig` (an object, a JSON string, or null) with the sync ids and sync state from
 * `existingConfig` carried over, as a JSON string (or null when nothing is left). Losing the id
 * makes the next scheduled sync treat the indexer as new and insert a duplicate. Sync ids are
 * written last because syncFromProwlarr matches `"prowlarrId":N}` — the id has to close the object.
 */
export function mergeSyncedIndexerConfig(existingConfig: unknown, nextConfig: unknown): string | null {
  const existing = parseIndexerConfig(existingConfig);
  const merged = parseIndexerConfig(nextConfig);
  const carried: Record<string, unknown> = {};
  for (const key of [...SYNC_STATE_KEYS, ...SYNC_ID_KEYS]) {
    const value = key in merged ? merged[key] : existing[key];
    delete merged[key];
    if (value !== undefined && value !== null) carried[key] = value;
  }
  const result = { ...merged, ...carried };
  return Object.keys(result).length > 0 ? JSON.stringify(result) : null;
}

/** An existing row's config with the given sync fields set, everything else in it kept. */
export function withSyncFields(existingConfig: unknown, fields: Record<string, unknown>): string {
  return mergeSyncedIndexerConfig(existingConfig, { ...parseIndexerConfig(existingConfig), ...fields }) as string;
}

/**
 * Before a sync could re-adopt a row by URL, editing a synced indexer lost its id and the next sync
 * inserted a second row for the same endpoint, so every search queried it twice. Those leftover
 * copies (same URL, no sync id) are disabled, not deleted — the admin may have customised them.
 * Nothing is done while the synced row itself is disabled: the copy is then the one in use.
 * A copy is disabled once and marked with `duplicateOf`: one the admin re-enables afterwards (say,
 * with other categories or media types) is a deliberate second row, and stays enabled.
 */
export async function disableUnsyncedDuplicates(
  synced: { id: number; url: string; enabled: boolean },
  syncKey: (typeof SYNC_ID_KEYS)[number],
  source: string
): Promise<void> {
  if (!synced.enabled) return;
  const copies = (await db
    .prepare(
      "SELECT id, name, config FROM indexers WHERE url = ? AND id <> ? AND enabled = 1 AND (config IS NULL OR (config NOT LIKE ? AND config NOT LIKE ?))"
    )
    .all(synced.url, synced.id, `%"${syncKey}":%`, '%"duplicateOf":%')) as { id: number; name: string; config: string | null }[];
  for (const copy of copies) {
    await db
      .prepare("UPDATE indexers SET enabled = 0, config = ? WHERE id = ?")
      .run(withSyncFields(copy.config, { duplicateOf: Number(synced.id) }), copy.id);
    log.warn(
      `[${source}] disabled indexer "${copy.name}" (id ${copy.id}): it duplicates the synced indexer id ${synced.id} (same URL), ` +
        `so every search queried that endpoint twice. Delete it if it is no longer needed, or re-enable it to keep both.`
    );
  }
}

/**
 * Pulls the indexer list from a Prowlarr instance and mirrors it into AoNarr's own indexers
 * table, using Prowlarr's own per-indexer Torznab/Newznab-compatible proxy endpoint
 * (`{prowlarrUrl}/{indexerId}`, which AoNarr's existing torznab/newznab client already knows how
 * to talk to — it just appends `/api` and the apikey itself) rather than each indexer's real
 * upstream URL. That means indexer credentials/config stay managed in Prowlarr; AoNarr only needs
 * Prowlarr's own instance API key. Matches existing rows by the Prowlarr indexer id stashed in
 * `config` on a prior sync (or, for a row whose config was lost, by its proxy URL), so re-running
 * updates rather than duplicating.
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
      const encryptedApiKey = encryptValue(apiKey);

      // Terminated with the closing brace so id 5 can't match the row for id 50/500.
      const existing = ((await db.prepare(`SELECT id, config, enabled FROM indexers WHERE config LIKE ?`).get(`%"prowlarrId":${idx.id}}%`)) ??
        (await db.prepare("SELECT id, config, enabled FROM indexers WHERE url = ? ORDER BY id").get(url))) as
        | { id: number; config: string | null; enabled: number }
        | undefined;
      const prowlarrEnabled = !!idx.enable;

      if (existing) {
        // Only a change of Prowlarr's own flag is mirrored: copying it on every sync re-enabled an
        // indexer the admin had turned off in AoNarr, while never copying it left one disabled in
        // Prowlarr enabled here, failing every search with Prowlarr's 410 "Indexer is disabled".
        // With no flag recorded yet (a row from an older sync), only a disable is mirrored.
        const lastSeen = parseIndexerConfig(existing.config).prowlarrEnabled;
        const mirrorEnabled = typeof lastSeen === "boolean" ? lastSeen !== prowlarrEnabled : !prowlarrEnabled;
        const config = withSyncFields(existing.config, { prowlarrEnabled, prowlarrId: idx.id });
        if (mirrorEnabled) {
          await db
            .prepare("UPDATE indexers SET name = ?, protocol = ?, url = ?, api_key = ?, enabled = ?, config = ? WHERE id = ?")
            .run(idx.name, protocol, url, encryptedApiKey, prowlarrEnabled ? 1 : 0, config, existing.id);
        } else {
          await db
            .prepare("UPDATE indexers SET name = ?, protocol = ?, url = ?, api_key = ?, config = ? WHERE id = ?")
            .run(idx.name, protocol, url, encryptedApiKey, config, existing.id);
        }
        const enabled = mirrorEnabled ? prowlarrEnabled : !!Number(existing.enabled);
        await disableUnsyncedDuplicates({ id: existing.id, url, enabled }, "prowlarrId", "prowlarrSync");
      } else {
        await db
          .prepare("INSERT INTO indexers (name, protocol, url, api_key, media_types, enabled, config) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(
            idx.name,
            protocol,
            url,
            encryptedApiKey,
            DEFAULT_INDEXER_MEDIA_TYPES,
            prowlarrEnabled ? 1 : 0,
            JSON.stringify({ prowlarrEnabled, prowlarrId: idx.id })
          );
      }
      synced++;
    } catch (err) {
      log.warn(`[prowlarrSync] failed to sync indexer "${idx.name}":`, (err as Error).message);
    }
  }

  return { synced };
}
