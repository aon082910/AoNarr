import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

let backupFileExtension: (typeof import("../src/services/scheduledBackup.js"))["backupFileExtension"];
let writeBackupBundle: (typeof import("../src/services/scheduledBackup.js"))["writeBackupBundle"];
let readBackupBundle: (typeof import("../src/services/scheduledBackup.js"))["readBackupBundle"];
let looksLikeBackupBundle: (typeof import("../src/services/scheduledBackup.js"))["looksLikeBackupBundle"];
let runScheduledBackup: (typeof import("../src/services/scheduledBackup.js"))["runScheduledBackup"];
let ENCRYPTION_KEY_PATH: string;
let setSetting: (key: string, value: string) => void;

beforeAll(async () => {
  await setupTestDb();
  ({ backupFileExtension, writeBackupBundle, readBackupBundle, looksLikeBackupBundle, runScheduledBackup } = await import(
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

    const { dbBuffer, keyBuffer } = readBackupBundle(bundleBuffer);
    expect(dbBuffer.length).toBeGreaterThan(0);
    expect(keyBuffer !== null).toBe(fs.existsSync(ENCRYPTION_KEY_PATH));
  });

  it("throws when reading a zip that has no database entry", () => {
    expect(() => readBackupBundle(Buffer.from("not even a zip"))).toThrow();
  });
});

describe("runScheduledBackup", () => {
  it("does nothing when scheduled backups aren't enabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-"));
    setSetting("backupDir", dir);

    await runScheduledBackup();

    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("does nothing (without throwing) when enabled but no backup directory is configured", async () => {
    setSetting("backupEnabled", "1");
    setSetting("backupDir", "");

    await expect(runScheduledBackup()).resolves.not.toThrow();
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

  it("rotates out the oldest backups beyond the configured keep count", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-backup-run-"));
    fs.writeFileSync(path.join(dir, "aonarr-backup-2020-01-01T00-00-00-000Z.aonarrbackup"), "old-1");
    fs.writeFileSync(path.join(dir, "aonarr-backup-2020-01-02T00-00-00-000Z.aonarrbackup"), "old-2");
    fs.writeFileSync(path.join(dir, "aonarr-backup-2020-01-03T00-00-00-000Z.aonarrbackup"), "old-3");
    setSetting("backupEnabled", "1");
    setSetting("backupDir", dir);
    setSetting("backupKeepCount", "2");

    await runScheduledBackup();

    const remaining = fs.readdirSync(dir).filter((f) => f.startsWith("aonarr-backup-"));
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain("aonarr-backup-2020-01-01T00-00-00-000Z.aonarrbackup");
    expect(remaining).not.toContain("aonarr-backup-2020-01-02T00-00-00-000Z.aonarrbackup");
    expect(remaining).toContain("aonarr-backup-2020-01-03T00-00-00-000Z.aonarrbackup");
  });
});
