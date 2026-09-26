import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { compareFriendLibrary, type FriendLibraryConfig } from "../services/friendLibraries.js";
import { decryptValue, encryptValue, isEncryptedValue } from "../services/encryption.js";

export const friendLibrariesRouter = Router();
friendLibrariesRouter.use(requireAdmin);

function fromRow(row: any) {
  return { id: row.id, name: row.name, type: row.type, url: row.url, createdAt: row.created_at };
}

/** The stored access token, decrypted. A row saved before tokens were encrypted at rest is re-saved
 * encrypted the first time it's used. */
async function friendToken(row: { id: number; name: string; token: string }): Promise<string> {
  if (!isEncryptedValue(row.token)) {
    // Only while the row still holds the token read above: one replaced through PATCH in the
    // meantime must not be overwritten with the old one.
    await db
      .prepare("UPDATE friend_libraries SET token = ? WHERE id = ? AND token = ?")
      .run(encryptValue(row.token), row.id, row.token);
    return row.token;
  }
  try {
    return decryptValue(row.token);
  } catch {
    throw new HttpError(500, `The stored token for "${row.name}" can't be decrypted (encryption.key changed) — re-enter it`);
  }
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
      .run(b.name, b.type, b.url.replace(/\/+$/, ""), encryptValue(String(b.token)));
    const row = await db.prepare("SELECT * FROM friend_libraries WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(fromRow(row));
  })
);

friendLibrariesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (b.type !== undefined && !["plex", "jellyfin", "emby"].includes(b.type)) {
      throw new HttpError(400, "type must be plex, jellyfin or emby");
    }
    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(b.name);
    }
    if (b.type !== undefined) {
      sets.push("type = ?");
      values.push(b.type);
    }
    if (b.url !== undefined) {
      sets.push("url = ?");
      values.push(String(b.url).replace(/\/+$/, ""));
    }
    if (b.token) {
      sets.push("token = ?");
      values.push(encryptValue(String(b.token)));
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE friend_libraries SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM friend_libraries WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Friend library not found");
    res.json(fromRow(row));
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
    const cfg: FriendLibraryConfig = { id: row.id, name: row.name, type: row.type, url: row.url, token: await friendToken(row) };
    try {
      const missing = await compareFriendLibrary(cfg);
      res.json(missing);
    } catch (err) {
      throw new HttpError(502, `Could not reach "${row.name}": ${(err as Error).message}`);
    }
  })
);
