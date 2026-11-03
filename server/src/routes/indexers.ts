import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { indexerFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { clearFailureBackoff, DEFAULT_INDEXER_MEDIA_TYPES, INDEXER_MEDIA_TYPES, searchIndexer } from "../services/indexerClient.js";
import { attachIndexerHealth } from "../services/indexerHealth.js";
import { mergeSyncedIndexerConfig, syncFromProwlarr } from "../services/prowlarrSync.js";
import { syncFromJackett } from "../services/jackettSync.js";
import { auditActor, logAuditEvent } from "../services/audit.js";
import { encryptValue } from "../services/encryption.js";
import { removeReleaseProfileScopeId } from "./tags.js";
import { resetSearchBackoff } from "../services/searchBackoff.js";
import { checkedTagIdsColumn } from "../services/tagScope.js";

export const indexersRouter = Router();
indexersRouter.use(requireAdmin);

indexersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM indexers ORDER BY priority").all();
    const indexers = rows.map(indexerFromRow);
    await attachIndexerHealth(indexers);
    res.json(indexers);
  })
);

/** The library types an indexer can be assigned to, for the add/edit form's checkboxes. */
indexersRouter.get(
  "/media-types",
  asyncHandler(async (_req, res) => {
    res.json(INDEXER_MEDIA_TYPES);
  })
);

indexersRouter.post(
  "/prowlarr-sync",
  asyncHandler(async (_req, res) => {
    const result = await syncFromProwlarr();
    if (result.error) throw new HttpError(400, result.error);
    res.json(result);
  })
);

indexersRouter.post(
  "/jackett-sync",
  asyncHandler(async (_req, res) => {
    const result = await syncFromJackett();
    if (result.error) throw new HttpError(400, result.error);
    res.json(result);
  })
);

/** A whole number of 0 or more (0 = no minimum); undefined when the field was not sent. */
function minimumSeeders(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new HttpError(400, "minimumSeeders must be a whole number of 0 or more");
  return n;
}

/** The seed goal fields: null or '' clears the goal (the global goal applies); otherwise a number of 0 or more. */
function seedGoal(value: unknown, field: string, whole: boolean): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n)) || n > 2147483647) {
    throw new HttpError(400, `${field} must be ${whole ? "a whole number" : "a number"} of 0 or more, or empty to use the global goal`);
  }
  return n;
}

/** The download client an indexer's releases go to: null or '' picks by protocol; otherwise an existing client. */
async function downloadClientChoice(value: unknown): Promise<number | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || !(await db.prepare("SELECT 1 AS ok FROM download_clients WHERE id = ?").get(id))) {
    throw new HttpError(400, "downloadClientId must be an existing download client, or empty to pick one by protocol");
  }
  return id;
}

/** The tag scope: null for none (every title), else the JSON list. */
async function tagScope(value: unknown): Promise<string | null | undefined> {
  try {
    return await checkedTagIdsColumn(value);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

indexersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.protocol || !b.url) throw new HttpError(400, "name, protocol and url are required");
    const seedRatio = seedGoal(b.seedRatio, "seedRatio", false);
    const seedTimeMinutes = seedGoal(b.seedTimeMinutes, "seedTimeMinutes", true);
    const downloadClientId = await downloadClientChoice(b.downloadClientId);
    const tagIds = await tagScope(b.tagIds);

    const result = await db
      .prepare(
        `INSERT INTO indexers (name, protocol, url, api_key, categories, media_types, enabled, priority, minimum_seeders, config, use_flaresolverr, query_limit_per_hour,
           tag_ids, enable_rss, enable_automatic_search, enable_interactive_search, seed_ratio, seed_time_minutes, download_client_id)
         VALUES (@name, @protocol, @url, @apiKey, @categories, @mediaTypes, @enabled, @priority, @minimumSeeders, @config, @useFlareSolverr, @queryLimitPerHour,
           @tagIds, @enableRss, @enableAutomaticSearch, @enableInteractiveSearch, @seedRatio, @seedTimeMinutes, @downloadClientId)`
      )
      .run({
        name: b.name,
        protocol: b.protocol,
        url: b.url,
        apiKey: b.apiKey ? encryptValue(b.apiKey) : null,
        categories: b.categories ?? "",
        mediaTypes: b.mediaTypes ?? DEFAULT_INDEXER_MEDIA_TYPES,
        enabled: b.enabled === false ? 0 : 1,
        priority: b.priority ?? 25,
        // Sonarr and Radarr start a torrent indexer at 1 seeder: a dead torrent never finishes, and holds its target until the stalled clean-up.
        minimumSeeders: minimumSeeders(b.minimumSeeders) ?? 1,
        config: b.config ? JSON.stringify(b.config) : null,
        useFlareSolverr: b.useFlareSolverr ? 1 : 0,
        queryLimitPerHour: b.queryLimitPerHour ?? null,
        tagIds: tagIds ?? null,
        enableRss: b.enableRss === false || b.enableRss === 0 ? 0 : 1,
        enableAutomaticSearch: b.enableAutomaticSearch === false || b.enableAutomaticSearch === 0 ? 0 : 1,
        enableInteractiveSearch: b.enableInteractiveSearch === false || b.enableInteractiveSearch === 0 ? 0 : 1,
        seedRatio: seedRatio ?? null,
        seedTimeMinutes: seedTimeMinutes ?? null,
        downloadClientId: downloadClientId ?? null,
      });

    const row = await db.prepare("SELECT * FROM indexers WHERE id = ?").get(result.lastInsertRowid);
    // A new indexer may have what the others did not: targets the searches kept finding nothing for are searched again.
    await resetSearchBackoff();
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "indexer_added", `${b.name} (${b.protocol})`);
    res.status(201).json(indexerFromRow(row));
  })
);

indexersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const map: Record<string, string> = {
      name: "name",
      protocol: "protocol",
      url: "url",
      apiKey: "api_key",
      categories: "categories",
      mediaTypes: "media_types",
      enabled: "enabled",
      priority: "priority",
      minimumSeeders: "minimum_seeders",
      useFlareSolverr: "use_flaresolverr",
      queryLimitPerHour: "query_limit_per_hour",
      enableRss: "enable_rss",
      enableAutomaticSearch: "enable_automatic_search",
      enableInteractiveSearch: "enable_interactive_search",
      seedRatio: "seed_ratio",
      seedTimeMinutes: "seed_time_minutes",
      downloadClientId: "download_client_id",
      tagIds: "tag_ids",
    };
    if (b.minimumSeeders !== undefined) b.minimumSeeders = minimumSeeders(b.minimumSeeders) ?? 0;
    if (b.seedRatio !== undefined) b.seedRatio = seedGoal(b.seedRatio, "seedRatio", false);
    if (b.seedTimeMinutes !== undefined) b.seedTimeMinutes = seedGoal(b.seedTimeMinutes, "seedTimeMinutes", true);
    if (b.downloadClientId !== undefined) b.downloadClientId = await downloadClientChoice(b.downloadClientId);
    if (b.tagIds !== undefined) b.tagIds = await tagScope(b.tagIds);
    const booleanKeys = new Set(["enabled", "useFlareSolverr", "enableRss", "enableAutomaticSearch", "enableInteractiveSearch"]);
    const secretKeys = new Set(["apiKey"]);
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, col] of Object.entries(map)) {
      if (b[key] !== undefined) {
        sets.push(`${col} = ?`);
        // Postgres (like better-sqlite3) rejects binding a raw JS boolean to an INTEGER column —
        // coerce true/false to 1/0 for the columns that are actually booleans. apiKey is encrypted
        // at rest, same as the equivalent download_clients credential — see services/encryption.ts.
        values.push(
          booleanKeys.has(key) ? (b[key] ? 1 : 0) : secretKeys.has(key) && b[key] ? encryptValue(b[key]) : b[key]
        );
      }
    }
    if (b.config !== undefined) {
      // A Prowlarr/Jackett-synced row is found again only by the sync id stored in its config, so
      // an edit that replaces config must carry that id over or the next sync inserts a duplicate.
      const existing = (await db.prepare("SELECT config FROM indexers WHERE id = ?").get(req.params.id)) as
        | { config: string | null }
        | undefined;
      sets.push("config = ?");
      values.push(mergeSyncedIndexerConfig(existing?.config ?? null, b.config || null));
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE indexers SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM indexers WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Indexer not found");
    // An edit (a key fixed, a URL corrected) is a reason to try the indexer again at once.
    if (sets.length > 0) {
      clearFailureBackoff(Number(req.params.id));
      await resetSearchBackoff();
    }
    res.json(indexerFromRow(row));
  })
);

indexersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = (await db.prepare("SELECT name FROM indexers WHERE id = ?").get(req.params.id)) as { name: string } | undefined;
    let deleted = false;
    await db.transaction(async () => {
      const result = await db.prepare("DELETE FROM indexers WHERE id = ?").run(req.params.id);
      deleted = result.changes > 0;
      if (deleted) await removeReleaseProfileScopeId("indexer_ids", Number(req.params.id), { disableWhenEmptied: true });
    });
    if (!deleted) throw new HttpError(404, "Indexer not found");
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "indexer_removed", existing?.name);
    res.status(204).send();
  })
);

indexersRouter.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM indexers WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Indexer not found");
    const indexer = indexerFromRow(row) as any;
    // The admin asked for the test: an earlier run of failures does not stand in its way.
    clearFailureBackoff(indexer.id);
    try {
      const results = await searchIndexer(indexer, "test", "movie");
      res.json({ ok: true, resultCount: results.length });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  })
);
