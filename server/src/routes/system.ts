import express, { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { db } from "../db/index.js";
import { nowOffsetHoursExpr } from "../db/asyncDb.js";
// The SQLite restore path below needs the raw better-sqlite3 handle directly (.close(), file-swap)
// — replacing a live SQLite file only works from outside the async wrapper. Everything else in
// this file, including backups on both dialects, uses the async `db`/services/scheduledBackup.ts.
import { db as sqliteDb } from "../db/client.js";
import {
  BACKUP_BUNDLE_EXTENSION,
  writeBackupBundle,
  readBackupBundle,
  looksLikeBackupBundle,
  restorePostgres,
} from "../services/scheduledBackup.js";
import { ENCRYPTION_KEY_PATH, reloadEncryptionKey } from "../services/encryption.js";
import { config } from "../config.js";
import { downloadClientFromRow, indexerFromRow, rootFolderFromRow } from "../db/mappers.js";
import { getDownloadClientAdapter } from "../services/downloadClient.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { checkIndexerHealth } from "../services/indexerClient.js";
import { attachIndexerHealth } from "../services/indexerHealth.js";
import { runAutoArchival, getUpcomingArchivals } from "../services/archival.js";
import { runTraktSync } from "../services/traktSync.js";
import { runPlexWatchlistSync } from "../services/plexWatchlistSync.js";
import { findRepeatedImports } from "../services/duplicates.js";
import { findUpgradeCandidates } from "../services/upgradeCandidates.js";
import { getStorageForecast, recordDiskUsageSamples } from "../services/storageForecast.js";
import { getMediaTypeConfig } from "../services/mediaTypes.js";
import { getRecentLogs, listLogFiles, log, registerLogStreamClient, resolveLogFilePath, unregisterLogStreamClient } from "../services/logger.js";
import { checkForUpdate } from "../services/updateCheck.js";
import { findDuplicateFiles, findUnmonitoredNoFile } from "../services/cleanupSuggestions.js";
import { listReleaseGroupStats } from "../services/releaseGroupStats.js";
import { findLibraryMismatches } from "../services/libraryValidation.js";
import { getMediaServerConfig } from "../services/mediaServer.js";
import { auditActor, logAuditEvent } from "../services/audit.js";

export const systemRouter = Router();
systemRouter.use(requireAdmin);

/** Lists subdirectories of a path for the web UI's folder-picker, instead of typing/pasting a
 * path blind — same idea as every *Starr app's own "Browse for folder." Scoped to whatever the
 * container can already see (its mounted volumes), same as those apps; no extra sandboxing since
 * there's nothing more sensitive reachable here than what's already mounted into the container. */
systemRouter.get(
  "/browse-directory",
  asyncHandler(async (req, res) => {
    const requested = (req.query.path as string | undefined) || "/";
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(requested, { withFileTypes: true });
    } catch (err) {
      throw new HttpError(400, `Can't list "${requested}": ${(err as Error).message}`);
    }

    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const parent = path.dirname(requested);
    res.json({ path: requested, parent: parent === requested ? null : parent, directories });
  })
);

/** Creates a subdirectory under `parent` from the folder-picker itself, instead of requiring one
 * to already exist on disk before it can be picked — mirrors "New folder" in a native file-picker
 * dialog. `name` is a single path segment (no slashes), so this can only create a direct child of
 * a directory the picker already navigated into. */
systemRouter.post(
  "/browse-directory",
  asyncHandler(async (req, res) => {
    const parent = (req.body?.parent as string | undefined) || "";
    const name = (req.body?.name as string | undefined) || "";
    if (!parent) throw new HttpError(400, "parent is required");
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new HttpError(400, "name must be a single folder name with no path separators");
    }
    const target = path.join(parent, name);
    try {
      fs.mkdirSync(target, { recursive: false });
    } catch (err) {
      throw new HttpError(400, `Can't create "${target}": ${(err as Error).message}`);
    }
    res.status(201).json({ path: target });
  })
);

/**
 * Aggregates the bandwidth/queue-throughput information AoNarr actually has — per-client
 * upload/download totals and ratio (only qBittorrent's adapter implements getHealthStats today;
 * others report as unavailable rather than being silently omitted) plus a queue status breakdown.
 * AoNarr doesn't proxy traffic itself, so this is what every download client and the queue
 * self-report, not a packet-level capture.
 */
systemRouter.get(
  "/network-stats",
  asyncHandler(async (_req, res) => {
    const clients = ((await db.prepare("SELECT * FROM download_clients WHERE enabled = 1").all()) as any[]).map(
      downloadClientFromRow
    );
    const clientStats = await Promise.all(
      clients.map(async (client) => {
        const adapter = getDownloadClientAdapter(client.type);
        if (!adapter.getHealthStats) {
          return { id: client.id, name: client.name, type: client.type, available: false };
        }
        try {
          const stats = await adapter.getHealthStats(client);
          return { id: client.id, name: client.name, type: client.type, available: true, ...stats };
        } catch (err) {
          return { id: client.id, name: client.name, type: client.type, available: false, error: (err as Error).message };
        }
      })
    );

    const queueByStatus = ((await db
      .prepare('SELECT status, COUNT(*) AS count, COALESCE(SUM(size), 0) AS "totalBytes" FROM queue GROUP BY status')
      .all()) as { status: string; count: number; totalBytes: number }[]).map((r) => ({
      status: r.status,
      count: Number(r.count),
      totalBytes: Number(r.totalBytes),
    }));

    res.json({ clients: clientStats, queueByStatus });
  })
);

/**
 * Live CPU/memory snapshot — a DUMB (dumbarr.com)-inspired gap: AoNarr tracked disk usage/forecast
 * already but nothing for CPU/RAM. Deliberately its own cheap, DB-free endpoint (just `os` calls)
 * rather than folded into /status, which also runs recordDiskUsageSamples() and root-folder statfs
 * calls — the web UI polls this one on a short interval for a "live" feel without hammering those
 * heavier, DB-writing paths every few seconds.
 */
systemRouter.get(
  "/resources",
  asyncHandler(async (_req, res) => {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    res.json({
      cpuCount: os.cpus().length,
      loadAvg: os.loadavg(), // [1min, 5min, 15min] — always [0,0,0] on Windows, real on Linux/macOS (the only place this actually runs in production)
      memory: {
        totalBytes,
        freeBytes,
        usedBytes: totalBytes - freeBytes,
        usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0,
      },
      process: {
        rssBytes: process.memoryUsage().rss,
        uptimeSeconds: Math.round(process.uptime()),
      },
    });
  })
);

systemRouter.get(
  "/logs",
  asyncHandler(async (req, res) => {
    const level = req.query.level as "info" | "warn" | "error" | undefined;
    const search = req.query.search as string | undefined;
    const since = req.query.since as string | undefined;
    res.json(getRecentLogs({ level, search, since }));
  })
);

/**
 * Server-Sent Events channel for a live-tailing System → Logs page (Radarr/Sonarr-style), pushing
 * every new entry the moment it's logged instead of the page's old load-once/manual-refresh view.
 * Same pattern as activity.ts's own /stream route (see services/realtime.ts) — an EventSource can't
 * set the X-Api-Key/X-Session-Token headers, so requireAuth's `?apikey=`/`?sessionToken=` query
 * fallback carries the credential instead.
 */
systemRouter.get("/logs/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  registerLogStreamClient(res);

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
    unregisterLogStreamClient(res);
  });
});

/** Radarr-style System → Log Files — persistent daily log files on disk (see logger.ts), distinct
 * from the in-memory "recent logs" above which resets on every restart. */
systemRouter.get(
  "/log-files",
  asyncHandler(async (_req, res) => {
    res.json(listLogFiles());
  })
);

systemRouter.get(
  "/log-files/:name",
  asyncHandler(async (req, res) => {
    const filePath = resolveLogFilePath(req.params.name);
    if (!filePath || !fs.existsSync(filePath)) throw new HttpError(404, "Log file not found");
    res.download(filePath, req.params.name);
  })
);

/** Radarr-style System → Updates, adapted for a project with no git-tag releases — see
 * updateCheck.ts for why this compares CHANGELOG.md round numbers instead of semver/release tags. */
systemRouter.get(
  "/update-check",
  asyncHandler(async (_req, res) => {
    try {
      res.json(await checkForUpdate());
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  })
);

const APP_VERSION = "0.1.0";

systemRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const counts = (await db.prepare("SELECT type, COUNT(*) as count FROM media_items GROUP BY type").all()) as {
      type: string;
      count: number;
    }[];
    const libraryCounts: Record<string, number> = { movie: 0, series: 0, artist: 0, author: 0 };
    for (const c of counts) libraryCounts[c.type] = Number(c.count);

    const queueCount = Number(
      (
        (await db.prepare("SELECT COUNT(*) as c FROM queue WHERE status IN ('queued','downloading')").get()) as {
          c: number;
        }
      ).c
    );

    const indexerCount = Number(
      ((await db.prepare("SELECT COUNT(*) as c FROM indexers WHERE enabled = 1").get()) as { c: number }).c
    );
    const downloadClientCount = Number(
      ((await db.prepare("SELECT COUNT(*) as c FROM download_clients WHERE enabled = 1").get()) as { c: number }).c
    );

    await recordDiskUsageSamples();

    const folders = ((await db.prepare("SELECT * FROM root_folders").all()) as any[]).map(rootFolderFromRow);
    const diskSpace = await Promise.all(
      folders.map(async (f) => {
        const forecast = await getStorageForecast(f.id);
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
      })
    );

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
    const indexers = ((await db.prepare("SELECT * FROM indexers WHERE enabled = 1").all()) as any[]).map(indexerFromRow);
    // Historical recent-attempt data (from indexer_health, see services/indexerHealth.ts) alongside
    // the live reachability check below — an indexer can pass a live "is it up right now" check
    // while still having been unreliable over its last 50 real search attempts, and vice versa.
    await attachIndexerHealth(indexers as any[]);
    const indexerHealth = await Promise.all(
      indexers.map(async (idx: any) => ({
        id: idx.id,
        name: idx.name,
        ...(await checkIndexerHealth(idx)),
        recent: idx.health,
      }))
    );

    const stuckQueueRows = (await db
      .prepare(
        `SELECT q.id, q.title, q.status, q.added_at AS "addedAt", m.title AS "mediaTitle" FROM queue q
         JOIN media_items m ON m.id = q.media_item_id
         WHERE q.status IN ('queued','downloading')
         AND q.added_at <= ${nowOffsetHoursExpr(db, -STUCK_QUEUE_HOURS)}`
      )
      .all()) as any[];

    const pendingRequests = Number(
      ((await db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get()) as { c: number }).c
    );

    const repeatedImports = await findRepeatedImports();
    const upgradeCandidates = await findUpgradeCandidates();

    const downloadClients = ((await db.prepare("SELECT * FROM download_clients WHERE enabled = 1").all()) as any[]).map(
      downloadClientFromRow
    );
    const downloadClientHealth = await Promise.all(
      downloadClients.map(async (client) => {
        try {
          await getDownloadClientAdapter(client.type).getStatus(client, []);
          return { id: client.id, name: client.name, ok: true };
        } catch (err) {
          return { id: client.id, name: client.name, ok: false, error: (err as Error).message };
        }
      })
    );

    const DISK_WARN_PERCENT_FREE = 10;
    const rootFolders = (await db.prepare("SELECT id, path, min_free_space_gb FROM root_folders").all()) as {
      id: number;
      path: string;
      min_free_space_gb: number | null;
    }[];
    const diskWarnings = (
      await Promise.all(
        rootFolders.map(async (folder) => {
          const latest = (await db
            .prepare("SELECT free_bytes, total_bytes FROM disk_usage_samples WHERE root_folder_id = ? ORDER BY sampled_at DESC LIMIT 1")
            .get(folder.id)) as { free_bytes: number; total_bytes: number } | undefined;
          if (!latest || !Number(latest.total_bytes)) return null;
          const percentFree = (Number(latest.free_bytes) / Number(latest.total_bytes)) * 100;
          // Radarr-style per-folder minimum free space (GB) — independent of the global percent
          // threshold above, since a huge drive at 8% free might still have hundreds of GB left
          // (not actually urgent), while a small drive at 15% free might have almost none (is).
          const freeGb = Number(latest.free_bytes) / 1e9;
          const belowMinFreeSpace = folder.min_free_space_gb != null && freeGb < folder.min_free_space_gb;
          if (percentFree >= DISK_WARN_PERCENT_FREE && !belowMinFreeSpace) return null;
          return {
            rootFolderId: folder.id,
            path: folder.path,
            percentFree: Math.round(percentFree * 10) / 10,
            freeGb: Math.round(freeGb * 10) / 10,
            minFreeSpaceGb: folder.min_free_space_gb,
          };
        })
      )
    ).filter((w): w is NonNullable<typeof w> => w !== null);

    // Config-completeness warnings — distinct from the reachability/rate checks above, which all
    // assume something is already configured and only report on how well it's working. A fresh or
    // partially set-up instance has none of those to report, so without this an admin who dismissed
    // the onboarding checklist (web/src/pages/Onboarding.tsx) once has no ongoing signal that a
    // whole library type still has, say, no root folder and will never actually import anything.
    const [rootFolderCount, indexerCount, downloadClientCount] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS c FROM root_folders").get() as Promise<{ c: number }>,
      db.prepare("SELECT COUNT(*) AS c FROM indexers WHERE enabled = 1").get() as Promise<{ c: number }>,
      db.prepare("SELECT COUNT(*) AS c FROM download_clients WHERE enabled = 1").get() as Promise<{ c: number }>,
    ]);
    const configWarnings: { key: string; message: string }[] = [];
    if (Number(rootFolderCount.c) === 0) {
      configWarnings.push({ key: "no_root_folder", message: "No root folder configured — nothing has anywhere to import to yet." });
    }
    if (Number(indexerCount.c) === 0) {
      configWarnings.push({ key: "no_indexer", message: "No enabled indexer configured — searches will never find anything." });
    }
    if (Number(downloadClientCount.c) === 0) {
      configWarnings.push({ key: "no_download_client", message: "No enabled download client configured — grabs have nowhere to download to." });
    }

    res.json({
      configWarnings,
      indexers: indexerHealth,
      downloadClients: downloadClientHealth,
      stuckQueue: stuckQueueRows,
      stuckQueueThresholdHours: STUCK_QUEUE_HOURS,
      pendingRequests,
      repeatedImports,
      upgradeCandidates,
      diskWarnings,
      diskWarnPercentFree: DISK_WARN_PERCENT_FREE,
    });
  })
);

/** Maintainerr's "Leaving Soon" idea — a preview of what the next auto-archival run will sweep
 * up, computed with the exact same eligibility logic but nothing actually touched. */
systemRouter.get(
  "/archival/upcoming",
  asyncHandler(async (_req, res) => {
    res.json(await getUpcomingArchivals());
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

systemRouter.post(
  "/plex-watchlist-sync/run",
  asyncHandler(async (_req, res) => {
    res.json(await runPlexWatchlistSync());
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
    const folders = ((await db.prepare("SELECT * FROM root_folders").all()) as any[]).map(rootFolderFromRow);
    const knownPaths = new Set<string>([
      ...((await db.prepare("SELECT path FROM media_items WHERE path IS NOT NULL").all()) as { path: string }[]).map(
        (r) => r.path
      ),
      ...((await db.prepare("SELECT file_path FROM episodes WHERE file_path IS NOT NULL").all()) as { file_path: string }[]).map(
        (r) => r.file_path
      ),
      ...((await db.prepare("SELECT file_path FROM sub_items WHERE file_path IS NOT NULL").all()) as { file_path: string }[]).map(
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
      await db.prepare("UPDATE root_folders SET last_scanned_at = ? WHERE id = ?").run(scanStartedAt, folder.id);
    }

    res.json({ orphaned, incremental: !full, skippedDirs });
  })
);

/** Unmonitored library items with no downloaded file — safe to bulk-delete, since nothing on
 * disk references them. */
systemRouter.get(
  "/cleanup/unmonitored",
  asyncHandler(async (_req, res) => {
    res.json(await findUnmonitoredNoFile());
  })
);

/** Files that are very likely byte-identical across different library entries (same size +
 * matching partial hash) — usually a stale re-import. On-demand only; can be slow on a large
 * library since it stats/reads every file with a hasFile row. */
systemRouter.get(
  "/cleanup/duplicate-files",
  asyncHandler(async (_req, res) => {
    res.json(await findDuplicateFiles());
  })
);

/** Per-release-group grab success/failure history — used internally to break ties between
 * equally-scored search results, surfaced here so an admin can see which groups are actually
 * reliable in practice. */
systemRouter.get(
  "/release-group-stats",
  asyncHandler(async (_req, res) => {
    res.json(await listReleaseGroupStats());
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
const PG_DUMP_MAGIC = "PGDMP";

/** Streams a consistent snapshot of the live DB bundled with `encryption.key` (see
 * services/scheduledBackup.ts's writeBackupBundle) — SQLite via better-sqlite3's own online backup
 * API (safe mid-write, no need to pause anything), Postgres via `pg_dump` in custom format, shared
 * with the scheduled-backup job so both paths produce identically-restorable files. Bundling the
 * key means a restore onto a different config volume can still decrypt every stored credential. */
systemRouter.get(
  "/backup",
  asyncHandler(async (req, res) => {
    const tmpFile = path.join(os.tmpdir(), `aonarr-backup-${Date.now()}.${BACKUP_BUNDLE_EXTENSION}`);
    await writeBackupBundle(tmpFile);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "backup_downloaded");
    res.download(tmpFile, `aonarr-backup-${stamp}.${BACKUP_BUNDLE_EXTENSION}`, (err) => {
      fs.unlink(tmpFile, () => {});
      // Throwing here lands in process-level uncaughtException, not the route's error handler —
      // the handler promise already resolved when res.download() was called.
      if (err && !res.headersSent) res.status(500).json({ error: `Backup download failed: ${err.message}` });
    });
  })
);

/**
 * SQLite restore means replacing the live DB file out from under a running process, which is
 * only safe if we stop touching it first — so this checkpoints + closes the connection, swaps
 * the file, and exits; the container's restart policy (`unless-stopped`) brings it back up
 * against the restored file. The previous DB is kept alongside as a `.pre-restore` copy just in
 * case. Postgres restore is different in kind, not just mechanism: `pg_restore` runs against the
 * live connection over the network (see restorePostgres()), so the app never needs to stop
 * touching the database or exit — its connection pool just sees the schema replaced underneath it
 * inside one transaction.
 *
 * Accepts both a current bundle (zip: db snapshot + encryption.key, see writeBackupBundle) and a
 * legacy single-file `.db`/`.dump` upload from before bundling existed, for backward compatibility
 * with old downloads sitting on someone's disk. A bundle's key, when present, is written to
 * `encryption.key` BEFORE the DB swap — on the Postgres path this instance keeps running against
 * the restored DB immediately after, so the key must already be in place and its cache dropped
 * (reloadEncryptionKey) for the very first post-restore decrypt to succeed; on the SQLite path the
 * process exits and restarts anyway, so a plain file write is enough.
 */
systemRouter.post(
  "/backup/restore",
  express.raw({ type: "*/*", limit: "1gb" }),
  asyncHandler(async (req, res) => {
    const uploaded = req.body as Buffer;
    if (!Buffer.isBuffer(uploaded) || uploaded.length === 0) {
      throw new HttpError(400, "Uploaded file is empty");
    }

    let dbBuffer: Buffer = uploaded;
    let keyBuffer: Buffer | null = null;
    if (looksLikeBackupBundle(uploaded)) {
      const bundle = readBackupBundle(uploaded);
      dbBuffer = bundle.dbBuffer;
      keyBuffer = bundle.keyBuffer;
    }

    if (db.dialect === "postgres") {
      if (dbBuffer.length < PG_DUMP_MAGIC.length || dbBuffer.toString("utf-8", 0, PG_DUMP_MAGIC.length) !== PG_DUMP_MAGIC) {
        throw new HttpError(400, "Uploaded file is not a valid pg_dump custom-format backup");
      }
      const tmpFile = path.join(os.tmpdir(), `aonarr-restore-${Date.now()}.dump`);
      fs.writeFileSync(tmpFile, dbBuffer);
      const actor = auditActor(req);
      log.warn(`[system] database restore initiated by ${actor.username} (postgres)`);
      res.json({ restored: true, message: "Restoring — this may take a moment, the app keeps running." });
      try {
        if (keyBuffer) {
          fs.mkdirSync(path.dirname(ENCRYPTION_KEY_PATH), { recursive: true });
          fs.writeFileSync(ENCRYPTION_KEY_PATH, keyBuffer, { mode: 0o600 });
          reloadEncryptionKey();
        }
        await restorePostgres(tmpFile);
        log.info("[system] postgres restore completed");
      } catch (err) {
        log.error("[system] postgres restore failed:", (err as Error).message);
      } finally {
        fs.unlink(tmpFile, () => {});
      }
      return;
    }

    if (dbBuffer.length < SQLITE_MAGIC.length || dbBuffer.toString("utf-8", 0, SQLITE_MAGIC.length) !== SQLITE_MAGIC) {
      throw new HttpError(400, "Uploaded file is not a valid SQLite database (or backup bundle)");
    }

    // In WAL mode, recently-committed transactions can live only in the -wal file until the next
    // automatic checkpoint (every ~1000 pages) — without an explicit one here, a raw copy of just
    // the main DB file can miss them. sqliteDb.close() below does checkpoint on close, but by then
    // both this snapshot and the destructive overwrite have already happened, so it's too late to
    // protect this copy specifically.
    sqliteDb.pragma("wal_checkpoint(TRUNCATE)");
    const preRestorePath = `${config.dbPath}.pre-restore`;
    fs.copyFileSync(config.dbPath, preRestorePath);

    // Not logged to audit_log: a restore replaces the entire DB file, including the audit_log
    // table itself, so an entry written here wouldn't exist in the database anyone actually looks
    // at afterward. The server log is the durable record for this one.
    const actor = auditActor(req);
    log.warn(`[system] database restore initiated by ${actor.username} — previous DB saved to ${preRestorePath}`);

    res.json({ restored: true, message: "Restoring — the app will restart momentarily." });

    setTimeout(() => {
      if (keyBuffer) {
        fs.mkdirSync(path.dirname(ENCRYPTION_KEY_PATH), { recursive: true });
        fs.writeFileSync(ENCRYPTION_KEY_PATH, keyBuffer, { mode: 0o600 });
      }
      sqliteDb.close();
      fs.writeFileSync(config.dbPath, dbBuffer);
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
