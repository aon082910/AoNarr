import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { checkRestoreAtStart } from "./restoreGuard.js";
import { acquireInstanceLock, releaseInstanceLock, startInstanceHeartbeat } from "./services/instanceLock.js";

/** The files a restore replaces, for restoreGuard.ts (the key path is encryption.ts's, spelled out so this file stays import-light). */
export const RESTORE_FILES = { dbPath: config.dbPath, keyPath: path.join(config.configDir, "encryption.key") };

/**
 * Imported first by index.ts, before anything opens the database: a second AoNarr on the same /config stops here,
 * before it can run a migration or a job against a SQLite file the first one is using. Only for the SQLite driver:
 * instances of a Postgres setup share a server, not a folder (and have their own /config each).
 * After the lock (only the instance that holds it may swap files) the start counts itself against a restore on
 * probation, and a restore that has failed to start twice is rolled back before the database is opened.
 */
if (config.databaseDriver === "sqlite" && !config.allowMultipleInstances) {
  fs.mkdirSync(config.configDir, { recursive: true });
  const lock = acquireInstanceLock(config.configDir);
  if (!lock.ok) {
    console.error(
      `[startup] Another AoNarr (process ${lock.holder.pid} on ${lock.holder.host || "this host"}) is already running on ${config.configDir}. ` +
        "Two instances on one folder would run every job twice against one database, so this one is stopping. " +
        "Stop the other one, or set AONARR_ALLOW_MULTIPLE_INSTANCES=1 if you are sure."
    );
    process.exit(1);
  }
  startInstanceHeartbeat(config.configDir, lock.id, (holder) => {
    console.error(`[startup] Another AoNarr (process ${holder.pid} on ${holder.host}) has taken over ${config.configDir}; stopping.`);
    process.exit(1);
  });
  process.on("exit", () => releaseInstanceLock(config.configDir, lock.id));
}
if (config.databaseDriver === "sqlite") checkRestoreAtStart(RESTORE_FILES);
