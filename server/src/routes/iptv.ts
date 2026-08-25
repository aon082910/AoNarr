import crypto from "node:crypto";
import { Router } from "express";
import { db } from "../db/index.js";
import { iptvPlaylistFromRow, iptvPlaylistItemFromRow, iptvFillerClipFromRow } from "../db/mappers.js";
import { requireAdmin, safeEqual } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getSetting, setSetting } from "../services/settingsStore.js";
import { streamFileWithRangeSupport } from "../services/rangeStream.js";

function ensureIptvToken(): string {
  let token = getSetting("iptvPlaylistToken");
  if (!token) {
    token = crypto.randomBytes(20).toString("hex");
    setSetting("iptvPlaylistToken", token);
  }
  return token;
}

/** Admin-only management — mounted at /api/iptv. */
export const iptvRouter = Router();
iptvRouter.use(requireAdmin);

iptvRouter.get(
  "/token",
  asyncHandler(async (_req, res) => {
    res.json({ token: ensureIptvToken() });
  })
);

iptvRouter.post(
  "/token/regenerate",
  asyncHandler(async (_req, res) => {
    const token = crypto.randomBytes(20).toString("hex");
    setSetting("iptvPlaylistToken", token);
    res.json({ token });
  })
);

iptvRouter.get(
  "/playlists",
  asyncHandler(async (_req, res) => {
    const rows = (await db.prepare("SELECT * FROM iptv_playlists ORDER BY name").all()) as any[];
    const playlists = await Promise.all(
      rows.map(async (row) => {
        const count = (await db.prepare("SELECT COUNT(*) AS c FROM iptv_playlist_items WHERE playlist_id = ?").get(row.id)) as {
          c: number;
        };
        return { ...iptvPlaylistFromRow(row), itemCount: count.c };
      })
    );
    res.json(playlists);
  })
);

iptvRouter.post(
  "/playlists",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name) throw new HttpError(400, "name is required");
    const result = await db
      .prepare(`INSERT INTO iptv_playlists (name, enabled, insert_after_minutes, insert_after_each_item) VALUES (?, ?, ?, ?)`)
      .run(b.name, b.enabled ?? 1, b.insertAfterMinutes ?? null, b.insertAfterEachItem ? 1 : 0);
    const row = await db.prepare("SELECT * FROM iptv_playlists WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(iptvPlaylistFromRow(row));
  })
);

iptvRouter.patch(
  "/playlists/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const map: Record<string, string> = {
      name: "name",
      enabled: "enabled",
      insertAfterMinutes: "insert_after_minutes",
      insertAfterEachItem: "insert_after_each_item",
    };
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, col] of Object.entries(map)) {
      if (b[key] === undefined) continue;
      sets.push(`${col} = ?`);
      values.push(key === "insertAfterEachItem" ? (b[key] ? 1 : 0) : b[key]);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE iptv_playlists SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM iptv_playlists WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Playlist not found");
    res.json(iptvPlaylistFromRow(row));
  })
);

iptvRouter.delete(
  "/playlists/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM iptv_playlists WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Playlist not found");
    res.status(204).send();
  })
);

iptvRouter.get(
  "/playlists/:id/items",
  asyncHandler(async (req, res) => {
    const rows = await db.prepare("SELECT * FROM iptv_playlist_items WHERE playlist_id = ? ORDER BY position").all(req.params.id);
    res.json(rows.map(iptvPlaylistItemFromRow));
  })
);

iptvRouter.post(
  "/playlists/:id/items",
  asyncHandler(async (req, res) => {
    const playlist = await db.prepare("SELECT id FROM iptv_playlists WHERE id = ?").get(req.params.id);
    if (!playlist) throw new HttpError(404, "Playlist not found");

    const b = req.body ?? {};
    if (!b.title) throw new HttpError(400, "title is required");
    if (!b.externalUrl && !b.mediaItemId && !b.episodeId) {
      throw new HttpError(400, "One of externalUrl, mediaItemId or episodeId is required");
    }
    const maxPos = (await db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM iptv_playlist_items WHERE playlist_id = ?").get(req.params.id)) as {
      p: number;
    };

    const result = await db
      .prepare(
        `INSERT INTO iptv_playlist_items (playlist_id, position, title, external_url, media_item_id, episode_id, duration_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(req.params.id, maxPos.p + 1, b.title, b.externalUrl || null, b.mediaItemId || null, b.episodeId || null, b.durationSeconds ?? null);
    const row = await db.prepare("SELECT * FROM iptv_playlist_items WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(iptvPlaylistItemFromRow(row));
  })
);

/** Swaps this item's position with its immediate neighbor — same "Up"/"Down" pattern the Quality
 * Definitions reordering already uses, rather than a full drag-and-drop reorder API. */
iptvRouter.post(
  "/playlists/:id/items/:itemId/move",
  asyncHandler(async (req, res) => {
    const direction = req.body?.direction === "up" ? -1 : 1;
    const items = (await db.prepare("SELECT * FROM iptv_playlist_items WHERE playlist_id = ? ORDER BY position").all(req.params.id)) as any[];
    const idx = items.findIndex((i) => String(i.id) === req.params.itemId);
    if (idx === -1) throw new HttpError(404, "Item not found");
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= items.length) {
      res.json(items.map(iptvPlaylistItemFromRow));
      return;
    }
    const a = items[idx];
    const b = items[swapIdx];
    await db.prepare("UPDATE iptv_playlist_items SET position = ? WHERE id = ?").run(b.position, a.id);
    await db.prepare("UPDATE iptv_playlist_items SET position = ? WHERE id = ?").run(a.position, b.id);
    const updated = await db.prepare("SELECT * FROM iptv_playlist_items WHERE playlist_id = ? ORDER BY position").all(req.params.id);
    res.json(updated.map(iptvPlaylistItemFromRow));
  })
);

iptvRouter.delete(
  "/playlists/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM iptv_playlist_items WHERE id = ? AND playlist_id = ?").run(req.params.itemId, req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Item not found");
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// Filler clips — a reusable library any playlist can attach from and rotate through, instead of
// each playlist only ever pointing at one fixed URL. Always a plain admin-supplied URL — same
// reasoning as the schema comment on iptv_playlists.
// ---------------------------------------------------------------------------

iptvRouter.get(
  "/filler-clips",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM iptv_filler_clips ORDER BY name").all();
    res.json(rows.map(iptvFillerClipFromRow));
  })
);

iptvRouter.post(
  "/filler-clips",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.url) throw new HttpError(400, "name and url are required");
    const result = await db
      .prepare("INSERT INTO iptv_filler_clips (name, url, category, enabled) VALUES (?, ?, ?, ?)")
      .run(b.name, b.url, b.category || null, b.enabled ?? 1);
    const row = await db.prepare("SELECT * FROM iptv_filler_clips WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(iptvFillerClipFromRow(row));
  })
);

iptvRouter.patch(
  "/filler-clips/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const map: Record<string, string> = { name: "name", url: "url", category: "category", enabled: "enabled" };
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, col] of Object.entries(map)) {
      if (b[key] === undefined) continue;
      sets.push(`${col} = ?`);
      values.push(b[key]);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE iptv_filler_clips SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM iptv_filler_clips WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Filler clip not found");
    res.json(iptvFillerClipFromRow(row));
  })
);

iptvRouter.delete(
  "/filler-clips/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM iptv_filler_clips WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Filler clip not found");
    res.status(204).send();
  })
);

/** Which filler clips a playlist rotates through, in order — a clip can be attached to any number
 * of playlists (it's a shared library, not owned by one). */
iptvRouter.get(
  "/playlists/:id/fillers",
  asyncHandler(async (req, res) => {
    const rows = (await db
      .prepare(
        `SELECT f.id AS filler_id, f.name, f.url, f.category, pf.id AS attachment_id, pf.position
         FROM iptv_playlist_fillers pf JOIN iptv_filler_clips f ON f.id = pf.filler_clip_id
         WHERE pf.playlist_id = ? ORDER BY pf.position`
      )
      .all(req.params.id)) as any[];
    res.json(
      rows.map((r) => ({ attachmentId: r.attachment_id, fillerClipId: r.filler_id, name: r.name, url: r.url, category: r.category, position: r.position }))
    );
  })
);

iptvRouter.post(
  "/playlists/:id/fillers",
  asyncHandler(async (req, res) => {
    const playlist = await db.prepare("SELECT id FROM iptv_playlists WHERE id = ?").get(req.params.id);
    if (!playlist) throw new HttpError(404, "Playlist not found");
    const fillerClipId = req.body?.fillerClipId;
    if (!fillerClipId) throw new HttpError(400, "fillerClipId is required");
    const clip = await db.prepare("SELECT id FROM iptv_filler_clips WHERE id = ?").get(fillerClipId);
    if (!clip) throw new HttpError(404, "Filler clip not found");

    const maxPos = (await db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM iptv_playlist_fillers WHERE playlist_id = ?").get(req.params.id)) as {
      p: number;
    };
    await db
      .prepare("INSERT INTO iptv_playlist_fillers (playlist_id, filler_clip_id, position) VALUES (?, ?, ?)")
      .run(req.params.id, fillerClipId, maxPos.p + 1);
    res.status(201).json({ ok: true });
  })
);

iptvRouter.delete(
  "/playlists/:id/fillers/:attachmentId",
  asyncHandler(async (req, res) => {
    const result = await db
      .prepare("DELETE FROM iptv_playlist_fillers WHERE id = ? AND playlist_id = ?")
      .run(req.params.attachmentId, req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Attachment not found");
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// Public, token-gated — mounted separately at /api/iptv (no requireAuth; see middleware/auth.ts's
// explicit /iptv/m3u/ and /iptv/stream/ exemptions, the same pattern the .ics calendar feed uses).
// ---------------------------------------------------------------------------

export const iptvPublicRouter = Router();

function checkToken(req: any): void {
  const token = req.query.token as string | undefined;
  const expected = getSetting("iptvPlaylistToken");
  if (!expected || !token || !safeEqual(token, expected)) throw new HttpError(401, "Invalid or missing playlist token");
}

/** Builds the #EXTINF/URL pair for one item, interleaving a filler clip — rotating round-robin
 * through whichever clips are attached to this playlist (see iptv_playlist_fillers) each time an
 * insertion point is hit, instead of always the same one. See the schema comment on
 * iptv_playlists for why a filler clip is always a plain admin-supplied URL, never anything AoNarr
 * sources on its own. No clips attached means no filler is ever inserted, regardless of the
 * insert-after settings. */
function buildM3u(playlist: any, items: any[], fillers: { url: string; name: string }[], origin: string, token: string): string {
  const lines = ["#EXTM3U"];
  let minutesAccumulator = 0;
  let fillerIndex = 0;

  function pushItem(title: string, url: string, durationSeconds: number | null) {
    lines.push(`#EXTINF:${durationSeconds ?? -1},${title.replace(/[\r\n]/g, " ")}`);
    lines.push(url);
  }

  function pushNextFiller() {
    if (fillers.length === 0) return;
    const clip = fillers[fillerIndex % fillers.length];
    fillerIndex++;
    pushItem(clip.name, clip.url, null);
  }

  for (const item of items) {
    const url = item.external_url
      ? item.external_url
      : item.media_item_id
      ? `${origin}/api/iptv/stream/media/${item.media_item_id}?token=${token}`
      : `${origin}/api/iptv/stream/episode/${item.episode_id}?token=${token}`;
    pushItem(item.title, url, item.duration_seconds);

    if (playlist.insert_after_each_item) {
      pushNextFiller();
    } else if (playlist.insert_after_minutes) {
      minutesAccumulator += item.duration_seconds ?? 0;
      if (minutesAccumulator >= playlist.insert_after_minutes * 60) {
        pushNextFiller();
        minutesAccumulator = 0;
      }
    }
  }
  return lines.join("\n") + "\n";
}

iptvPublicRouter.get(
  "/m3u/:playlistId",
  asyncHandler(async (req, res) => {
    checkToken(req);
    const playlist = (await db.prepare("SELECT * FROM iptv_playlists WHERE id = ?").get(req.params.playlistId)) as any;
    if (!playlist) throw new HttpError(404, "Playlist not found");
    if (!playlist.enabled) throw new HttpError(404, "This playlist is disabled");

    const items = await db.prepare("SELECT * FROM iptv_playlist_items WHERE playlist_id = ? ORDER BY position").all(req.params.playlistId);
    const fillers = (await db
      .prepare(
        `SELECT f.name, f.url FROM iptv_playlist_fillers pf JOIN iptv_filler_clips f ON f.id = pf.filler_clip_id
         WHERE pf.playlist_id = ? AND f.enabled = 1 ORDER BY pf.position`
      )
      .all(req.params.playlistId)) as { name: string; url: string }[];
    // req.protocol/req.get("host") reflect what nginx's proxy_set_header actually forwards, which
    // is just the bare hostname with no port (nginx's $host variable drops it) — wrong for AoNarr's
    // typical non-default port. Settings → General's "External URL" exists precisely for "a link
    // back to itself from somewhere other than the browser" (this endpoint is fetched by the media
    // server, never by a browser with its own window.location to fall back on) — prefer it, and
    // only fall back to the possibly-portless proxy guess when it's unset.
    const origin = getSetting("externalUrl") || `${req.protocol}://${req.get("host")}`;
    const m3u = buildM3u(playlist, items, fillers, origin, req.query.token as string);

    res.set("Content-Type", "audio/x-mpegurl");
    res.send(m3u);
  })
);

iptvPublicRouter.get(
  "/stream/:kind/:id",
  asyncHandler(async (req, res) => {
    checkToken(req);
    const { kind, id } = req.params;
    if (kind !== "media" && kind !== "episode") throw new HttpError(400, "Unknown stream kind");

    const row =
      kind === "media"
        ? ((await db.prepare("SELECT path AS file_path FROM media_items WHERE id = ?").get(id)) as any)
        : ((await db.prepare("SELECT file_path FROM episodes WHERE id = ?").get(id)) as any);
    if (!row?.file_path) throw new HttpError(404, "No file for this item");

    streamFileWithRangeSupport(req, res, row.file_path);
  })
);
