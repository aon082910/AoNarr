import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let tmpDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-cleanup-"));
});

function writeFile(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

async function insertMediaItem(opts: {
  type?: string;
  title: string;
  monitored?: number;
  hasFile?: number;
  path?: string | null;
}): Promise<number> {
  const { type = "movie", title, monitored = 1, hasFile = 0, path: filePath = null } = opts;
  const id = Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES (?, ?, ?, ?, ?, 'unknown', ?)`
        )
        .run(type, title, title.toLowerCase(), monitored, hasFile, filePath)
    ).lastInsertRowid
  );
  return id;
}

describe("findUnmonitoredNoFile", () => {
  it("returns items that are both unmonitored and fileless", async () => {
    const { findUnmonitoredNoFile } = await import("../src/services/cleanupSuggestions.js");
    const id = await insertMediaItem({ title: "Abandoned Movie", monitored: 0, hasFile: 0 });

    const results = await findUnmonitoredNoFile();
    expect(results.some((r) => r.id === id)).toBe(true);
  });

  it("excludes items that are monitored, even without a file", async () => {
    const { findUnmonitoredNoFile } = await import("../src/services/cleanupSuggestions.js");
    const id = await insertMediaItem({ title: "Still Wanted Movie", monitored: 1, hasFile: 0 });

    const results = await findUnmonitoredNoFile();
    expect(results.some((r) => r.id === id)).toBe(false);
  });

  it("excludes unmonitored items that already have a file", async () => {
    const { findUnmonitoredNoFile } = await import("../src/services/cleanupSuggestions.js");
    const id = await insertMediaItem({ title: "Watched And Done Movie", monitored: 0, hasFile: 1 });

    const results = await findUnmonitoredNoFile();
    expect(results.some((r) => r.id === id)).toBe(false);
  });
});

describe("findDuplicateFiles", () => {
  it("returns no groups when there are no has_file media items", async () => {
    const { findDuplicateFiles } = await import("../src/services/cleanupSuggestions.js");
    const groups = await findDuplicateFiles();
    expect(groups).toEqual([]);
  });

  it("groups two movies whose files are byte-identical but live at different paths", async () => {
    const { findDuplicateFiles } = await import("../src/services/cleanupSuggestions.js");
    const pathA = writeFile("dupe-a.mkv", "identical payload for dupe test");
    const pathB = writeFile("dupe-b.mkv", "identical payload for dupe test");
    await insertMediaItem({ title: "Dupe Movie A", hasFile: 1, path: pathA });
    await insertMediaItem({ title: "Dupe Movie B", hasFile: 1, path: pathB });

    const groups = await findDuplicateFiles();
    const group = groups.find((g) => g.files.some((f) => f.path === pathA));
    expect(group).toBeDefined();
    expect(group!.files.map((f) => f.path).sort()).toEqual([pathA, pathB].sort());
  });

  it("does not group files that merely share a size but differ in content", async () => {
    const { findDuplicateFiles } = await import("../src/services/cleanupSuggestions.js");
    const pathA = writeFile("same-size-a.mkv", "AAAAAAAAAA");
    const pathB = writeFile("same-size-b.mkv", "BBBBBBBBBB");
    await insertMediaItem({ title: "Same Size Movie A", hasFile: 1, path: pathA });
    await insertMediaItem({ title: "Same Size Movie B", hasFile: 1, path: pathB });

    const groups = await findDuplicateFiles();
    expect(groups.some((g) => g.files.some((f) => f.path === pathA))).toBe(false);
    expect(groups.some((g) => g.files.some((f) => f.path === pathB))).toBe(false);
  });

  it("does not group a file that has no match at all", async () => {
    const { findDuplicateFiles } = await import("../src/services/cleanupSuggestions.js");
    const lonelyPath = writeFile("lonely.mkv", "nothing else matches this content");
    await insertMediaItem({ title: "Lonely Movie", hasFile: 1, path: lonelyPath });

    const groups = await findDuplicateFiles();
    expect(groups.some((g) => g.files.some((f) => f.path === lonelyPath))).toBe(false);
  });

  it("skips a media item whose file no longer exists on disk, without throwing", async () => {
    const { findDuplicateFiles } = await import("../src/services/cleanupSuggestions.js");
    await insertMediaItem({ title: "Ghost Movie", hasFile: 1, path: path.join(tmpDir, "does-not-exist.mkv") });

    await expect(findDuplicateFiles()).resolves.not.toThrow();
  });

  it("includes episode files, labeled with show title and SxxEyy", async () => {
    const { findDuplicateFiles } = await import("../src/services/cleanupSuggestions.js");
    const showId = await insertMediaItem({ type: "series", title: "Dupe Show" });
    const epPathA = writeFile("ep-a.mkv", "shared episode content");
    const epPathB = writeFile("ep-b.mkv", "shared episode content");
    await db
      .prepare(
        "INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, 3, 1, 1, ?)"
      )
      .run(showId, epPathA);
    // A different episode (S01E04) that happens to share byte-identical content with S01E03 — the
    // (media_item_id, season, episode) UNIQUE constraint means two dupe-content rows can never be
    // the *same* episode, so this is the realistic shape for an episode-level duplicate.
    await db
      .prepare(
        "INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, 4, 1, 1, ?)"
      )
      .run(showId, epPathB);

    const groups = await findDuplicateFiles();
    const group = groups.find((g) => g.files.some((f) => f.path === epPathA));
    expect(group).toBeDefined();
    expect(group!.files.find((f) => f.path === epPathA)!.label).toBe("Dupe Show — S01E03");
    expect(group!.files.find((f) => f.path === epPathB)!.label).toBe("Dupe Show — S01E04");
  });

  it("does not report a multi-episode file (one path stored on every episode it covers) as a duplicate of itself", async () => {
    const { findDuplicateFiles } = await import("../src/services/cleanupSuggestions.js");
    const showId = await insertMediaItem({ type: "series", title: "Multi Episode Show" });
    const multiEpPath = writeFile("multi-ep-s01e05-e06.mkv", "one physical double-episode file");
    for (const episode of [5, 6]) {
      await db
        .prepare(
          "INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, ?, 1, 1, ?)"
        )
        .run(showId, episode, multiEpPath);
    }

    const groups = await findDuplicateFiles();
    expect(groups.some((g) => g.files.some((f) => f.path === multiEpPath))).toBe(false);
  });

  it("lists a multi-episode file once, labeled with every episode it covers, when it does have a real copy elsewhere", async () => {
    const { findDuplicateFiles } = await import("../src/services/cleanupSuggestions.js");
    const showId = await insertMediaItem({ type: "series", title: "Copied Multi Show" });
    const multiEpPath = writeFile("copied-multi-ep.mkv", "double-episode file that also exists as a stray copy");
    const strayCopyPath = writeFile("stray-copy.mkv", "double-episode file that also exists as a stray copy");
    for (const episode of [7, 8]) {
      await db
        .prepare(
          "INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, ?, 1, 1, ?)"
        )
        .run(showId, episode, multiEpPath);
    }
    await insertMediaItem({ title: "Stray Copy Movie", hasFile: 1, path: strayCopyPath });

    const groups = await findDuplicateFiles();
    const group = groups.find((g) => g.files.some((f) => f.path === multiEpPath));
    expect(group).toBeDefined();
    expect(group!.files.map((f) => f.path).sort()).toEqual([multiEpPath, strayCopyPath].sort());
    const multiEpLabel = group!.files.find((f) => f.path === multiEpPath)!.label;
    expect(multiEpLabel.split(", ").sort()).toEqual(["Copied Multi Show — S01E07", "Copied Multi Show — S01E08"]);
  });

  it("includes sub-item files (e.g. albums), labeled with parent and child title", async () => {
    const { findDuplicateFiles } = await import("../src/services/cleanupSuggestions.js");
    const artistId = await insertMediaItem({ type: "artist", title: "Dupe Artist" });
    const subPathA = writeFile("sub-a.mp3", "shared album track content");
    const subPathB = writeFile("sub-b.mp3", "shared album track content");
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Dupe Album', 1, 1, ?)")
      .run(artistId, subPathA);
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Dupe Album', 1, 1, ?)")
      .run(artistId, subPathB);

    const groups = await findDuplicateFiles();
    const group = groups.find((g) => g.files.some((f) => f.path === subPathA));
    expect(group).toBeDefined();
    expect(group!.files.find((f) => f.path === subPathA)!.label).toBe("Dupe Artist — Dupe Album");
  });
});
