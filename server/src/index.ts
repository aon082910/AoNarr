import { log } from "./services/logger.js";
import { config } from "./config.js";
import { startScheduler } from "./services/scheduler.js";
import { stopAllJobs, cancelJob, listJobs } from "./services/jobRegistry.js";
import { restartIrcFeeds } from "./services/ircFeedManager.js";
import { createApp } from "./app.js";
import { db } from "./db/index.js";
import { migrateCredentialedMediaServerPosters } from "./services/mediaServerImport.js";

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
process.on("uncaughtException", (err) => {
  log.error("[fatal] uncaught exception (server is still running):", err);
});
process.on("unhandledRejection", (reason) => {
  log.error("[fatal] unhandled promise rejection (server is still running):", reason instanceof Error ? reason : String(reason));
});

const app = await createApp();

await migrateCredentialedMediaServerPosters().catch((err) => log.warn("[startup] media-server poster migration failed:", err.message));

const server = app.listen(config.port, () => {
  log.info(`AoNarr server listening on port ${config.port}`);
  startScheduler();
  restartIrcFeeds().catch((err) => log.warn("[irc] failed to start feeds:", err.message));
});

/**
 * Without this, `docker stop` (SIGTERM) hits Node's default disposition for that signal — the
 * process just terminates, whatever it was doing (a half-copied import, an in-flight scheduled
 * job) included. This stops new scheduled runs, cooperatively cancels whatever job is already
 * mid-run (see jobRegistry.ts's AbortSignal-based cancellation — best-effort, since a job with a
 * handful of monolithic awaits can't abort mid-await), stops accepting new HTTP connections, and
 * closes the DB cleanly. Bounded by SHUTDOWN_GRACE_MS rather than waiting indefinitely: an open
 * EventSource stream (Activity page's live log tail) is a long-lived connection that
 * `server.close()`'s own callback won't fire until it ends, and a stuck one shouldn't be able to
 * block the container from ever stopping.
 */
const SHUTDOWN_GRACE_MS = 5_000;
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn(`[shutdown] ${signal} received — stopping scheduled jobs and draining connections`);

  stopAllJobs();
  for (const job of listJobs()) {
    if (job.running) cancelJob(job.key);
  }
  server.close();

  setTimeout(() => {
    db.close()
      .catch((err) => log.error("[shutdown] error closing database:", err))
      .finally(() => {
        log.info("[shutdown] exiting");
        process.exit(0);
      });
  }, SHUTDOWN_GRACE_MS);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
