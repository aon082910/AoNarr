// First: before anything opens the database, a second AoNarr on the same /config stops here.
import { RESTORE_FILES } from "./startupGuard.js";
import { confirmRestoreStarted, uncountRestoreStart } from "./restoreGuard.js";
import { verifyOutboundDispatcher } from "./services/socksProxy.js";
import { closeLogStream, log } from "./services/logger.js";
import { recordUncaughtError } from "./services/uncaughtErrors.js";
import { config } from "./config.js";
import { importLaneBusy, startScheduler } from "./services/scheduler.js";
import { stopAllJobs, cancelJob, isJobEnabled, isJobRunning, listJobs, runJobNow } from "./services/jobRegistry.js";
import { restartIrcFeeds } from "./services/ircFeedManager.js";
import { createApp } from "./app.js";
import { db } from "./db/index.js";
import { migrateCredentialedMediaServerPosters } from "./services/mediaServerImport.js";
import { migrateScreenscraperArtwork } from "./services/metadata.js";
import { resetInterruptedRestores } from "./services/recycleBin.js";
import { waitForQueueImports } from "./services/downloadClient.js";
import { backfillMissingAlbumTracks } from "./services/libraryScan.js";
import { repairUnrankedCutoffs } from "./services/quality.js";

// Without these, an unhandled rejection or a synchronous throw outside Express's own request
// cycle (a background job, a stray unawaited promise, an event-emitter callback) crashes the
// whole process — combined/entrypoint.sh treats "node died" as "kill nginx too, exit the
// container" (so Docker restarts it), which is why this used to look like a bare 502 with
// *nothing* in the logs: the crash line went to stdout/stderr right before the restart, but the
// in-app Logs page (services/logger.ts's ring buffer) is just an in-memory array — it resets to
// empty the instant the process restarts, so anyone checking the Logs page (rather than the raw
// container log, and often even that scrolls past what a log viewer shows by default) saw
// nothing. Logging and continuing, rather than also crashing, is deliberate: keeping the server
// up after logging the bad line is far more useful for a home server than a silent
// crash-restart-repeat that also nukes visibility into what actually broke.
// The process carries on, but not unnoticed: each one is counted (services/uncaughtErrors.ts), shown on /metrics and
// the System status, and Health warns when they come in a run.
process.on("uncaughtException", (err) => {
  recordUncaughtError("exception", err);
  log.error("[fatal] uncaught exception (server is still running):", err);
});
process.on("unhandledRejection", (reason) => {
  recordUncaughtError("rejection", reason);
  log.error("[fatal] unhandled promise rejection (server is still running):", reason instanceof Error ? reason : String(reason));
});

const app = await createApp();

// Until cleared, an entry whose restore a restart cut off shows as "Restoring..." with its
// buttons disabled: nothing on the Recycle Bin page's own load resets it.
await resetInterruptedRestores().catch((err) => log.warn("[startup] recycle-bin restore reset failed:", err.message));
await migrateCredentialedMediaServerPosters().catch((err) => log.warn("[startup] media-server poster migration failed:", err.message));
await migrateScreenscraperArtwork().catch((err) => log.warn("[startup] ScreenScraper artwork migration failed:", err.message));
// A profile cutoff that is not on the quality ladder would make every file under it an upgrade candidate.
await repairUnrankedCutoffs().catch((err) => log.warn("[startup] quality cutoff repair failed:", err.message));

/** Runs after the app is already serving traffic (see the `listen` callback below), delayed
 * further still so the first couple of minutes after a restart or update — when an admin is most
 * likely actively poking at the UI — are left completely undisturbed by this background sweep. */
const SWEEP_STARTUP_DELAY_MS = 2 * 60 * 1000;
/** The album track backfill re-walks the folder of every album that has a file but no track rows. It ran
 * before the port opened, so on a large library with sleeping disks the web UI waited for it. */
const ALBUM_BACKFILL_DELAY_MS = 30 * 1000;

const onListening = () => {
  log.info(`AoNarr server listening on ${config.bindAddress ?? "all interfaces"}, port ${config.port}`);
  // fetch() must really go through the dispatcher that carries the proxy, bypass and certificate settings.
  setTimeout(() => void verifyOutboundDispatcher(), 3000).unref();
  // A restored database that got this far works: the swap-back that waited on two failed starts is no longer needed.
  confirmRestoreStarted(RESTORE_FILES);
  startScheduler();
  restartIrcFeeds().catch((err) => log.warn("[irc] failed to start feeds:", err.message));
  setTimeout(() => {
    backfillMissingAlbumTracks().catch((err) => log.warn("[startup] album track backfill failed:", err.message));
  }, ALBUM_BACKFILL_DELAY_MS);
  // Through the job registry (the "Import Leftover Sweep" job), so the run has a history row and can be cancelled.
  setTimeout(() => {
    // Not when the admin switched the job off.
    if (isJobEnabled("importTempSweep")) runJobNow("importTempSweep");
  }, SWEEP_STARTUP_DELAY_MS);
};
// AONARR_BIND_ADDRESS limits the interface (e.g. 127.0.0.1 behind the bundled nginx); unset = all of them.
const server = config.bindAddress ? app.listen(config.port, config.bindAddress, onListening) : app.listen(config.port, onListening);
// A port in use or a bind address that is not on this host would otherwise surface as an uncaught exception, which is
// logged and ignored above: the process would stay up holding the instance lock with nothing listening.
server.on("error", (err: NodeJS.ErrnoException) => {
  log.error(`[startup] cannot listen on ${config.bindAddress ?? "all interfaces"}, port ${config.port}: ${err.message}`);
  void closeLogStream().finally(() => process.exit(1));
});

/**
 * Without this, `docker stop` (SIGTERM) hits Node's default disposition for that signal — the
 * process just terminates, whatever it was doing (a half-copied import, an in-flight scheduled
 * job) included. This stops new scheduled runs, cooperatively cancels whatever job is already
 * mid-run (see jobRegistry.ts's AbortSignal-based cancellation — best-effort, since a job with a
 * handful of monolithic awaits can't abort mid-await), stops accepting new HTTP connections, lets
 * running imports finish, and closes the DB cleanly. Bounded rather than waiting indefinitely: an
 * open EventSource stream (Activity page's live log tail) is a long-lived connection that
 * `server.close()`'s own callback won't fire until it ends, and a stuck one shouldn't be able to
 * block the container from ever stopping.
 */
const SHUTDOWN_GRACE_MS = 5_000;
/** Docker sends SIGKILL 10 s after SIGTERM by default; this leaves time to close the DB first. */
const SHUTDOWN_IMPORT_WAIT_MS = 8_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn(`[shutdown] ${signal} received — stopping scheduled jobs and draining connections`);
  // A deliberate stop before the app was listening is not a failed start of a restored database.
  uncountRestoreStart(RESTORE_FILES);

  try {
    stopAllJobs();
    for (const job of listJobs()) {
      if (job.running) cancelJob(job.key);
    }
    server.close();

    // The grace comes first: a request still in flight can start an import during it, and a queue
    // poll already underway keeps starting them (it doesn't stop on cancel), so both are waited out.
    const deadline = Date.now() + SHUTDOWN_IMPORT_WAIT_MS;
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
    const importsSettled = await waitForQueueImports(Math.max(0, deadline - Date.now()), () => isJobRunning("queuePoll") || importLaneBusy());
    if (!importsSettled) {
      log.warn(`[shutdown] an import or queue poll was still running after ${SHUTDOWN_IMPORT_WAIT_MS / 1000}s — exiting without waiting for it`);
    }
    await db.close().catch((err) => log.error("[shutdown] error closing database:", err));
  } finally {
    log.info("[shutdown] exiting");
    await closeLogStream();
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
