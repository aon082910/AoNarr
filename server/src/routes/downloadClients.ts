import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { downloadClientFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getDownloadClientAdapter, testDownloadClientConnection } from "../services/downloadClient.js";
import { auditActor, logAuditEvent } from "../services/audit.js";
import { encryptValue } from "../services/encryption.js";

export const downloadClientsRouter = Router();
downloadClientsRouter.use(requireAdmin);

downloadClientsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM download_clients").all();
    res.json(rows.map(downloadClientFromRow));
  })
);

downloadClientsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.type) throw new HttpError(400, "name and type are required");
    const needsHost = b.type === "qbittorrent" || b.type === "sabnzbd" || b.type === "slskd";
    if (needsHost && (!b.host || !b.port)) throw new HttpError(400, "host and port are required for this client type");

    const result = await db
      .prepare(
        `INSERT INTO download_clients (name, type, host, port, use_ssl, username, password, api_key, category, enabled, audio_only)
         VALUES (@name, @type, @host, @port, @useSsl, @username, @password, @apiKey, @category, @enabled, @audioOnly)`
      )
      .run({
        name: b.name,
        type: b.type,
        host: b.host ?? null,
        port: b.port ?? null,
        useSsl: b.useSsl ? 1 : 0,
        username: b.username ?? null,
        password: b.password ? encryptValue(b.password) : null,
        apiKey: b.apiKey ? encryptValue(b.apiKey) : null,
        category: b.category ?? null,
        enabled: b.enabled === false ? 0 : 1,
        audioOnly: b.audioOnly ? 1 : 0,
      });
    const row = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(result.lastInsertRowid);
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "download_client_added", `${b.name} (${b.type})`);
    res.status(201).json(downloadClientFromRow(row));
  })
);

downloadClientsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const map: Record<string, string> = {
      name: "name",
      type: "type",
      host: "host",
      port: "port",
      useSsl: "use_ssl",
      username: "username",
      password: "password",
      apiKey: "api_key",
      category: "category",
      enabled: "enabled",
      audioOnly: "audio_only",
    };
    const booleanKeys = new Set(["useSsl", "enabled", "audioOnly"]);
    const sets: string[] = [];
    const values: any[] = [];
    const secretKeys = new Set(["password", "apiKey"]);
    for (const [key, col] of Object.entries(map)) {
      if (b[key] !== undefined) {
        sets.push(`${col} = ?`);
        // Postgres (like better-sqlite3) rejects binding a raw JS boolean to an INTEGER column —
        // coerce true/false to 1/0 for the handful of columns that are actually booleans
        // (everything else passes through as-is). password/apiKey are encrypted at rest, same as
        // the equivalent settings-table credentials — see services/encryption.ts.
        values.push(booleanKeys.has(key) ? (b[key] ? 1 : 0) : secretKeys.has(key) && b[key] ? encryptValue(b[key]) : b[key]);
      }
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE download_clients SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Download client not found");
    res.json(downloadClientFromRow(row));
  })
);

/** Seed ratio, upload/download totals, and ratio-limit config — only qBittorrent implements this
 * (usenet clients have no equivalent seeding concept), so this 400s cleanly for other types. */
downloadClientsRouter.get(
  "/:id/health",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Download client not found");
    const client = downloadClientFromRow(row) as any;

    const adapter = getDownloadClientAdapter(client.type);
    if (!adapter.getHealthStats) {
      throw new HttpError(400, `Health stats aren't available for "${client.type}" download clients`);
    }
    const stats = await adapter.getHealthStats(client);
    res.json(stats);
  })
);

/** Radarr-style "Test" — validates connectivity/credentials for the already-saved client, same
 * pattern as GET /indexers/:id/test. */
downloadClientsRouter.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Download client not found");
    const client = downloadClientFromRow(row) as any;
    try {
      await testDownloadClientConnection(client);
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  })
);

downloadClientsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = (await db.prepare("SELECT name FROM download_clients WHERE id = ?").get(req.params.id)) as
      | { name: string }
      | undefined;
    const result = await db.prepare("DELETE FROM download_clients WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Download client not found");
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "download_client_removed", existing?.name);
    res.status(204).send();
  })
);
