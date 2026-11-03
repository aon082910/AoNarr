import { runInWorkerWithTimeout } from "./workerThread.js";

/**
 * Zipping a database and inflating one run on a worker_thread, not the main one. adm-zip is
 * synchronous: a 395 MB database took 10.5 s to zip with no timer tick (the API, the web UI, SSE
 * streams and /api/health all stopped) and 2.2 s to inflate on restore. The worker does the same
 * work on its own thread and the event loop keeps turning.
 *
 * The worker is plain JavaScript passed as source (`eval: true`) instead of a sibling file. A file
 * would have to be resolved as .ts under `tsx watch` and `vitest` and as .js under dist/ (see
 * bookFileMetadata.ts's PDF worker, which cannot be started from a test for that reason); source text
 * runs the same way in all three. adm-zip is required relative to this module (`requireFrom`), not the
 * working directory.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
try {
  const AdmZip = createRequire(workerData.requireFrom)("adm-zip");
  if (workerData.op === "zip") {
    const zip = new AdmZip();
    for (const entry of workerData.entries) zip.addLocalFile(entry.path, "", entry.name);
    // Not zip.writeZip(): it ignores a short write, so a full disk could leave a cut zip that is renamed into
    // place as a good backup. writeFileSync loops until every byte is written or throws.
    const bytes = zip.toBuffer();
    const fs = require("node:fs");
    fs.writeFileSync(workerData.destPath, bytes);
    if (fs.statSync(workerData.destPath).size !== bytes.length) throw new Error("the backup file was not written completely");
    parentPort.postMessage({ ok: true, result: null });
  } else if (workerData.op === "unzip") {
    const zip = new AdmZip(Buffer.from(workerData.zip.buffer, workerData.zip.byteOffset, workerData.zip.byteLength));
    const dbEntry = zip.getEntries().find((e) => e.entryName.startsWith(workerData.dbEntryPrefix));
    if (!dbEntry) throw new Error("Backup bundle has no database entry");
    const keyEntry = zip.getEntry(workerData.keyEntryName);
    const view = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    parentPort.postMessage({
      ok: true,
      result: { db: view(dbEntry.getData()), key: keyEntry ? view(keyEntry.getData()) : null },
    });
  } else if (workerData.op === "sqlite-check") {
    const Database = createRequire(workerData.requireFrom)("better-sqlite3");
    const db = new Database(workerData.path, { readonly: true, fileMustExist: true });
    try {
      const bad = db.pragma("quick_check(5)").filter((row) => row.quick_check !== "ok");
      let problem = null;
      if (bad.length > 0) {
        problem = "its integrity check failed: " + bad.map((row) => row.quick_check).join("; ");
      } else {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
        const missing = workerData.requiredTables.filter((name) => !tables.has(name));
        if (missing.length > 0) problem = "it has no " + missing.join(" or ") + " table, so it is not an AoNarr database";
      }
      parentPort.postMessage({ ok: true, result: problem });
    } finally {
      db.close();
    }
  } else {
    throw new Error("unknown backup worker operation");
  }
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
`;

/** A 400 MB database zips in about 10 s; this only has to catch a worker that never answers. */
export const BACKUP_ZIP_TIMEOUT_MS = 30 * 60 * 1000;

/** Zips `entries` (local file + the name it gets inside the zip) into `destPath`. */
export function zipFilesInWorker(entries: { path: string; name: string }[], destPath: string): Promise<void> {
  return runInWorkerWithTimeout<null>(
    WORKER_SOURCE,
    { op: "zip", entries, destPath, requireFrom: import.meta.url },
    BACKUP_ZIP_TIMEOUT_MS,
    { eval: true }
  ).then(() => undefined);
}

/** Reads the database entry (the first entry whose name starts with `dbEntryPrefix`) and the optional
 * key entry out of a zip. Throws the zip library's own message for a truncated or damaged zip. */
export async function unzipBundleInWorker(
  zip: Buffer,
  dbEntryPrefix: string,
  keyEntryName: string
): Promise<{ dbBuffer: Buffer; keyBuffer: Buffer | null }> {
  const result = await runInWorkerWithTimeout<{ db: Uint8Array; key: Uint8Array | null }>(
    WORKER_SOURCE,
    { op: "unzip", zip, dbEntryPrefix, keyEntryName, requireFrom: import.meta.url },
    BACKUP_ZIP_TIMEOUT_MS,
    { eval: true }
  );
  return {
    dbBuffer: Buffer.from(result.db.buffer, result.db.byteOffset, result.db.byteLength),
    keyBuffer: result.key ? Buffer.from(result.key.buffer, result.key.byteOffset, result.key.byteLength) : null,
  };
}

/** Opens the SQLite file read-only on the worker thread, runs `PRAGMA quick_check` and requires the
 * tables every AoNarr database has. Returns why the file is unusable, or null when it passes. A file
 * that is not a database at all rejects with SQLite's own message ("file is not a database"). */
export function checkSqliteFileInWorker(filePath: string, requiredTables: string[]): Promise<string | null> {
  return runInWorkerWithTimeout<string | null>(
    WORKER_SOURCE,
    { op: "sqlite-check", path: filePath, requiredTables, requireFrom: import.meta.url },
    BACKUP_ZIP_TIMEOUT_MS,
    { eval: true }
  );
}
