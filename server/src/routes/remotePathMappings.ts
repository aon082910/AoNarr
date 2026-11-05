import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { statAsync } from "../services/fsAsync.js";

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

const isWithin = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/**
 * Why this folder cannot be the local side of a mapping, or null. A scan of a path that goes through a mapping may look anywhere
 * in the mapping's local folder, so the folder has to be the download client's own and not one that holds more: the root of a
 * disk, or a folder that is (or contains) a library root folder would let a command reach the library's neighbours.
 */
async function localPathProblem(localPath: string): Promise<string | null> {
  const resolved = path.resolve(localPath);
  if (path.parse(resolved).root === resolved) return `The local path "${localPath}" is the root of a disk. Map the folder the download client writes to, not everything.`;
  const real = await fs.promises.realpath(localPath).catch(() => resolved);
  const roots = (await db.prepare("SELECT path FROM root_folders").all()) as { path: string | null }[];
  for (const row of roots) {
    if (!row.path) continue;
    const root = path.resolve(row.path);
    const realRoot = await fs.promises.realpath(row.path).catch(() => root);
    if ([resolved, real].some((folder) => [root, realRoot].some((r) => isWithin(r, folder)))) {
      return `The local path "${localPath}" is, or holds, the library root folder "${row.path}". Map the folder the download client writes to, not a folder that also holds the library.`;
    }
  }
  return null;
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

    // Sonarr/Radarr reject a mapping whose local path does not exist, and a duplicate. A wrong mapping is the
    // commonest Docker mistake and used to be silent: the importer then fell back to searching the whole
    // downloads folder, or failed with "No matching file found".
    if (!path.isAbsolute(localPath)) throw new HttpError(400, `The local path "${localPath}" must be an absolute path`);
    let localIsFolder = false;
    try {
      localIsFolder = (await statAsync(localPath, 10_000)).isDirectory();
    } catch {
      // missing, or a mount that does not answer
    }
    if (!localIsFolder) {
      throw new HttpError(400, `The local path "${localPath}" does not exist inside AoNarr (or is not a folder). Map the download folder into the container first.`);
    }
    const tooWide = await localPathProblem(localPath);
    if (tooWide) throw new HttpError(400, tooWide);
    const sameRemote = (await db.prepare("SELECT remote_path FROM remote_path_mappings WHERE download_client_id = ?").all(downloadClientId)) as {
      remote_path: string;
    }[];
    const normalize = (p: string) => p.replace(/[\\/]+$/, "");
    if (sameRemote.some((m) => normalize(m.remote_path) === normalize(remotePath))) {
      throw new HttpError(409, `This download client already has a mapping for "${remotePath}"`);
    }

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
