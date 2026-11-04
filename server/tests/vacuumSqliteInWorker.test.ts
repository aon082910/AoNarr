import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vacuumSqliteInWorker } from "../src/services/backupZip.js";

let work: string;
let dbFile: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-vacuum-"));
  dbFile = path.join(work, "aonarr.db");
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

/** A database that held `rows` rows of about 1 KB and now holds every `keepEvery`th of them, so most pages are free. */
function fragmentedDatabase(file: string, rows = 3000, keepEvery = 100): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO items (id, body) VALUES (?, ?)");
  db.transaction(() => {
    for (let i = 1; i <= rows; i++) insert.run(i, `${i}:`.padEnd(1000, "x"));
  })();
  db.prepare("DELETE FROM items WHERE id % ? != 0").run(keepEvery);
  db.pragma("wal_checkpoint(TRUNCATE)");
  return db;
}

describe("vacuumSqliteInWorker", () => {
  it("gives back the pages that deleted rows left free, and keeps every row that is left", async () => {
    const db = fragmentedDatabase(dbFile);
    const sizeBefore = fs.statSync(dbFile).size;
    const freeBefore = Number(db.pragma("freelist_count", { simple: true }));
    const rowsBefore = db.prepare("SELECT id, body FROM items ORDER BY id").all();
    db.close();
    expect(freeBefore).toBeGreaterThan(100);
    expect(rowsBefore).toHaveLength(30);

    await vacuumSqliteInWorker(dbFile);

    const after = new Database(dbFile, { readonly: true });
    try {
      expect(Number(after.pragma("freelist_count", { simple: true }))).toBe(0);
      expect(after.prepare("SELECT id, body FROM items ORDER BY id").all()).toEqual(rowsBefore);
      expect(after.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      after.close();
    }
    expect(fs.statSync(dbFile).size).toBeLessThan(sizeBefore / 5);
  });

  it("works on a database the application still has open, which carries on reading and writing afterwards", async () => {
    const live = fragmentedDatabase(dbFile);
    const pagesBefore = Number(live.pragma("page_count", { simple: true }));
    const rowsBefore = Number((live.prepare("SELECT COUNT(*) AS c FROM items").get() as { c: number }).c);

    await vacuumSqliteInWorker(dbFile);

    try {
      expect(Number(live.pragma("page_count", { simple: true }))).toBeLessThan(pagesBefore / 5);
      expect(Number(live.pragma("freelist_count", { simple: true }))).toBe(0);
      expect(Number((live.prepare("SELECT COUNT(*) AS c FROM items").get() as { c: number }).c)).toBe(rowsBefore);
      live.prepare("INSERT INTO items (id, body) VALUES (100000, 'written after the vacuum')").run();
      expect((live.prepare("SELECT body FROM items WHERE id = 100000").get() as { body: string }).body).toBe("written after the vacuum");
    } finally {
      live.close();
    }
  });

  it("does nothing harmful to a database with nothing to give back", async () => {
    const db = new Database(dbFile);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO items (body) VALUES ('a'), ('b')");
    db.close();

    await expect(vacuumSqliteInWorker(dbFile)).resolves.toBeUndefined();

    const after = new Database(dbFile, { readonly: true });
    expect(after.prepare("SELECT body FROM items ORDER BY id").all()).toEqual([{ body: "a" }, { body: "b" }]);
    after.close();
  });

  it("rejects, and creates nothing, for a path where there is no database", async () => {
    const missing = path.join(work, "no-such-database.db");

    await expect(vacuumSqliteInWorker(missing)).rejects.toThrow(/unable to open database file/i);

    expect(fs.existsSync(missing)).toBe(false);
  });

  it("rejects, and leaves the file as it was, for a file that is not a database", async () => {
    fs.writeFileSync(dbFile, "this is just some text, not a SQLite file at all, long enough to look like a page header");

    await expect(vacuumSqliteInWorker(dbFile)).rejects.toThrow(/not a database/i);

    expect(fs.readFileSync(dbFile, "utf-8")).toBe("this is just some text, not a SQLite file at all, long enough to look like a page header");
  });
});
