import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { downloadClientFromRow, historyEventFromRow, mediaItemFromRow, queueItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getDownloadClientAdapter } from "../services/downloadClient.js";
import { importQueueItem, listDownloadedFileCandidates } from "../services/importer.js";
import { notifyQueueChanged, registerQueueStreamClient, unregisterQueueStreamClient } from "../services/realtime.js";

export const activityRouter = Router();
activityRouter.use(requireAdmin);

activityRouter.get(
  "/queue",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM queue ORDER BY added_at DESC").all();
    res.json(rows.map(queueItemFromRow));
  })
);

/**
 * Server-Sent Events channel for live queue updates (see services/realtime.ts) — the Activity page
 * opens this once and re-fetches GET /queue whenever a "queue" event arrives, instead of polling on
 * a fixed timer. Auth goes through the same requireAuth middleware as every other /api route (an
 * EventSource can't set the X-Api-Key header, so the browser client passes it as `?apikey=`, which
 * requireAuth already accepts as a fallback for exactly this kind of case).
 */
activityRouter.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  registerQueueStreamClient(res);

  // Keeps the connection from being silently dropped by an idle-timeout proxy between the browser
  // and this server (nginx in the :web/:combined images, or a reverse proxy on Unraid).
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 30_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unregisterQueueStreamClient(res);
  });
});

activityRouter.delete(
  "/queue/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM queue WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Queue item not found");
    notifyQueueChanged();
    res.status(204).send();
  })
);

/**
 * Not every download client backend has a real queue to reorder — the in-process http/ytdlp
 * adapters download sequentially with nothing to prioritize — so this 400s cleanly instead of
 * silently no-op'ing when the underlying client type doesn't implement `setPriority`.
 */
activityRouter.post(
  "/queue/:id/priority",
  asyncHandler(async (req, res) => {
    const priority = req.body?.priority === "top" ? "top" : "normal";
    const queueRow = (await db.prepare("SELECT * FROM queue WHERE id = ?").get(req.params.id)) as any;
    if (!queueRow) throw new HttpError(404, "Queue item not found");
    if (!queueRow.download_client_id || !queueRow.download_id) {
      throw new HttpError(400, "This queue item has no associated download client");
    }
    const clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(queueRow.download_client_id);
    if (!clientRow) throw new HttpError(404, "Download client not found");
    const client = downloadClientFromRow(clientRow) as any;

    const adapter = getDownloadClientAdapter(client.type);
    if (!adapter.setPriority) {
      throw new HttpError(400, `Reordering isn't supported for "${client.type}" download clients`);
    }
    await adapter.setPriority(client, queueRow.download_id, priority);
    notifyQueueChanged();
    res.json({ ok: true });
  })
);

/** Re-runs the automatic importer against a queue item — for a "completed" or "failed" row whose
 * file wasn't found or matched the first time (e.g. it finished extracting/repairing moments after
 * AoNarr gave up, or a transient filesystem hiccup) but should resolve cleanly now without needing
 * the admin to pick a file by hand. */
activityRouter.post(
  "/queue/:id/retry-import",
  asyncHandler(async (req, res) => {
    const queueRow = await db.prepare("SELECT * FROM queue WHERE id = ?").get(req.params.id);
    if (!queueRow) throw new HttpError(404, "Queue item not found");
    try {
      await importQueueItem(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      throw new HttpError(422, (err as Error).message);
    }
  })
);

/** Lists files in the downloads directory that could plausibly be this queue item's download, for
 * the Activity page's "Manual import..." picker — same extension universe the automatic matcher
 * searches, just without its fuzzy-match score cutoff, since the admin is choosing by eye. */
activityRouter.get(
  "/queue/:id/import-candidates",
  asyncHandler(async (req, res) => {
    const queueRow = (await db.prepare("SELECT * FROM queue WHERE id = ?").get(req.params.id)) as any;
    if (!queueRow) throw new HttpError(404, "Queue item not found");
    const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(queueRow.media_item_id);
    if (!mediaRow) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(mediaRow);
    res.json(listDownloadedFileCandidates(item.type));
  })
);

/** Imports a queue item using an explicit file path the admin picked, bypassing the automatic
 * fuzzy title match entirely — the escape hatch for when it can't find or misidentifies the file
 * on its own. */
activityRouter.post(
  "/queue/:id/manual-import",
  asyncHandler(async (req, res) => {
    const sourceFile = req.body?.sourceFile;
    if (!sourceFile || typeof sourceFile !== "string") throw new HttpError(400, "sourceFile is required");
    const queueRow = await db.prepare("SELECT * FROM queue WHERE id = ?").get(req.params.id);
    if (!queueRow) throw new HttpError(404, "Queue item not found");
    try {
      await importQueueItem(Number(req.params.id), sourceFile);
      res.json({ ok: true });
    } catch (err) {
      throw new HttpError(422, (err as Error).message);
    }
  })
);

activityRouter.get(
  "/history",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM history ORDER BY created_at DESC LIMIT 200").all();
    res.json(rows.map(historyEventFromRow));
  })
);

interface TimelineEntry {
  timestamp: string;
  type: string;
  title: string;
  detail: string | null;
}

/**
 * One merged, chronological feed across everything that happens in the library — grabs,
 * imports, failures, auto-archival, and request submissions/approvals/rejections — instead of
 * checking Activity, Requests, and System separately to piece together "what happened recently."
 */
activityRouter.get(
  "/timeline",
  asyncHandler(async (_req, res) => {
    const historyRows = (await db
      .prepare(
        `SELECT h.event_type AS "eventType", h.data, h.created_at AS "createdAt", m.title AS "mediaTitle"
         FROM history h JOIN media_items m ON m.id = h.media_item_id
         ORDER BY h.created_at DESC LIMIT 150`
      )
      .all()) as { eventType: string; data: string | null; createdAt: string; mediaTitle: string }[];

    const entries: TimelineEntry[] = historyRows.map((row) => {
      let detail: string | null = null;
      try {
        const parsed = row.data ? JSON.parse(row.data) : null;
        detail = parsed?.title ?? parsed?.fileName ?? parsed?.reason ?? null;
      } catch {
        detail = null;
      }
      return { timestamp: row.createdAt, type: row.eventType, title: row.mediaTitle, detail };
    });

    const requestRows = (await db.prepare(`SELECT * FROM requests ORDER BY created_at DESC LIMIT 150`).all()) as any[];
    for (const r of requestRows) {
      entries.push({ timestamp: r.created_at, type: "requested", title: r.title, detail: null });
      if (r.resolved_at && r.status !== "pending") {
        entries.push({
          timestamp: r.resolved_at,
          type: r.status === "approved" ? "request_approved" : "request_rejected",
          title: r.title,
          detail: null,
        });
      }
    }

    entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    res.json(entries.slice(0, 200));
  })
);
