import { describe, it, expect, beforeAll, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { config } from "../src/config.js";
import { zipFilesInWorker } from "../src/services/backupZip.js";
import { setupTestDb } from "./helpers/testDb.js";

let backupFileExtension: (typeof import("../src/services/scheduledBackup.js"))["backupFileExtension"];
let writeBackupBundle: (typeof import("../src/services/scheduledBackup.js"))["writeBackupBundle"];
let readBackupBundle: (typeof import("../src/services/scheduledBackup.js"))["readBackupBundle"];
let looksLikeBackupBundle: (typeof import("../src/services/scheduledBackup.js"))["looksLikeBackupBundle"];
let runScheduledBackup: (typeof import("../src/services/scheduledBackup.js"))["runScheduledBackup"];
let restoredDbNeedsBundleKey: (typeof import("../src/services/scheduledBackup.js"))["restoredDbNeedsBundleKey"];
let checkSqliteBackup: (typeof import("../src/services/scheduledBackup.js"))["checkSqliteBackup"];
let defaultBackupDir: (typeof import("../src/services/scheduledBackup.js"))["defaultBackupDir"];
let getBackupProblem: (typeof import("../src/services/scheduledBackup.js"))["getBackupProblem"];
let rotateManualBackups: (typeof import("../src/services/scheduledBackup.js"))["rotateManualBackups"];
let noteManualBackupSucceeded: (typeof import("../src/services/scheduledBackup.js"))["noteManualBackupSucceeded"];
let ENCRYPTION_KEY_PATH: string;
let setSetting: (key: string, value: string) => void;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ backupFileExtension, writeBackupBundle, readBackupBundle, looksLikeBackupBundle, runScheduledBackup, restoredDbNeedsBundleKey, checkSqliteBackup, defaultBackupDir, getBackupProblem, rotateManualBackups, noteManualBackupSucceeded } = await import(
    "../src/services/scheduledBackup.js"
  ));
  ({ ENCRYPTION_KEY_PATH } = await import("../src/services/encryption.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  setSetting("backupEnabled", "0");
  setSetting("backupDir", "");
  setSetting("lastScheduledBackupAt", "");
  setSetting("backupKeepCount", "7");
  setSetting("backupProblem", "");
  setSetting("backupProblemAt", "");
});

describe("looksLikeBackupBundle", () => {
  it("recognizes the zip local-file-header magic number", () => {
    expect(looksLikeBackupBundle(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe(true);
  });

  it("rejects a SQLite file header and other non-zip content", () => {
    expect(looksLikeBackupBundle(Buffer.from("SQLite format 3\0"))).toBe(false);
    expect(looksLikeBackupBundle(Buffer.from("not a zip at all"))).toBe(false);
  });

  it("rejects a buffer shorter than the magic number itself", () => {
    expect(looksLikeBackupBundle(Buffer.from([0x50, 0x4b]))).toBe(false);
  });
});

describe("backupFileExtension", () => {
  it("is 'db' for the SQLite dialect this test suite runs under by default", () => {
    if (process.env.AONARR_DATABASE_DRIVER === "postgres") return; // covered by the CI postgres job instead
    expect(backupFileExtension()).toBe("db");
  });
});

describe("writeBackupBundle / readBackupBundle", () => {
  it("round-trips a real database snapshot through a zip bundle", async () => {
    const destPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-")), "test.aonarrbackup");

    await writeBackupBundle(destPath);

    expect(fs.existsSync(destPath)).toBe(true);
    const bundleBuffer = fs.readFileSync(destPath);
    expect(looksLikeBackupBundle(bundleBuffer)).toBe(true);

    const { dbBuffer, keyBuffer } = await readBackupBundle(bundleBuffer);
    expect(dbBuffer.length).toBeGreaterThan(0);
    expect(keyBuffer !== null).toBe(fs.existsSync(ENCRYPTION_KEY_PATH));
  });

  it("leaves nothing but the bundle in the folder: no snapshot copy, no partial zip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-"));
    await writeBackupBundle(path.join(dir, "only.aonarrbackup"));
    expect(fs.readdirSync(dir)).toEqual(["only.aonarrbackup"]);
  });

  it("zips on a worker thread: the longest stretch the event loop is blocked stays far below the zip time (RB3)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-zip-load-"));
    const source = path.join(dir, "big.db");
    // Pseudo-random hex: compresses slowly, so a synchronous zip of this would block for a second or more.
    fs.writeFileSync(source, crypto.randomBytes(24 * 1024 * 1024).toString("hex"));
    let longestBlock = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      longestBlock = Math.max(longestBlock, now - last);
      last = now;
    }, 5);
    const started = performance.now();
    try {
      await zipFilesInWorker([{ path: source, name: "db.db" }], path.join(dir, "out.zip"));
    } finally {
      clearInterval(ticker);
    }
    const zipMs = performance.now() - started;
    expect(fs.statSync(path.join(dir, "out.zip")).size).toBeGreaterThan(0);
    // Run synchronously on this thread the whole zip is one block of about zipMs; on the worker the loop only
    // waits for its own small work. A generous bound, so a busy machine does not make it flaky.
    expect(longestBlock).toBeLessThan(Math.max(300, zipMs * 0.5));
  }, 120_000);

  it("keeps the whole bundle and the database inside it identical through a WAL-mode snapshot (restore check, T7)", async () => {
    if (process.env.AONARR_DATABASE_DRIVER === "postgres") return;
    const destPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-")), "wal.aonarrbackup");
    await writeBackupBundle(destPath);
    const { dbBuffer } = await readBackupBundle(fs.readFileSync(destPath));
    // The real artifact: a snapshot of the live (WAL mode) test database goes through the same check a restore runs.
    expect(await checkSqliteBackup(dbBuffer)).toBeNull();
  });

  it("rejects a zip that has no database entry", async () => {
    await expect(readBackupBundle(Buffer.from("not even a zip"))).rejects.toThrow();
  });

  it("rejects a truncated bundle with the zip library's message, not a crash", async () => {
    const destPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-")), "cut.aonarrbackup");
    await writeBackupBundle(destPath);
    const whole = fs.readFileSync(destPath);
    await expect(readBackupBundle(whole.subarray(0, Math.floor(whole.length / 2)))).rejects.toThrow(/zip/i);
  });
});

describe("checkSqliteBackup (RB10)", () => {
  it("accepts a database that has the media_items and settings tables", async () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE media_items (id INTEGER PRIMARY KEY); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    const bytes = raw.serialize();
    raw.close();
    expect(await checkSqliteBackup(bytes)).toBeNull();
  });

  it("rejects a valid SQLite file from another program", async () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE unrelated (id INTEGER)");
    const bytes = raw.serialize();
    raw.close();
    expect(await checkSqliteBackup(bytes)).toMatch(/not an AoNarr database/);
  });

  it("rejects a header with nothing behind it", async () => {
    const bytes = Buffer.concat([Buffer.from("SQLite format 3\0", "utf-8"), Buffer.alloc(84)]);
    expect(await checkSqliteBackup(bytes)).toMatch(/could not be opened|not a database|malformed/i);
  });

  it("rejects a real database cut in half", async () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE media_items (id INTEGER PRIMARY KEY, t TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    const ins = raw.prepare("INSERT INTO media_items (t) VALUES (?)");
    for (let i = 0; i < 4000; i++) ins.run("row ".repeat(40) + i);
    const bytes = raw.serialize();
    raw.close();
    expect(await checkSqliteBackup(bytes.subarray(0, Math.floor(bytes.length / 2)))).not.toBeNull();
  });

  it("leaves no check file next to the live database", async () => {
    await checkSqliteBackup(Buffer.from("garbage"));
    const live = path.dirname(config.dbPath);
    expect(fs.readdirSync(live).filter((f) => f.includes("restore-check"))).toEqual([]);
  });
});

describe("runScheduledBackup", () => {
  it("does nothing when an admin has switched scheduled backups off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-"));
    setSetting("backupEnabled", "0");
    setSetting("backupDir", dir);

    await runScheduledBackup();

    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("is on by default: with nothing set it writes into Backups/scheduled in the config volume (RB2)", async () => {
    const { getSetting } = await import("../src/services/settingsStore.js");
    setSetting("backupEnabled", "");
    setSetting("backupDir", "");
    const dir = defaultBackupDir();
    fs.rmSync(dir, { recursive: true, force: true });

    await runScheduledBackup();

    expect(dir).toBe(path.join(config.configDir, "Backups", "scheduled"));
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("aonarr-backup-") && f.endsWith(".aonarrbackup"))).toHaveLength(1);
    expect(getSetting("lastScheduledBackupAt")).toBeTruthy();
    expect(getBackupProblem()).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a real backup bundle and records lastScheduledBackupAt when enabled and configured", async () => {
    const { getSetting } = await import("../src/services/settingsStore.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-"));
    setSetting("backupEnabled", "1");
    setSetting("backupDir", dir);

    await runScheduledBackup();

    const files = fs.readdirSync(dir).filter((f) => f.startsWith("aonarr-backup-"));
    expect(files).toHaveLength(1);
    expect(getSetting("lastScheduledBackupAt")).not.toBeNull();
  });

  it("skips a second run before the configured interval has elapsed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-"));
    setSetting("backupEnabled", "1");
    setSetting("backupDir", dir);

    await runScheduledBackup();
    await runScheduledBackup();

    expect(fs.readdirSync(dir).filter((f) => f.startsWith("aonarr-backup-"))).toHaveLength(1);
  });

  it("rotates out the oldest scheduled backups beyond the keep count, and never a manual one (RB2)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-"));
    fs.writeFileSync(path.join(dir, "aonarr-backup-2020-01-01T00-00-00-000Z.aonarrbackup"), "old-1");
    fs.writeFileSync(path.join(dir, "aonarr-backup-2020-01-02T00-00-00-000Z.aonarrbackup"), "old-2");
    fs.writeFileSync(path.join(dir, "aonarr-backup-2020-01-03T00-00-00-000Z.aonarrbackup"), "old-3");
    fs.writeFileSync(path.join(dir, "aonarr-manual-2019-01-01T00-00-00-000Z.aonarrbackup"), "manual");
    setSetting("backupEnabled", "1");
    setSetting("backupDir", dir);
    setSetting("backupKeepCount", "2");

    await runScheduledBackup();

    const remaining = fs.readdirSync(dir).filter((f) => f.startsWith("aonarr-backup-"));
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain("aonarr-backup-2020-01-01T00-00-00-000Z.aonarrbackup");
    expect(remaining).not.toContain("aonarr-backup-2020-01-02T00-00-00-000Z.aonarrbackup");
    expect(remaining).toContain("aonarr-backup-2020-01-03T00-00-00-000Z.aonarrbackup");
    expect(fs.existsSync(path.join(dir, "aonarr-manual-2019-01-01T00-00-00-000Z.aonarrbackup"))).toBe(true);
  });

  it("an unwritable folder does no backup work, becomes a health problem, and is not retried every hour (RB2)", async () => {
    const { getSetting } = await import("../src/services/settingsStore.js");
    // A path below a regular file cannot be created, whoever runs the test.
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-")), "a-file");
    fs.writeFileSync(blocker, "x");
    setSetting("backupEnabled", "1");
    setSetting("backupDir", path.join(blocker, "Backups"));

    await runScheduledBackup();

    expect(getSetting("lastScheduledBackupAt")).toBeFalsy();
    expect(getBackupProblem()).toMatch(/^Scheduled backup failed: /);
    const firstProblemAt = getSetting("backupProblemAt");
    expect(firstProblemAt).toBeTruthy();

    // A second run inside the retry wait leaves the problem record untouched (it did not try again).
    await runScheduledBackup();
    expect(getSetting("backupProblemAt")).toBe(firstProblemAt);
  });

  it("a later success clears the health problem (RB2)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-"));
    setSetting("backupEnabled", "1");
    setSetting("backupDir", dir);
    setSetting("backupProblem", "Scheduled backup failed: earlier");
    // The retry wait is over.
    setSetting("backupProblemAt", new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

    await runScheduledBackup();

    expect(getBackupProblem()).toBeNull();
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("aonarr-backup-"))).toHaveLength(1);
  });

  it("reports no problem while scheduled backups are switched off", () => {
    setSetting("backupProblem", "Scheduled backup failed: earlier");
    setSetting("backupEnabled", "0");
    expect(getBackupProblem()).toBeNull();
  });

  it("removes a stale partial zip or snapshot left by a crash, but not a fresh one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-"));
    const live = path.dirname(config.dbPath);
    const stalePartial = path.join(dir, "aonarr-backup-2020-01-01T00-00-00-000Z.aonarrbackup.partial");
    const freshPartial = path.join(dir, "aonarr-manual-2099-01-01T00-00-00-000Z.aonarrbackup.partial");
    const staleSnapshot = path.join(live, ".backup-snapshot-1-1.src");
    const freshSnapshot = path.join(live, ".backup-snapshot-2-2.src");
    for (const f of [stalePartial, freshPartial, staleSnapshot, freshSnapshot]) fs.writeFileSync(f, "x");
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(stalePartial, longAgo, longAgo);
    fs.utimesSync(staleSnapshot, longAgo, longAgo);
    setSetting("backupEnabled", "1");
    setSetting("backupDir", dir);

    await runScheduledBackup();

    expect(fs.existsSync(stalePartial)).toBe(false);
    expect(fs.existsSync(staleSnapshot)).toBe(false);
    expect(fs.existsSync(freshPartial)).toBe(true);
    expect(fs.existsSync(freshSnapshot)).toBe(true);
    fs.rmSync(freshSnapshot, { force: true });
  });

  it("builds the snapshot beside the live database, never in the backup folder (a network share)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-"));
    const seenInBackupFolder: string[] = [];
    const watcher = setInterval(() => seenInBackupFolder.push(...fs.readdirSync(dir)), 1);
    try {
      await writeBackupBundle(path.join(dir, "aonarr-backup-where.aonarrbackup"));
    } finally {
      clearInterval(watcher);
    }
    expect(seenInBackupFolder.filter((f) => f.endsWith(".src"))).toEqual([]);
  });

  it("keeps the newest ten Backup Now bundles and never touches a scheduled one (rotateManualBackups)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-"));
    for (let i = 1; i <= 13; i++) fs.writeFileSync(path.join(dir, `aonarr-manual-2026-01-${String(i).padStart(2, "0")}.aonarrbackup`), "m");
    fs.writeFileSync(path.join(dir, "aonarr-backup-2020-01-01.aonarrbackup"), "s");

    rotateManualBackups(dir);

    const left = fs.readdirSync(dir).sort();
    expect(left.filter((f) => f.startsWith("aonarr-manual-"))).toHaveLength(10);
    expect(left).not.toContain("aonarr-manual-2026-01-01.aonarrbackup");
    expect(left).toContain("aonarr-manual-2026-01-13.aonarrbackup");
    expect(left).toContain("aonarr-backup-2020-01-01.aonarrbackup");
  });

  it("a backup taken by hand clears a failed scheduled run's health problem", () => {
    setSetting("backupEnabled", "1");
    setSetting("backupProblem", "Scheduled backup failed: folder not writable");
    setSetting("backupProblemAt", new Date().toISOString());
    expect(getBackupProblem()).not.toBeNull();

    noteManualBackupSucceeded();

    expect(getBackupProblem()).toBeNull();
  });
});

describe("restoredDbNeedsBundleKey — sampled columns", () => {
  const bundleKeyHex = "ef".repeat(32);

  /** encryption.ts's `enc1:` format (IV, auth tag, ciphertext), under a key other than the installed one. */
  function encryptWithBundleKey(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(bundleKeyHex, "hex"), iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `enc1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
  }

  /** Runs `fn` with no encrypted settings in the database, so only the rows it adds are sampled. */
  async function withoutEncryptedSettings(fn: () => Promise<void>): Promise<void> {
    const saved = (await db.prepare("SELECT key, value FROM settings WHERE value LIKE ?").all("enc1:%")) as { key: string; value: string }[];
    await db.prepare("DELETE FROM settings WHERE value LIKE ?").run("enc1:%");
    try {
      await fn();
    } finally {
      for (const row of saved) await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(row.key, row.value);
    }
  }

  it("samples a remote instance's API key, even when nothing else is encrypted", async () => {
    await withoutEncryptedSettings(async () => {
      expect(await restoredDbNeedsBundleKey(Buffer.from(bundleKeyHex), false)).toBe(false);
      await db.prepare("INSERT INTO remote_instances (name, url, api_key) VALUES (?, ?, ?)").run("Other Install", "http://other.local", encryptWithBundleKey("remote key"));
      try {
        expect(await restoredDbNeedsBundleKey(Buffer.from(bundleKeyHex), false)).toBe(true);
      } finally {
        await db.prepare("DELETE FROM remote_instances").run();
      }
    });
  });

  it("samples a friend library's token, even when nothing else is encrypted", async () => {
    await withoutEncryptedSettings(async () => {
      expect(await restoredDbNeedsBundleKey(Buffer.from(bundleKeyHex), false)).toBe(false);
      await db
        .prepare("INSERT INTO friend_libraries (name, type, url, token) VALUES (?, 'plex', ?, ?)")
        .run("Friend's Plex", "http://friend.local:32400", encryptWithBundleKey("plex token"));
      try {
        expect(await restoredDbNeedsBundleKey(Buffer.from(bundleKeyHex), false)).toBe(true);
      } finally {
        await db.prepare("DELETE FROM friend_libraries").run();
      }
    });
  });
});
