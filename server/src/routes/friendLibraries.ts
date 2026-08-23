import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { compareFriendLibrary, type FriendLibraryConfig } from "../services/friendLibraries.js";

export const friendLibrariesRouter = Router();
friendLibrariesRouter.use(requireAdmin);

function fromRow(row: any) {
  return { id: row.id, name: row.name, type: row.type, url: row.url, createdAt: row.created_at };
}

friendLibrariesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM friend_libraries ORDER BY name").all();
    res.json(rows.map(fromRow));
  })
);

friendLibrariesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.type || !b.url || !b.token) throw new HttpError(400, "name, type, url and token are required");
    if (!["plex", "jellyfin", "emby"].includes(b.type)) throw new HttpError(400, "type must be plex, jellyfin or emby");
    const result = await db
      .prepare("INSERT INTO friend_libraries (name, type, url, token) VALUES (?, ?, ?, ?)")
      .run(b.name, b.type, b.url.replace(/\/+$/, ""), b.token);
    const row = await db.prepare("SELECT * FROM friend_libraries WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(fromRow(row));
  })
);

friendLibrariesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM friend_libraries WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Friend library not found");
    res.status(204).send();
  })
);

/** Fetches the friend's library fresh (no caching — they can add/remove titles at any time) and
 * returns everything in it that isn't in this instance's own library, by title+year. */
friendLibrariesRouter.get(
  "/:id/compare",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM friend_libraries WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Friend library not found");
    const cfg: FriendLibraryConfig = { id: row.id, name: row.name, type: row.type, url: row.url, token: row.token };
    try {
      const missing = await compareFriendLibrary(cfg);
      res.json(missing);
    } catch (err) {
      throw new HttpError(502, `Could not reach "${row.name}": ${(err as Error).message}`);
    }
  })
);
