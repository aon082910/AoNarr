import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const remotePathMappingsRouter = Router();
remotePathMappingsRouter.use(requireAdmin);

function mappingFromRow(row: any) {
  return {
    id: row.id,
    downloadClientId: row.download_client_id,
    remotePath: row.remote_path,
    localPath: row.local_path,
    createdAt: row.created_at,
  };
}

remotePathMappingsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM remote_path_mappings ORDER BY id").all();
    res.json(rows.map(mappingFromRow));
  })
);

remotePathMappingsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const downloadClientId = Number(b.downloadClientId);
    const remotePath = (b.remotePath ?? "").trim();
    const localPath = (b.localPath ?? "").trim();
    if (!downloadClientId) throw new HttpError(400, "downloadClientId is required");
    if (!remotePath) throw new HttpError(400, "remotePath is required");
    if (!localPath) throw new HttpError(400, "localPath is required");

    const client = await db.prepare("SELECT id FROM download_clients WHERE id = ?").get(downloadClientId);
    if (!client) throw new HttpError(404, "Download client not found");

    const result = await db
      .prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, ?, ?)")
      .run(downloadClientId, remotePath, localPath);
    const row = await db.prepare("SELECT * FROM remote_path_mappings WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(mappingFromRow(row));
  })
);

remotePathMappingsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM remote_path_mappings WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Remote path mapping not found");
    res.status(204).send();
  })
);
