import { log } from "./services/logger.js";
import { config } from "./config.js";
import { startScheduler } from "./services/scheduler.js";
import { restartIrcFeeds } from "./services/ircFeedManager.js";
import { createApp } from "./app.js";

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

app.listen(config.port, () => {
  log.info(`AoNarr server listening on port ${config.port}`);
  startScheduler();
  restartIrcFeeds().catch((err) => log.warn("[irc] failed to start feeds:", err.message));
});
