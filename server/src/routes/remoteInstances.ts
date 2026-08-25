import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const remoteInstancesRouter = Router();
remoteInstancesRouter.use(requireAdmin);

function fromRow(row: any) {
  return { id: row.id, name: row.name, url: row.url, createdAt: row.created_at };
}

remoteInstancesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM remote_instances ORDER BY name").all();
    res.json(rows.map(fromRow));
  })
);

remoteInstancesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.url || !b.apiKey) throw new HttpError(400, "name, url and apiKey are required");
    const result = await db
      .prepare("INSERT INTO remote_instances (name, url, api_key) VALUES (?, ?, ?)")
      .run(b.name, b.url.replace(/\/+$/, ""), b.apiKey);
    const row = await db.prepare("SELECT * FROM remote_instances WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(fromRow(row));
  })
);

remoteInstancesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(b.name);
    }
    if (b.url !== undefined) {
      sets.push("url = ?");
      values.push(String(b.url).replace(/\/+$/, ""));
    }
    if (b.apiKey) {
      sets.push("api_key = ?");
      values.push(b.apiKey);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE remote_instances SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM remote_instances WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Remote instance not found");
    res.json(fromRow(row));
  })
);

remoteInstancesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM remote_instances WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Remote instance not found");
    res.status(204).send();
  })
);

/**
 * Read-only proxy into a remote AoNarr instance's own `/media` and `/media-types` endpoints,
 * using the API key stored for it — never exposed to the browser directly, so the admin only ever
 * needs the local instance's own credentials. No write actions are proxied; this is browse-only.
 */
remoteInstancesRouter.get(
  "/:id/media",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM remote_instances WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Remote instance not found");

    const type = req.query.type as string | undefined;
    const url = `${row.url}/api/media${type ? `?type=${encodeURIComponent(type)}` : ""}`;
    try {
      const remoteRes = await fetch(url, { headers: { "X-Api-Key": row.api_key }, signal: AbortSignal.timeout(15_000) });
      if (!remoteRes.ok) throw new Error(`Remote instance returned HTTP ${remoteRes.status}`);
      const body = await remoteRes.json();
      res.json(body);
    } catch (err) {
      throw new HttpError(502, `Could not reach remote instance "${row.name}": ${(err as Error).message}`);
    }
  })
);

remoteInstancesRouter.get(
  "/:id/media-types",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM remote_instances WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Remote instance not found");

    try {
      const remoteRes = await fetch(`${row.url}/api/media-types`, {
        headers: { "X-Api-Key": row.api_key },
        signal: AbortSignal.timeout(15_000),
      });
      if (!remoteRes.ok) throw new Error(`Remote instance returned HTTP ${remoteRes.status}`);
      const body = await remoteRes.json();
      res.json(body);
    } catch (err) {
      throw new HttpError(502, `Could not reach remote instance "${row.name}": ${(err as Error).message}`);
    }
  })
);
