import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { indexerFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { searchIndexer } from "../services/indexerClient.js";
import { attachIndexerHealth } from "../services/indexerHealth.js";
import { syncFromProwlarr } from "../services/prowlarrSync.js";
import { auditActor, logAuditEvent } from "../services/audit.js";

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

indexersRouter.post(
  "/prowlarr-sync",
  asyncHandler(async (_req, res) => {
    const result = await syncFromProwlarr();
    if (result.error) throw new HttpError(400, result.error);
    res.json(result);
  })
);

indexersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.protocol || !b.url) throw new HttpError(400, "name, protocol and url are required");

    const result = await db
      .prepare(
        `INSERT INTO indexers (name, protocol, url, api_key, categories, media_types, enabled, priority, config, use_flaresolverr)
         VALUES (@name, @protocol, @url, @apiKey, @categories, @mediaTypes, @enabled, @priority, @config, @useFlareSolverr)`
      )
      .run({
        name: b.name,
        protocol: b.protocol,
        url: b.url,
        apiKey: b.apiKey ?? null,
        categories: b.categories ?? "",
        mediaTypes: b.mediaTypes ?? "movie,series,artist,author",
        enabled: b.enabled === false ? 0 : 1,
        priority: b.priority ?? 25,
        config: b.config ? JSON.stringify(b.config) : null,
        useFlareSolverr: b.useFlareSolverr ? 1 : 0,
      });

    const row = await db.prepare("SELECT * FROM indexers WHERE id = ?").get(result.lastInsertRowid);
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
      useFlareSolverr: "use_flaresolverr",
    };
    const booleanKeys = new Set(["enabled", "useFlareSolverr"]);
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, col] of Object.entries(map)) {
      if (b[key] !== undefined) {
        sets.push(`${col} = ?`);
        // Postgres (like better-sqlite3) rejects binding a raw JS boolean to an INTEGER column —
        // coerce true/false to 1/0 for the columns that are actually booleans.
        values.push(booleanKeys.has(key) ? (b[key] ? 1 : 0) : b[key]);
      }
    }
    if (b.config !== undefined) {
      sets.push("config = ?");
      values.push(b.config ? JSON.stringify(b.config) : null);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE indexers SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM indexers WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Indexer not found");
    res.json(indexerFromRow(row));
  })
);

indexersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = (await db.prepare("SELECT name FROM indexers WHERE id = ?").get(req.params.id)) as { name: string } | undefined;
    const result = await db.prepare("DELETE FROM indexers WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Indexer not found");
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
    try {
      const results = await searchIndexer(indexer, "test", "movie");
      res.json({ ok: true, resultCount: results.length });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  })
);
