import express, { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { db } from "../db/client.js";
import { config } from "../config.js";
import { indexerFromRow, rootFolderFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { checkIndexerHealth } from "../services/indexerClient.js";
import { runAutoArchival } from "../services/archival.js";
import { runTraktSync } from "../services/traktSync.js";
import { findRepeatedImports } from "../services/duplicates.js";
import { findUpgradeCandidates } from "../services/upgradeCandidates.js";
import { getStorageForecast, recordDiskUsageSamples } from "../services/storageForecast.js";
import { getMediaTypeConfig } from "../services/mediaTypes.js";
import { getRecentLogs } from "../services/logger.js";
import { findDuplicateFiles, findUnmonitoredNoFile } from "../services/cleanupSuggestions.js";
import { listReleaseGroupStats } from "../services/releaseGroupStats.js";
import { findLibraryMismatches } from "../services/libraryValidation.js";
import { getMediaServerConfig } from "../services/mediaServer.js";

export const systemRouter = Router();
systemRouter.use(requireAdmin);

systemRouter.get(
  "/logs",
  asyncHandler(async (_req, res) => {
    res.json(getRecentLogs());
  })
);

const APP_VERSION = "0.1.0";

systemRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const counts = db.prepare("SELECT type, COUNT(*) as count FROM media_items GROUP BY type").all() as {
      type: string;
      count: number;
    }[];
    const libraryCounts: Record<string, number> = { movie: 0, series: 0, artist: 0, author: 0 };
    for (const c of counts) libraryCounts[c.type] = c.count;

    const queueCount = (
      db.prepare("SELECT COUNT(*) as c FROM queue WHERE status IN ('queued','downloading')").get() as {
        c: number;
      }
    ).c;

    const indexerCount = (db.prepare("SELECT COUNT(*) as c FROM indexers WHERE enabled = 1").get() as { c: number })
      .c;
    const downloadClientCount = (
      db.prepare("SELECT COUNT(*) as c FROM download_clients WHERE enabled = 1").get() as { c: number }
    ).c;

    recordDiskUsageSamples();

    const folders = (db.prepare("SELECT * FROM root_folders").all() as any[]).map(rootFolderFromRow);
    const diskSpace = folders.map((f) => {
      const forecast = getStorageForecast(f.id);
      try {
        const stat = fs.statfsSync(f.path);
        return {
          path: f.path,
          mediaType: f.mediaType,
          freeBytes: stat.bfree * stat.bsize,
          totalBytes: stat.blocks * stat.bsize,
          daysUntilFull: forecast?.daysUntilFull ?? null,
        };
      } catch {
        return { path: f.path, mediaType: f.mediaType, freeBytes: null, totalBytes: null, daysUntilFull: null };
      }
    });

    res.json({
      version: APP_VERSION,
      nodeVersion: process.version,
      platform: os.platform(),
      uptimeSeconds: Math.round(process.uptime()),
      libraryCounts,
      queueCount,
      indexerCount,
      downloadClientCount,
      diskSpace,
    });
  })
);

const STUCK_QUEUE_HOURS = 6;

/**
 * A one-stop health view combining what every individual *Starr app can only tell you about
 * itself: indexer reachability, queue items stuck longer than expected, and pending requests.
 */
systemRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const indexers = (db.prepare("SELECT * FROM indexers WHERE enabled = 1").all() as any[]).map(indexerFromRow);
    const indexerHealth = await Promise.all(
      indexers.map(async (idx) => ({ id: idx.id, name: idx.name, ...(await checkIndexerHealth(idx)) }))
    );

    const stuckQueueRows = db
      .prepare(
        `SELECT q.id, q.title, q.status, q.added_at AS addedAt, m.title AS mediaTitle FROM queue q
         JOIN media_items m ON m.id = q.media_item_id
         WHERE q.status IN ('queued','downloading')
         AND q.added_at <= datetime('now', ?)`
      )
      .all(`-${STUCK_QUEUE_HOURS} hours`) as any[];

    const pendingRequests = (
      db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get() as { c: number }
    ).c;

    const repeatedImports = findRepeatedImports();
    const upgradeCandidates = findUpgradeCandidates();

    res.json({
      indexers: indexerHealth,
      stuckQueue: stuckQueueRows,
      stuckQueueThresholdHours: STUCK_QUEUE_HOURS,
      pendingRequests,
      repeatedImports,
      upgradeCandidates,
    });
  })
);

systemRouter.post(
  "/archival/run",
  asyncHandler(async (_req, res) => {
    await runAutoArchival();
    res.json({ ran: true });
  })
);

systemRouter.post(
  "/trakt-sync/run",
  asyncHandler(async (_req, res) => {
    res.json(await runTraktSync());
  })
);

/**
 * Opt-in (never runs automatically): walks every root folder and reports files that don't match
 * any has_file path/file_path in the database — leftovers from manual deletes, failed cleanups, etc.
 *
 * Incremental by default: a directory whose mtime is older than that root folder's last scan
 * can't have gained or lost a file since then (adding/removing an entry bumps a directory's
 * mtime on every filesystem AoNarr targets), so its subtree is skipped entirely — this makes
 * repeat scans of a large, mostly-static library fast. Pass `?full=1` to force a complete walk
 * (e.g. after moving files around externally in a way that might not have touched every parent
 * directory's mtime, or just to get a complete current list rather than "what's new").
 */
systemRouter.get(
  "/orphaned-scan",
  asyncHandler(async (req, res) => {
    const full = req.query.full === "1";
    const folders = (db.prepare("SELECT * FROM root_folders").all() as any[]).map(rootFolderFromRow);
    const knownPaths = new Set<string>([
      ...(db.prepare("SELECT path FROM media_items WHERE path IS NOT NULL").all() as { path: string }[]).map(
        (r) => r.path
      ),
      ...(db.prepare("SELECT file_path FROM episodes WHERE file_path IS NOT NULL").all() as { file_path: string }[]).map(
        (r) => r.file_path
      ),
      ...(db.prepare("SELECT file_path FROM sub_items WHERE file_path IS NOT NULL").all() as { file_path: string }[]).map(
        (r) => r.file_path
      ),
    ]);

    const scanStartedAt = new Date().toISOString();
    const orphaned: { path: string; sizeBytes: number }[] = [];
    let skippedDirs = 0;

    for (const folder of folders) {
      const extensions = getMediaTypeConfig(folder.mediaType).extensions;
      const since = !full && folder.lastScannedAt ? new Date(folder.lastScannedAt).getTime() : null;

      const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }

        // A directory's mtime only reflects changes to its own immediate children (an entry
        // added/removed directly inside it) — never to grandchildren — so an unchanged mtime
        // means it's safe to skip re-checking *this directory's own files* for orphans, but
        // subdirectories must still be visited regardless, since any of them could have changed
        // internally without touching this directory's own mtime at all.
        let scanOwnFiles = true;
        if (since !== null) {
          try {
            scanOwnFiles = fs.statSync(dir).mtimeMs > since;
          } catch {
            scanOwnFiles = false;
          }
          if (!scanOwnFiles) skippedDirs++;
        }

        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (
            scanOwnFiles &&
            extensions.includes(path.extname(entry.name).toLowerCase()) &&
            !knownPaths.has(full)
          ) {
            try {
              orphaned.push({ path: full, sizeBytes: fs.statSync(full).size });
            } catch {
              orphaned.push({ path: full, sizeBytes: 0 });
            }
          }
        }
      };
      walk(folder.path);
      db.prepare("UPDATE root_folders SET last_scanned_at = ? WHERE id = ?").run(scanStartedAt, folder.id);
    }

    res.json({ orphaned, incremental: !full, skippedDirs });
  })
);

/** Unmonitored library items with no downloaded file — safe to bulk-delete, since nothing on
 * disk references them. */
systemRouter.get(
  "/cleanup/unmonitored",
  asyncHandler(async (_req, res) => {
    res.json(findUnmonitoredNoFile());
  })
);

/** Files that are very likely byte-identical across different library entries (same size +
 * matching partial hash) — usually a stale re-import. On-demand only; can be slow on a large
 * library since it stats/reads every file with a hasFile row. */
systemRouter.get(
  "/cleanup/duplicate-files",
  asyncHandler(async (_req, res) => {
    res.json(findDuplicateFiles());
  })
);

/** Per-release-group grab success/failure history — used internally to break ties between
 * equally-scored search results, surfaced here so an admin can see which groups are actually
 * reliable in practice. */
systemRouter.get(
  "/release-group-stats",
  asyncHandler(async (_req, res) => {
    res.json(listReleaseGroupStats());
  })
);

/**
 * Compares AoNarr's own movie/episode library against what the configured media server actually
 * reports having, flagging anything AoNarr thinks exists but the media server doesn't see. Needs a
 * media server configured (Settings → Watch-status Auto-Archival); returns a clear error otherwise
 * rather than an empty "all good" result.
 */
systemRouter.get(
  "/library-validation",
  asyncHandler(async (_req, res) => {
    if (!getMediaServerConfig()) {
      throw new HttpError(400, "No media server is configured — set one up in Settings first");
    }
    const mismatches = await findLibraryMismatches();
    res.json(mismatches);
  })
);

const SQLITE_MAGIC = "SQLite format 3\0";

/** Streams a consistent snapshot of the live DB — safe to take mid-write since better-sqlite3's
 * backup() uses SQLite's own online backup API rather than copying the file bytes directly. */
systemRouter.get(
  "/backup",
  asyncHandler(async (_req, res) => {
    const tmpFile = path.join(os.tmpdir(), `aonarr-backup-${Date.now()}.db`);
    await db.backup(tmpFile);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.download(tmpFile, `aonarr-backup-${stamp}.db`, (err) => {
      fs.unlink(tmpFile, () => {});
      if (err && !res.headersSent) throw err;
    });
  })
);

/**
 * Restoring means replacing the live DB file out from under a running process, which is only
 * safe if we stop touching it first — so this checkpoints + closes the connection, swaps the
 * file, and exits; the container's restart policy (`unless-stopped`) brings it back up against
 * the restored file. The previous DB is kept alongside as a `.pre-restore` copy just in case.
 */
systemRouter.post(
  "/backup/restore",
  express.raw({ type: "*/*", limit: "1gb" }),
  asyncHandler(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < SQLITE_MAGIC.length) {
      throw new HttpError(400, "Uploaded file is empty or not a valid SQLite database");
    }
    if (body.toString("utf-8", 0, SQLITE_MAGIC.length) !== SQLITE_MAGIC) {
      throw new HttpError(400, "Uploaded file is not a valid SQLite database");
    }

    const preRestorePath = `${config.dbPath}.pre-restore`;
    fs.copyFileSync(config.dbPath, preRestorePath);

    res.json({ restored: true, message: "Restoring — the app will restart momentarily." });

    setTimeout(() => {
      db.close();
      fs.writeFileSync(config.dbPath, body);
      for (const suffix of ["-wal", "-shm"]) {
        try {
          fs.unlinkSync(config.dbPath + suffix);
        } catch {
          // no journal file to clean up, that's fine
        }
      }
      process.exit(0);
    }, 250);
  })
);
