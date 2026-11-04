import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let setSetting: (key: string, value: string) => void;
let tmp: string;
let movieRoot: string;
let rootId: number;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-scanadd-"));
  movieRoot = path.join(tmp, "movies");
  fs.mkdirSync(movieRoot);
  process.env.AONARR_SCAN_ON_ADD = "1";
  const { setScanOnAddTiming } = await import("../src/services/scanOnAdd.js");
  setScanOnAddTiming({ debounceMs: 10, maxWaitMs: 50, retryPollMs: 10 });
});

afterAll(() => {
  process.env.AONARR_SCAN_ON_ADD = "0";
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ["history", "queue", "episodes", "sub_items", "media_items", "root_folders"]) await db.prepare(`DELETE FROM ${t}`).run();
  for (const name of fs.readdirSync(movieRoot)) fs.rmSync(path.join(movieRoot, name), { recursive: true, force: true });
  rootId = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(movieRoot)).lastInsertRowid);
  setSetting("scanOnAdd", "");
});

function write(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  return file;
}

describe("a title added while its file is already on disk (MM7)", () => {
  it("is linked to the file in the background, instead of staying missing", async () => {
    const { waitForScansAfterAdd } = await import("../src/services/scanOnAdd.js");
    const file = write(path.join(movieRoot, "Already There (2019)", "Already There (2019).mkv"));

    const res = await request(app).post("/api/media").set("X-Api-Key", apiKey).send({ type: "movie", title: "Already There", year: 2019, rootFolderId: rootId });
    expect(res.status).toBe(201);
    await waitForScansAfterAdd();

    const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(res.body.id)) as any;
    expect(Number(row.has_file)).toBe(1);
    expect(row.path).toBe(file);
  });

  it("does nothing when scanOnAdd is off", async () => {
    const { waitForScansAfterAdd } = await import("../src/services/scanOnAdd.js");
    setSetting("scanOnAdd", "0");
    write(path.join(movieRoot, "Left Alone (2018)", "Left Alone (2018).mkv"));

    const res = await request(app).post("/api/media").set("X-Api-Key", apiKey).send({ type: "movie", title: "Left Alone", year: 2018, rootFolderId: rootId });
    await waitForScansAfterAdd();

    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(res.body.id)) as any;
    expect(Number(row.has_file)).toBe(0);
  });

  it("scans each added item once, even when queued twice", async () => {
    const { queueScanAfterAdd, waitForScansAfterAdd } = await import("../src/services/scanOnAdd.js");
    const file = write(path.join(movieRoot, "Twice (2017)", "Twice (2017).mkv"));
    const id = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, root_folder_id) VALUES ('movie', 'Twice', 'twice', 2017, 1, 0, 'missing', ?)").run(rootId)).lastInsertRowid
    );

    queueScanAfterAdd(id);
    queueScanAfterAdd(id);
    await waitForScansAfterAdd();

    expect(((await db.prepare("SELECT path FROM media_items WHERE id = ?").get(id)) as any).path).toBe(file);
  });
});

describe("the scan after an add only links (R25-09)", () => {
  it("does not create another title for a file that belongs to a different year of the same name", async () => {
    const { waitForScansAfterAdd } = await import("../src/services/scanOnAdd.js");
    write(path.join(movieRoot, "It (1990)", "It.1990.1080p.mkv"));

    const res = await request(app).post("/api/media").set("X-Api-Key", apiKey).send({ type: "movie", title: "It", year: 2017, rootFolderId: rootId });
    expect(res.status).toBe(201);
    await waitForScansAfterAdd();

    const rows = (await db.prepare("SELECT id, year FROM media_items WHERE type = 'movie'").all()) as { id: number; year: number }[];
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].year)).toBe(2017);
  });
});

describe("adds are scanned together (R30c)", () => {
  async function insertMovie(title: string, year: number): Promise<number> {
    return Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, root_folder_id) VALUES ('movie', ?, ?, ?, 1, 0, 'missing', ?)").run(title, title.toLowerCase(), year, rootId)).lastInsertRowid
    );
  }

  it("links the files of several added titles in one scan and leaves a title that was not part of the batch alone", async () => {
    const { queueScanAfterAdd, waitForScansAfterAdd } = await import("../src/services/scanOnAdd.js");
    const fileA = write(path.join(movieRoot, "Alpha (2001)", "Alpha (2001).mkv"));
    const fileB = write(path.join(movieRoot, "Beta (2002)", "Beta (2002).mkv"));
    write(path.join(movieRoot, "Gamma (2003)", "Gamma (2003).mkv"));
    const a = await insertMovie("Alpha", 2001);
    const b = await insertMovie("Beta", 2002);
    const gamma = await insertMovie("Gamma", 2003);

    queueScanAfterAdd(a);
    queueScanAfterAdd(b);
    await waitForScansAfterAdd();

    expect(((await db.prepare("SELECT path FROM media_items WHERE id = ?").get(a)) as any).path).toBe(fileA);
    expect(((await db.prepare("SELECT path FROM media_items WHERE id = ?").get(b)) as any).path).toBe(fileB);
    expect(((await db.prepare("SELECT path FROM media_items WHERE id = ?").get(gamma)) as any).path).toBeNull();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c)).toBe(3);
  });

  it("scanAndImportItems with an empty list does nothing", async () => {
    const { scanAndImportItems } = await import("../src/services/libraryScan.js");
    const result = await scanAndImportItems("movie", []);
    expect(result).toEqual({ matched: 0, created: 0, skipped: 0, skippedFiles: [] });
  });
});
