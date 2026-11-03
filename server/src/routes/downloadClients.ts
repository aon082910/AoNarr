import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { downloadClientFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getDownloadClientAdapter, normalizeUrlBase, testDownloadClientConnection } from "../services/downloadClient.js";
import { isValidMediaType } from "../services/mediaTypes.js";
import { auditActor, logAuditEvent } from "../services/audit.js";
import { encryptValue } from "../services/encryption.js";
import { notifyQueueChanged } from "../services/realtime.js";
import { resetSearchBackoff } from "../services/searchBackoff.js";
import { checkedTagIdsColumn } from "../services/tagScope.js";
import { recordClientSuccess } from "../services/clientStatus.js";

export const downloadClientsRouter = Router();
downloadClientsRouter.use(requireAdmin);

const VALID_DOWNLOAD_TYPES = new Set(["torrent", "usenet"]);

/** Client types that are reached over the network, so they need a host and a port. */
const NETWORK_CLIENT_TYPES = new Set(["qbittorrent", "sabnzbd", "slskd", "nzbget", "transmission", "deluge"]);

/** A client's priority from a request: 1 to 50, lower is preferred. */
function priorityInput(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new HttpError(400, "priority must be a whole number from 1 to 50 (lower is preferred)");
  return n;
}

/** The category per media type from a request: { mediaType: category }; empty or null clears it. Returns the JSON to store. */
function categoryByTypeInput(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "categoryByType must be an object of media type to category");
  const out: Record<string, string> = {};
  for (const [type, category] of Object.entries(value as Record<string, unknown>)) {
    if (!isValidMediaType(type)) throw new HttpError(400, `Unknown media type "${type}" in categoryByType`);
    if (typeof category !== "string") throw new HttpError(400, `The category for "${type}" must be text`);
    if (category.trim()) out[type] = category.trim();
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** Validates/normalizes a client's `downloadTypes` override (which release protocol(s) it should
 * be used for — see services/scheduler.ts's pickClientForProtocol). An empty array or anything not
 * an array collapses to null ("not configured, use this client type's own default"), same
 * empty-means-null convention as customFormats.ts's mediaTypes. */
function normalizeDownloadTypes(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const filtered = input.filter((v): v is string => typeof v === "string" && VALID_DOWNLOAD_TYPES.has(v));
  return filtered.length > 0 ? Array.from(new Set(filtered)) : null;
}

/** The tag scope: null for none (every title), else the JSON list. */
async function tagScope(value: unknown): Promise<string | null | undefined> {
  try {
    return await checkedTagIdsColumn(value);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

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
    const needsHost = NETWORK_CLIENT_TYPES.has(b.type);
    if (needsHost && (!b.host || !b.port)) throw new HttpError(400, "host and port are required for this client type");
    const downloadTypes = normalizeDownloadTypes(b.downloadTypes);
    const tagIds = await tagScope(b.tagIds);
    const priority = priorityInput(b.priority);
    const categoryByType = categoryByTypeInput(b.categoryByType);

    const result = await db
      .prepare(
        `INSERT INTO download_clients (name, type, host, port, use_ssl, username, password, api_key, category, enabled, audio_only, download_types, tag_ids, priority, url_base, category_by_type)
         VALUES (@name, @type, @host, @port, @useSsl, @username, @password, @apiKey, @category, @enabled, @audioOnly, @downloadTypes, @tagIds, @priority, @urlBase, @categoryByType)`
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
        downloadTypes: downloadTypes ? JSON.stringify(downloadTypes) : null,
        tagIds: tagIds ?? null,
        priority: priority ?? 1,
        urlBase: normalizeUrlBase(b.urlBase) || null,
        categoryByType: categoryByType ?? null,
      });
    const row = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(result.lastInsertRowid);
    // A client for a new protocol makes releases grabbable that no search could use until now.
    await resetSearchBackoff();
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
      downloadTypes: "download_types",
      tagIds: "tag_ids",
      priority: "priority",
      urlBase: "url_base",
      categoryByType: "category_by_type",
    };
    if (b.tagIds !== undefined) b.tagIds = await tagScope(b.tagIds);
    if (b.priority !== undefined) b.priority = priorityInput(b.priority);
    if (b.urlBase !== undefined) b.urlBase = normalizeUrlBase(b.urlBase) || null;
    if (b.categoryByType !== undefined) b.categoryByType = categoryByTypeInput(b.categoryByType);
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
        // the equivalent settings-table credentials — see services/encryption.ts. downloadTypes is
        // stored as a JSON array, same normalize-to-null-when-empty convention as POST above.
        values.push(
          key === "downloadTypes"
            ? (() => {
                const dt = normalizeDownloadTypes(b.downloadTypes);
                return dt ? JSON.stringify(dt) : null;
              })()
            : booleanKeys.has(key)
              ? b[key]
                ? 1
                : 0
              : secretKeys.has(key) && b[key]
                ? encryptValue(b[key])
                : b[key]
        );
      }
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE download_clients SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      await resetSearchBackoff();
      // A fixed password or address, or the client switched back on, ends the wait it was serving.
      if (["host", "port", "useSsl", "username", "password", "apiKey", "urlBase", "enabled"].some((key) => b[key] !== undefined)) {
        await recordClientSuccess(Number(req.params.id));
      }
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
 * pattern as POST /indexers/:id/test. */
downloadClientsRouter.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Download client not found");
    const client = downloadClientFromRow(row) as any;
    try {
      await testDownloadClientConnection(client);
      // The admin asked and it answered: any wait it was serving is over.
      await recordClientSuccess(client.id);
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  })
);

downloadClientsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = (await db.prepare("SELECT id, name FROM download_clients WHERE id = ?").get(req.params.id)) as
      | { id: number; name: string }
      | undefined;
    if (!existing) throw new HttpError(404, "Download client not found");
    // Its queue rows outlive it (download_client_id goes NULL), but nothing ever polls them again:
    // still queued/downloading, they'd block every future search for their targets. Failed, the
    // targets are searched again; the releases did nothing wrong, so nothing is blocklisted.
    const stranded = await db
      .prepare(`UPDATE queue SET status = 'failed', updated_at = ${nowExpr(db)} WHERE download_client_id = ? AND status IN ('queued', 'downloading')`)
      .run(existing.id);
    const result = await db.prepare("DELETE FROM download_clients WHERE id = ?").run(existing.id);
    if (result.changes === 0) throw new HttpError(404, "Download client not found");
    if (stranded.changes > 0) notifyQueueChanged();
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "download_client_removed", existing?.name);
    res.status(204).send();
  })
);
