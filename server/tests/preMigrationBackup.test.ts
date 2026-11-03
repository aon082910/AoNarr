import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PRE_MIGRATION_KEEP,
  getPreMigrationProblem,
  recordMigrationDone,
  snapshotBeforeMigration,
} from "../src/db/preMigrationBackup.js";

let work: string;
let dbFile: string;
let backups: string;
let live: Database.Database;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-premigration-"));
  dbFile = path.join(work, "aonarr.db");
  backups = path.join(work, "Backups", "pre-migration");
  live = new Database(dbFile);
  live.pragma("journal_mode = WAL");
  live.exec("CREATE TABLE media_items (id INTEGER PRIMARY KEY, title TEXT)");
  live.prepare("INSERT INTO media_items (title) VALUES ('before the upgrade')").run();
});

afterEach(() => {
  live.close();
  fs.rmSync(work, { recursive: true, force: true });
});

describe("snapshotBeforeMigration (RB2)", () => {
  it("copies the database the first time a build starts on an existing one, and the copy holds the pre-migration rows", () => {
    const result = snapshotBeforeMigration(live, true, "2026-11-02T10:00:00Z", backups);

    expect(result.kind).toBe("written");
    const files = fs.readdirSync(backups).filter((f) => f.endsWith(".db"));
    expect(files).toHaveLength(1);
    const copy = new Database(path.join(backups, files[0]), { readonly: true });
    expect((copy.prepare("SELECT title FROM media_items").get() as { title: string }).title).toBe("before the upgrade");
    copy.close();
  });

  it("does nothing on a fresh install, where there is nothing to protect", () => {
    expect(snapshotBeforeMigration(live, false, "2026-11-02T10:00:00Z", backups)).toEqual({ kind: "skipped" });
    expect(fs.existsSync(backups)).toBe(false);
  });

  it("does nothing for a build without a build time, a local or dev run", () => {
    expect(snapshotBeforeMigration(live, true, null, backups)).toEqual({ kind: "skipped" });
    expect(fs.existsSync(backups)).toBe(false);
  });

  it("does not copy again once the same build has finished its migrations", () => {
    const first = snapshotBeforeMigration(live, true, "build-1", backups);
    recordMigrationDone("build-1", first, backups);

    expect(snapshotBeforeMigration(live, true, "build-1", backups)).toEqual({ kind: "skipped" });
    expect(fs.readdirSync(backups).filter((f) => f.endsWith(".db"))).toHaveLength(1);
  });

  it("does not overwrite the good copy when a build crashes during migration and starts again", () => {
    snapshotBeforeMigration(live, true, "build-1", backups); // no recordMigrationDone: the migration crashed
    const copyPath = path.join(backups, fs.readdirSync(backups).find((f) => f.endsWith(".db"))!);
    live.prepare("INSERT INTO media_items (title) VALUES ('half migrated')").run();

    expect(snapshotBeforeMigration(live, true, "build-1", backups)).toEqual({ kind: "skipped" });

    const copy = new Database(copyPath, { readonly: true });
    expect((copy.prepare("SELECT COUNT(*) AS n FROM media_items").get() as { n: number }).n).toBe(1);
    copy.close();
  });

  it("leaves no partial file behind and does not trust one left by a copy that was cut short", () => {
    fs.mkdirSync(backups, { recursive: true });
    const target = path.join(backups, "aonarr-pre-migration-build-cut.db");
    fs.writeFileSync(`${target}.partial`, "half a database");

    const result = snapshotBeforeMigration(live, true, "build-cut", backups);

    expect(result.kind).toBe("written");
    expect(fs.existsSync(`${target}.partial`)).toBe(false);
    const copy = new Database(target, { readonly: true });
    expect((copy.prepare("SELECT title FROM media_items").get() as { title: string }).title).toBe("before the upgrade");
    copy.close();
  });

  it("keeps the new copy even when trimming the old ones fails", () => {
    snapshotBeforeMigration(live, true, "build-a", backups);
    // A directory with the name of an old copy cannot be removed with rmSync(force) the way a file can be.
    const stuck = path.join(backups, "aonarr-pre-migration-build-old.db");
    fs.mkdirSync(path.join(stuck, "inner"), { recursive: true });
    fs.utimesSync(stuck, new Date(0), new Date(0));

    const result = snapshotBeforeMigration(live, true, "build-b", backups, 1);

    expect(result.kind).toBe("written");
    expect(fs.existsSync(path.join(backups, "aonarr-pre-migration-build-b.db"))).toBe(true);
  });

  it("copies again for the next build and keeps only the newest few", () => {
    for (let i = 1; i <= PRE_MIGRATION_KEEP + 2; i++) {
      const result = snapshotBeforeMigration(live, true, `build-${i}`, backups);
      expect(result.kind).toBe("written");
      recordMigrationDone(`build-${i}`, result, backups);
      // distinct modification times, so "newest" is well defined
      const file = (result as { file: string }).file;
      const at = new Date(Date.now() - (PRE_MIGRATION_KEEP + 3 - i) * 60_000);
      fs.utimesSync(file, at, at);
    }
    const kept = fs.readdirSync(backups).filter((f) => f.endsWith(".db"));
    expect(kept).toHaveLength(PRE_MIGRATION_KEEP);
    expect(kept.some((f) => f.includes("build-1.db"))).toBe(false);
    expect(kept.some((f) => f.includes(`build-${PRE_MIGRATION_KEEP + 2}.db`))).toBe(true);
  });

  it("reports a failed copy instead of throwing, leaves no partial file, and shows it as a health problem", () => {
    // A folder that cannot be created (it would sit below a regular file) makes the copy fail.
    const blocker = path.join(work, "a-file");
    fs.writeFileSync(blocker, "x");
    const unusable = path.join(blocker, "pre-migration");

    const result = snapshotBeforeMigration(live, true, "build-9", unusable);

    expect(result.kind).toBe("failed");
    recordMigrationDone("build-9", result, backups);
    expect(getPreMigrationProblem(backups)).toMatch(/no safety copy/);
  });

  it("stops showing a failed copy after a week", () => {
    fs.mkdirSync(backups, { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(backups, "last-build.json"), JSON.stringify({ buildId: "b", at: old, error: "disk full" }));
    expect(getPreMigrationProblem(backups)).toBeNull();

    fs.writeFileSync(path.join(backups, "last-build.json"), JSON.stringify({ buildId: "b", at: new Date().toISOString(), error: "disk full" }));
    expect(getPreMigrationProblem(backups)).toContain("disk full");
  });

  it("a successful copy is not a problem", () => {
    const result = snapshotBeforeMigration(live, true, "build-ok", backups);
    recordMigrationDone("build-ok", result, backups);
    expect(getPreMigrationProblem(backups)).toBeNull();
  });
});
