import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { downloadClientFromRow, mediaItemFromRow, queueItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getDownloadClientAdapter, removeQueueItemDownload, withQueueImportLock } from "../services/downloadClient.js";
import { importQueueItem, listDownloadedFileCandidates } from "../services/importer.js";
import { isJobRunning, listJobs } from "../services/jobRegistry.js";
import { clampLimit, clampOffset } from "../services/mediaQuery.js";
import { notifyQueueChanged, registerQueueStreamClient, unregisterQueueStreamClient } from "../services/realtime.js";
import { markQueueImportFailed, markQueueImportStarted } from "../services/scheduler.js";
import { getSetting } from "../services/settingsStore.js";

export const activityRouter = Router();
activityRouter.use(requireAdmin);

activityRouter.get(
  "/queue",
  asyncHandler(async (req, res) => {
    const limit = clampLimit(req.query.limit, 60, 500);
    const offset = clampOffset(req.query.offset);
    const total = ((await db.prepare("SELECT COUNT(*) AS c FROM queue").get()) as { c: number }).c;
    // id breaks added_at ties (one-second resolution, so a bulk search adds many rows per second):
    // Postgres orders tied rows differently from one page request to the next.
    const rows = await db.prepare("SELECT * FROM queue ORDER BY added_at DESC, id DESC LIMIT ? OFFSET ?").all(limit, offset);
    res.json({ items: rows.map(queueItemFromRow), total: Number(total) });
  })
);

/**
 * Server-Sent Events channel for live queue updates (see services/realtime.ts) — the Activity page
 * opens this once and re-fetches GET /queue whenever a "queue" event arrives, instead of polling on
 * a fixed timer. Auth goes through the same requireAuth middleware as every other /api route — an
 * EventSource can't set the X-Api-Key/X-Session-Token headers, so the browser opens it with a
 * single-use `?ticket=` from POST /api/auth/stream-ticket, and requireAuth drops the connection once
 * the credential behind it is revoked (see middleware/auth.ts).
 */
activityRouter.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // An nginx-based reverse proxy of the user's own (SWAG, Nginx Proxy Manager) buffers the stream otherwise.
    "X-Accel-Buffering": "no",
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

interface QueueRowTiming {
  status: string;
  updated_at: string;
  /** The database's own clock, read in the same query as updated_at. */
  db_now: string;
}

const POLL_TIMESTAMP_MARGIN_MS = 2000;

function parseDbTimestamp(value: string): number {
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : `${iso}Z`);
}

/**
 * The queue poller marks a row completed and imports it inline in the same run (or marks it failed
 * and grabs a replacement) without taking the per-row import lock, so a row it moved during its
 * current run may still be in its hands. Rows it hasn't touched this run are idle, however long the
 * run takes. Compared on the database's clock (how long ago the row changed vs. how long the run has
 * been going), since a Postgres server's clock needn't match this process's; the margin covers
 * updated_at's one-second resolution.
 */
function pollerMayOwnQueueRow(row: QueueRowTiming): boolean {
  if (row.status !== "completed" && row.status !== "failed") return false;
  if (!isJobRunning("queuePoll")) return false;
  const startedAt = listJobs().find((job) => job.key === "queuePoll")?.startedAt;
  const runningForMs = startedAt ? Date.now() - Date.parse(startedAt) : NaN;
  const sinceUpdateMs = parseDbTimestamp(row.db_now) - parseDbTimestamp(row.updated_at);
  if (!Number.isFinite(runningForMs) || !Number.isFinite(sinceUpdateMs)) return true;
  return sinceUpdateMs <= runningForMs + POLL_TIMESTAMP_MARGIN_MS;
}

const POLLER_BUSY_MESSAGE = "The queue poller is handling this download — try again in a moment";

/**
 * Radarr/Sonarr-style "Remove and Blocklist" — pass `?blocklist=1` to add the release to this
 * media item's blocklist (see routes/blocklist.ts) in the same call, instead of removing from the
 * queue and blocklisting separately by hand across two pages. Like Radarr/Sonarr, the download is
 * also removed from its client unless `?removeFromClient=0`: left there, it would keep downloading
 * and seeding with nothing left to import or clean it up. Refused (409) while the row is being
 * imported, since the client would delete the files the import is still copying.
 */
activityRouter.delete(
  "/queue/:id",
  asyncHandler(async (req, res) => {
    const queueRow = (await db
      .prepare(`SELECT *, ${nowExpr(db)} AS db_now FROM queue WHERE id = ?`)
      .get(req.params.id)) as any;
    if (!queueRow) throw new HttpError(404, "Queue item not found");
    if (pollerMayOwnQueueRow(queueRow)) throw new HttpError(409, POLLER_BUSY_MESSAGE);

    let rowChanged = false;
    const ran = await withQueueImportLock(Number(queueRow.id), async () => {
      // The row goes first, and only if the poller hasn't moved it since it was read: a row the
      // poller has just marked completed is being imported inline, and once the row is gone the
      // poller's import of it stops before copying anything the client is about to delete.
      const deleted = await db.prepare("DELETE FROM queue WHERE id = ? AND status = ?").run(queueRow.id, queueRow.status);
      if (deleted.changes === 0) {
        rowChanged = true;
        return;
      }

      if (req.query.blocklist === "1") {
        await db
          .prepare("INSERT INTO blocklist (media_item_id, release_title, indexer_id, reason) VALUES (?, ?, ?, ?)")
          .run(queueRow.media_item_id, queueRow.title, queueRow.indexer_id, "Removed from queue by admin");
      }

      if (req.query.removeFromClient !== "0" && queueRow.download_client_id && queueRow.download_id) {
        // Another row can point at the same download (one season pack grabbed for two targets); it
        // still needs that data.
        const sharing = (await db
          .prepare("SELECT COUNT(*) AS c FROM queue WHERE download_client_id = ? AND download_id = ? AND id <> ?")
          .get(queueRow.download_client_id, queueRow.download_id, queueRow.id)) as { c: number | string };
        // Symlinked library files point into the client's data, and files already imported can be
        // links into this very download (the same pack re-added for another target), so only the
        // torrent/job itself goes.
        const deleteData = getSetting("importStrategy") !== "symlink";
        if (Number(sharing.c) === 0) await removeQueueItemDownload(queueItemFromRow(queueRow), deleteData);
      }
    });
    if (!ran) throw new HttpError(409, "This download is being imported — try again once that finishes");
    if (rowChanged) throw new HttpError(409, "This download changed while it was being removed — refresh and try again");
    notifyQueueChanged();
    res.status(204).send();
  })
);

/**
 * Not every download client backend has a real queue to reorder — the in-process http/ytdlp
 * adapters have none (the scheduler just caps how many direct downloads run at once, see
 * MAX_ACTIVE_DIRECT_DOWNLOADS in services/scheduler.ts) — so this 400s cleanly instead of
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

/**
 * Runs an admin-triggered import of a queue row, refusing (409) while anything else may be importing
 * the same row: a second concurrent import races the first on the same source files, and whichever
 * finishes first deletes the row and the client's data while the other is still copying. A queued or
 * downloading row still belongs to the poller, which imports it itself the moment its client reports
 * it complete. The import is marked on the row while it runs, so one a restart cuts off is retried
 * by the poller like its own, except a `manual` one (a file and quality the admin chose), which is
 * left for the admin (see resumeInterruptedImports in services/scheduler.ts).
 */
async function runAdminImport(queueId: number, importFn: () => Promise<void>, manual = false): Promise<void> {
  const queueRow = Number.isInteger(queueId)
    ? ((await db
        .prepare(`SELECT status, updated_at, ${nowExpr(db)} AS db_now FROM queue WHERE id = ?`)
        .get(queueId)) as QueueRowTiming | undefined)
    : undefined;
  if (!queueRow) throw new HttpError(404, "Queue item not found");
  if (queueRow.status === "queued" || queueRow.status === "downloading") {
    throw new HttpError(409, "This download hasn't finished yet");
  }
  if (pollerMayOwnQueueRow(queueRow)) throw new HttpError(409, POLLER_BUSY_MESSAGE);
  let ran: boolean;
  try {
    ran = await withQueueImportLock(queueId, async () => {
      await markQueueImportStarted(queueId, manual);
      try {
        await importFn();
      } catch (err) {
        await markQueueImportFailed(queueId, err);
        throw err;
      }
    });
  } catch (err) {
    throw new HttpError(422, (err as Error).message);
  }
  if (!ran) throw new HttpError(409, "This download is already being imported");
}

/** Re-runs the automatic importer against a queue item — for a "completed" or "failed" row whose
 * file wasn't found or matched the first time (e.g. it finished extracting/repairing moments after
 * AoNarr gave up, or a transient filesystem hiccup) but should resolve cleanly now without needing
 * the admin to pick a file by hand. */
activityRouter.post(
  "/queue/:id/retry-import",
  asyncHandler(async (req, res) => {
    const queueId = Number(req.params.id);
    await runAdminImport(queueId, () => importQueueItem(queueId));
    res.json({ ok: true });
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
    const overrideQuality = typeof req.body?.quality === "string" && req.body.quality ? req.body.quality : undefined;
    const queueId = Number(req.params.id);
    await runAdminImport(queueId, () => importQueueItem(queueId, sourceFile, overrideQuality), true);
    res.json({ ok: true });
  })
);

/** Radarr/Sonarr-style global History page — every grab/import/failure event across the whole
 * library, newest first, filterable by event type/media type/date range. Joins media_items for
 * title/type so the page doesn't need a second round-trip per row; still returns the raw history
 * columns (mediaItemFromRow-style mapping isn't needed here since only title/type are used). */
activityRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    const { eventType, mediaType, since } = req.query as { eventType?: string; mediaType?: string; since?: string };
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (eventType) {
      conditions.push("h.event_type = ?");
      params.push(eventType);
    }
    if (mediaType) {
      conditions.push("m.type = ?");
      params.push(mediaType);
    }
    if (since) {
      conditions.push("h.created_at >= ?");
      params.push(since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = clampLimit(req.query.limit, 60, 500);
    const offset = clampOffset(req.query.offset);

    // Same filter conditions as the main query below — a plain COUNT(*) of the unfiltered table
    // would always report the whole history size regardless of eventType/mediaType/since, so the
    // Pagination control's "Page X of Y (N total)" would be wrong the moment any filter is active.
    const total = (
      (await db
        .prepare(`SELECT COUNT(*) AS c FROM history h JOIN media_items m ON m.id = h.media_item_id ${where}`)
        .get(...params)) as { c: number }
    ).c;

    const rows = (await db
      .prepare(
        `SELECT h.id, h.media_item_id AS "mediaItemId", h.event_type AS "eventType", h.data, h.created_at AS "createdAt",
                m.title AS "mediaTitle", m.type AS "mediaType"
         FROM history h JOIN media_items m ON m.id = h.media_item_id
         ${where}
         ORDER BY h.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)) as any[];
    res.json({ items: rows, total: Number(total) });
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
 *
 * `history` and `requests` are two different tables with no shared sort key, so real offset
 * pagination over their merge fetches the top `offset + limit` rows from EACH source (each already
 * sorted DESC by its own timestamp — that's enough to guarantee the true top `offset + limit` of the
 * merged set), merges + re-sorts just that window, then slices out the requested page. `requests`
 * is ordered by `COALESCE(resolved_at, created_at)`, not just `created_at` — a request contributes
 * a second timeline entry timestamped by the separate, later `resolved_at` column once it's
 * approved/rejected, so an old request resolved moments ago still needs to sort near the top for
 * that entry to make it into the fetched window. `total` is a
 * simple sum of both tables' raw row counts rather than the true merged-entry count (a resolved
 * request contributes two entries — "requested" and "approved"/"rejected" — for one row), which is
 * an accepted approximation rather than a precise count.
 */
activityRouter.get(
  "/timeline",
  asyncHandler(async (req, res) => {
    const limit = clampLimit(req.query.limit, 60, 500);
    const offset = clampOffset(req.query.offset);
    const fetchCount = offset + limit;

    const historyRows = (await db
      .prepare(
        `SELECT h.event_type AS "eventType", h.data, h.created_at AS "createdAt", m.title AS "mediaTitle"
         FROM history h JOIN media_items m ON m.id = h.media_item_id
         ORDER BY h.created_at DESC LIMIT ?`
      )
      .all(fetchCount)) as { eventType: string; data: string | null; createdAt: string; mediaTitle: string }[];

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

    const requestRows = (await db
      .prepare(`SELECT * FROM requests ORDER BY COALESCE(resolved_at, created_at) DESC LIMIT ?`)
      .all(fetchCount)) as any[];
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

    const historyTotal = ((await db.prepare("SELECT COUNT(*) AS c FROM history").get()) as { c: number }).c;
    const requestsTotal = ((await db.prepare("SELECT COUNT(*) AS c FROM requests").get()) as { c: number }).c;
    const total = Number(historyTotal) + Number(requestsTotal);

    res.json({ items: entries.slice(offset, offset + limit), total });
  })
);
