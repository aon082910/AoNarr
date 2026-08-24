import crypto from "node:crypto";
import { Router } from "express";
import { db } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

/** Admin-only: create/list/revoke share links for a media item. Mounted at /api/media. */
export const shareLinksRouter = Router();
shareLinksRouter.use(requireAdmin);

shareLinksRouter.get(
  "/:id/share",
  asyncHandler(async (req, res) => {
    res.json(await db.prepare("SELECT * FROM share_links WHERE media_item_id = ? ORDER BY created_at DESC").all(req.params.id));
  })
);

shareLinksRouter.post(
  "/:id/share",
  asyncHandler(async (req, res) => {
    const item = await db.prepare("SELECT id FROM media_items WHERE id = ?").get(req.params.id);
    if (!item) throw new HttpError(404, "Media item not found");

    const token = crypto.randomBytes(16).toString("hex");
    const expiresInDays: number | undefined = req.body?.expiresInDays;
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    await db
      .prepare("INSERT INTO share_links (token, media_item_id, expires_at) VALUES (?, ?, ?)")
      .run(token, req.params.id, expiresAt);
    res.status(201).json({ token, expiresAt });
  })
);

shareLinksRouter.delete(
  "/:id/share/:linkId",
  asyncHandler(async (req, res) => {
    await db.prepare("DELETE FROM share_links WHERE id = ? AND media_item_id = ?").run(req.params.linkId, req.params.id);
    res.status(204).send();
  })
);

/** Fully public — no auth, no rate-limit-shared credentials. Mounted at /api/share. */
export const shareLinksPublicRouter = Router();

shareLinksPublicRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const link = (await db.prepare("SELECT * FROM share_links WHERE token = ?").get(req.params.token)) as
      | { media_item_id: number; expires_at: string | null }
      | undefined;
    if (!link) throw new HttpError(404, "This share link doesn't exist or was revoked");
    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      throw new HttpError(404, "This share link has expired");
    }

    const item = await db
      .prepare("SELECT type, title, year, overview, poster_url, status FROM media_items WHERE id = ?")
      .get(link.media_item_id);
    if (!item) throw new HttpError(404, "The shared item no longer exists");
    res.json(item);
  })
);
