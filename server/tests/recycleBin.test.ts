import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let recycleBinDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  const { setSetting } = await import("../src/services/settingsStore.js");
  recycleBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-recyclebin-"));
  setSetting("recycleBinDir", recycleBinDir);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Forces moveFileAsync's cross-filesystem fallback path (fsp.cp + fsp.rm) to run instead of the
 * plain-rename happy path — the two temp dirs used in these tests normally live on the same real
 * filesystem, so without this, the exact code Round 227/228 fixed (which only runs on EXDEV) would
 * never actually execute during the test. */
function forceNextRenameToLookCrossDevice(): void {
  vi.spyOn(fsp, "rename").mockRejectedValueOnce(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
}

/** Restores run detached — polls until the entry is gone (restored) or no longer marked restoring
 * (failed), and returns whatever row is left. */
async function waitForRestoreToSettle(id: number): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE id = ?").get(id)) as any;
    if (!row || Number(row.restoring) === 0) return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`recycle_bin entry ${id} never finished restoring`);
}

async function recycleNewFile(name: string, content: string): Promise<{ src: string; row: any }> {
  const { recycleFile } = await import("../src/services/recycleBin.js");
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), name);
  fs.writeFileSync(src, content);
  await recycleFile(src, "movie", name, null);
  return { src, row: await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(src) };
}

// Must stay the first block in this file to touch restore/purge: the leftover-flag reset runs once
// per process, on the first such call.
describe("restore flags left behind by a restart", () => {
  it("are cleared the first time the recycle bin is used, without any explicit startup call", async () => {
    const { purgeExpiredRecycleBinEntries } = await import("../src/services/recycleBin.js");
    const { row } = await recycleNewFile("left-restoring.mkv", "x");
    await db.prepare("UPDATE recycle_bin SET restoring = 1 WHERE id = ?").run(row.id); // a restore the previous process never finished

    await purgeExpiredRecycleBinEntries();

    const after = (await db.prepare("SELECT restoring, restore_error FROM recycle_bin WHERE id = ?").get(row.id)) as any;
    expect(Number(after.restoring)).toBe(0);
    expect(after.restore_error).toMatch(/interrupted by a restart/i);
  });
});

describe("recycleFile / restore / purge — files", () => {
  it("moves a file into the recycle bin and records it", async () => {
    const { recycleFile } = await import("../src/services/recycleBin.js");
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), "movie.mkv");
    fs.writeFileSync(src, "fake video");

    await recycleFile(src, "movie", "Test Movie", null);

    expect(fs.existsSync(src)).toBe(false);
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(src)) as any;
    expect(row).toBeDefined();
    expect(fs.existsSync(row.recycle_path)).toBe(true);
    expect(fs.readFileSync(row.recycle_path, "utf-8")).toBe("fake video");
  });

  it("moves a file across a simulated filesystem boundary (EXDEV) without losing its content", async () => {
    const { recycleFile } = await import("../src/services/recycleBin.js");
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), "cross-fs.mkv");
    fs.writeFileSync(src, "cross-fs content");
    forceNextRenameToLookCrossDevice();

    await recycleFile(src, "movie", "Cross FS Movie", null);

    expect(fs.existsSync(src)).toBe(false);
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(src)) as any;
    expect(fs.readFileSync(row.recycle_path, "utf-8")).toBe("cross-fs content");
  });

  it("restores a file back to its original path", async () => {
    const { recycleFile, startRestoreFromRecycleBin } = await import("../src/services/recycleBin.js");
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), "restore-me.mkv");
    fs.writeFileSync(src, "restore content");
    await recycleFile(src, "movie", "Restore Movie", null);
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(src)) as any;

    await startRestoreFromRecycleBin(row.id);
    await new Promise((r) => setTimeout(r, 50)); // restore runs detached — give it a moment

    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readFileSync(src, "utf-8")).toBe("restore content");
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE id = ?").get(row.id)).toBeUndefined();
  });

  it("gives two same-named files recycled in the same millisecond distinct destinations, so neither overwrites the other", async () => {
    const { recycleFile } = await import("../src/services/recycleBin.js");
    const course = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-"));
    const first = path.join(course, "Lesson 1", "video.mp4");
    const second = path.join(course, "Lesson 2", "video.mp4");
    fs.mkdirSync(path.dirname(first));
    fs.mkdirSync(path.dirname(second));
    fs.writeFileSync(first, "lesson one");
    fs.writeFileSync(second, "lesson two");
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    await recycleFile(first, "course", "Course", null);
    await recycleFile(second, "course", "Course", null);

    const firstRow = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(first)) as any;
    const secondRow = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(second)) as any;
    expect(firstRow.recycle_path).not.toBe(secondRow.recycle_path);
    expect(fs.readFileSync(firstRow.recycle_path, "utf-8")).toBe("lesson one");
    expect(fs.readFileSync(secondRow.recycle_path, "utf-8")).toBe("lesson two");
  });

  it("refuses to restore over a file that now exists at the original path — records restore_error and keeps the entry", async () => {
    const { recycleFile, startRestoreFromRecycleBin } = await import("../src/services/recycleBin.js");
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), "redownloaded.mkv");
    fs.writeFileSync(src, "old recycled copy");
    await recycleFile(src, "movie", "Redownloaded Movie", null);
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(src)) as any;
    fs.writeFileSync(src, "newer download"); // a fresh copy landed at the same templated path

    await startRestoreFromRecycleBin(row.id);
    const settled = await waitForRestoreToSettle(row.id);

    expect(settled).toBeDefined();
    expect(settled.restoring).toBe(0);
    expect(settled.restore_error).toMatch(/already exists/i);
    expect(fs.readFileSync(src, "utf-8")).toBe("newer download");
    expect(fs.readFileSync(row.recycle_path, "utf-8")).toBe("old recycled copy");
  });

  it("purges a recycled file", async () => {
    const { recycleFile, purgeRecycleBinEntry } = await import("../src/services/recycleBin.js");
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), "purge-me.mkv");
    fs.writeFileSync(src, "x");
    await recycleFile(src, "movie", "Purge Movie", null);
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(src)) as any;

    await purgeRecycleBinEntry(row.id);

    expect(fs.existsSync(row.recycle_path)).toBe(false);
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE id = ?").get(row.id)).toBeUndefined();
  });
});

// Regression coverage for a real bug: Music's sub_items.file_path is a directory (a whole album
// folder), and the recycle bin's move/purge path used to assume a single file — copyFile/unlink
// both throw on a directory, so recycling/purging/restoring an album silently failed (swallowed as
// "already gone") and orphaned it on disk, untracked.
describe("recycleFile / restore / purge — directories (Music albums)", () => {
  async function makeAlbumDir(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-album-"));
    const albumDir = path.join(dir, "Album");
    fs.mkdirSync(albumDir);
    fs.writeFileSync(path.join(albumDir, "01 - Track One.mp3"), "track 1");
    fs.writeFileSync(path.join(albumDir, "02 - Track Two.mp3"), "track 2");
    return albumDir;
  }

  it("moves an entire album directory into the recycle bin intact", async () => {
    const { recycleFile } = await import("../src/services/recycleBin.js");
    const albumDir = await makeAlbumDir();

    await recycleFile(albumDir, "artist", "Test Album", null);

    expect(fs.existsSync(albumDir)).toBe(false);
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(albumDir)) as any;
    expect(fs.readdirSync(row.recycle_path).sort()).toEqual(["01 - Track One.mp3", "02 - Track Two.mp3"]);
  });

  it("moves an album directory across a simulated filesystem boundary (EXDEV) intact", async () => {
    const { recycleFile } = await import("../src/services/recycleBin.js");
    const albumDir = await makeAlbumDir();
    forceNextRenameToLookCrossDevice();

    await recycleFile(albumDir, "artist", "Cross FS Album", null);

    expect(fs.existsSync(albumDir)).toBe(false);
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(albumDir)) as any;
    expect(fs.readdirSync(row.recycle_path)).toHaveLength(2);
    expect(fs.readFileSync(path.join(row.recycle_path, "01 - Track One.mp3"), "utf-8")).toBe("track 1");
  });

  it("restores an album directory back to its original path", async () => {
    const { recycleFile, startRestoreFromRecycleBin } = await import("../src/services/recycleBin.js");
    const albumDir = await makeAlbumDir();
    await recycleFile(albumDir, "artist", "Restore Album", null);
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(albumDir)) as any;

    await startRestoreFromRecycleBin(row.id);
    await new Promise((r) => setTimeout(r, 50));

    expect(fs.readdirSync(albumDir)).toHaveLength(2);
  });

  it("purges a recycled album directory completely, not just the top-level entry", async () => {
    const { recycleFile, purgeRecycleBinEntry } = await import("../src/services/recycleBin.js");
    const albumDir = await makeAlbumDir();
    await recycleFile(albumDir, "artist", "Purge Album", null);
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(albumDir)) as any;

    await purgeRecycleBinEntry(row.id);

    expect(fs.existsSync(row.recycle_path)).toBe(false);
  });
});

describe("restoreAllFromRecycleBin / purgeAllRecycleBinEntries", () => {
  // Earlier describe blocks in this file deliberately leave some entries un-restored/un-purged
  // (to assert their leftover state), which would otherwise inflate these tests' exact counts —
  // start every test in this block from a clean table.
  beforeEach(async () => {
    const { purgeAllRecycleBinEntries } = await import("../src/services/recycleBin.js");
    await purgeAllRecycleBinEntries();
  });

  async function recycleTestFile(mediaType: string, title: string): Promise<{ src: string; id: number }> {
    const { recycleFile } = await import("../src/services/recycleBin.js");
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), `${title}.mkv`);
    fs.writeFileSync(src, "x");
    await recycleFile(src, mediaType, title, null);
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(src)) as any;
    return { src, id: row.id };
  }

  it("restores every entry of the given media type and leaves other types alone", async () => {
    const { restoreAllFromRecycleBin } = await import("../src/services/recycleBin.js");
    const movie1 = await recycleTestFile("movie", "Restore All Movie 1");
    const movie2 = await recycleTestFile("movie", "Restore All Movie 2");
    const series1 = await recycleTestFile("series", "Restore All Series 1");

    const result = await restoreAllFromRecycleBin("movie");
    await new Promise((r) => setTimeout(r, 50)); // restores run detached

    expect(result).toMatchObject({ started: 2, skipped: 0 });
    expect(fs.existsSync(movie1.src)).toBe(true);
    expect(fs.existsSync(movie2.src)).toBe(true);
    expect(fs.existsSync(series1.src)).toBe(false); // untouched — different media type
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE id = ?").get(series1.id)).toBeDefined();
  });

  it("restore-all skips an entry already restoring instead of failing the whole batch", async () => {
    const { restoreAllFromRecycleBin, startRestoreFromRecycleBin } = await import("../src/services/recycleBin.js");
    const alreadyRestoring = await recycleTestFile("movie", "Already Restoring");
    const normal = await recycleTestFile("movie", "Normal Restore");
    await startRestoreFromRecycleBin(alreadyRestoring.id); // marks it restoring = 1

    const result = await restoreAllFromRecycleBin("movie");
    await new Promise((r) => setTimeout(r, 50));

    expect(result.started).toBe(1);
    expect(fs.existsSync(normal.src)).toBe(true);
  });

  it("restores only the newest entry when the same original path was recycled more than once", async () => {
    const { recycleFile, restoreAllFromRecycleBin } = await import("../src/services/recycleBin.js");
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), "recycled-twice.mkv");
    fs.writeFileSync(src, "first download");
    await recycleFile(src, "movie", "Recycled Twice", null);
    fs.writeFileSync(src, "second download");
    await recycleFile(src, "movie", "Recycled Twice", null);
    const [older, newer] = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ? ORDER BY id").all(src)) as any[];

    const result = await restoreAllFromRecycleBin("movie");
    await waitForRestoreToSettle(newer.id);

    expect(result).toEqual({ started: 1, skipped: 1 });
    expect(fs.readFileSync(src, "utf-8")).toBe("second download");
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE id = ?").get(newer.id)).toBeUndefined();
    // The older copy is left in the bin for the admin to decide on, not raced onto the same path.
    const olderRow = (await db.prepare("SELECT * FROM recycle_bin WHERE id = ?").get(older.id)) as any;
    expect(olderRow).toBeDefined();
    expect(Number(olderRow.restoring)).toBe(0);
    expect(olderRow.restore_error).toBeNull();
    expect(fs.readFileSync(older.recycle_path, "utf-8")).toBe("first download");
  });

  it("purges every entry of the given media type and leaves other types alone", async () => {
    const { purgeAllRecycleBinEntries } = await import("../src/services/recycleBin.js");
    const movie1 = await recycleTestFile("movie", "Purge All Movie 1");
    const series1 = await recycleTestFile("series", "Purge All Series 1");
    const row1 = (await db.prepare("SELECT recycle_path FROM recycle_bin WHERE id = ?").get(movie1.id)) as any;

    const result = await purgeAllRecycleBinEntries("movie");

    expect(result).toMatchObject({ purged: 1, skipped: 0 });
    expect(fs.existsSync(row1.recycle_path)).toBe(false);
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE id = ?").get(movie1.id)).toBeUndefined();
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE id = ?").get(series1.id)).toBeDefined();
  });

  it("purge-all skips (not fails) an entry currently restoring", async () => {
    const { purgeAllRecycleBinEntries } = await import("../src/services/recycleBin.js");
    const restoring = await recycleTestFile("movie", "Restoring During Purge All");
    // Sets the flag directly rather than going through startRestoreFromRecycleBin's real
    // fire-and-forget restore — that restore's own async completion (mkdir + move + DELETE) races
    // against this test's purgeAllRecycleBinEntries call with no way to guarantee which finishes
    // first, and a real Postgres server's network round-trips shift that race unpredictably (this
    // was flaky in CI). Directly marking the row `restoring` and never resolving it exercises the
    // exact same guard purgeRecycleBinEntry checks, deterministically.
    await db.prepare("UPDATE recycle_bin SET restoring = 1 WHERE id = ?").run(restoring.id);

    const result = await purgeAllRecycleBinEntries("movie");

    expect(result.skipped).toBe(1);
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE id = ?").get(restoring.id)).toBeDefined();

    // Never resolves on its own (nothing is actually restoring it) — clean it up directly rather
    // than leaving a permanently-stuck "restoring" row in the shared test table for every test
    // after this one.
    await db.prepare("DELETE FROM recycle_bin WHERE id = ?").run(restoring.id);
  });

  it("with no mediaType filter, restores/purges across every type", async () => {
    const { purgeAllRecycleBinEntries } = await import("../src/services/recycleBin.js");
    const movie1 = await recycleTestFile("movie", "Purge All Any Movie");
    const series1 = await recycleTestFile("series", "Purge All Any Series");

    const result = await purgeAllRecycleBinEntries();

    expect(result.purged).toBeGreaterThanOrEqual(2);
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE id = ?").get(movie1.id)).toBeUndefined();
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE id = ?").get(series1.id)).toBeUndefined();
  });
});

describe("recycleFile — symlinks, unreachable files and failed bookkeeping", () => {
  it("moves a dangling symlink (its mount is down) into the bin as a link instead of deleting it", async () => {
    const { recycleFile } = await import("../src/services/recycleBin.js");
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-mount-")), "gone", "movie.mkv");
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), "linked.mkv");
    fs.symlinkSync(target, link);

    expect(await recycleFile(link, "movie", "Linked Movie", null)).toBe(true);

    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(link)) as any;
    expect(row).toBeDefined();
    expect(fs.lstatSync(row.recycle_path).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(row.recycle_path)).toBe(target);
    expect(() => fs.lstatSync(link)).toThrow();
  });

  it("leaves a file it can't reach (a dead mount) in place instead of deleting it", async () => {
    const { recycleFile } = await import("../src/services/recycleBin.js");
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), "unreachable.mkv");
    fs.writeFileSync(src, "still needed");
    const notConnected = Object.assign(new Error("Transport endpoint is not connected"), { code: "ENOTCONN" });
    vi.spyOn(fsp, "stat").mockRejectedValue(notConnected);
    vi.spyOn(fsp, "lstat").mockRejectedValue(notConnected);
    const rm = vi.spyOn(fsp, "rm");

    expect(await recycleFile(src, "movie", "Unreachable", null)).toBe(false);

    expect(rm).not.toHaveBeenCalled();
    expect(fs.readFileSync(src, "utf-8")).toBe("still needed");
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE original_path = ?").get(src)).toBeUndefined();
  });

  it("moves the file back when its recycle_bin row can't be written, so it isn't stranded untracked in the bin", async () => {
    const { recycleFile } = await import("../src/services/recycleBin.js");
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), "unrecorded-movie.mkv");
    fs.writeFileSync(src, "keep me");

    // No such media item, so the INSERT fails its foreign key after the file has already moved.
    expect(await recycleFile(src, "movie", "Unrecorded", 987654321)).toBe(false);

    expect(fs.readFileSync(src, "utf-8")).toBe("keep me");
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE original_path = ?").get(src)).toBeUndefined();
    expect(fs.readdirSync(path.join(recycleBinDir, "movie")).filter((f) => f.endsWith("-unrecorded-movie.mkv"))).toEqual([]);
  });
});

describe("interrupted restores", () => {
  it("resetInterruptedRestores clears a stale flag and removes a leftover partial copy, so the entry restores normally", async () => {
    const { resetInterruptedRestores, startRestoreFromRecycleBin } = await import("../src/services/recycleBin.js");
    const { src, row } = await recycleNewFile("cut-off.mkv", "full content");
    const partial = path.join(path.dirname(src), `.cut-off.mkv.aonarr-restore-${row.id}.partial`);
    fs.writeFileSync(partial, "full con"); // the copy the restart cut off
    await db.prepare("UPDATE recycle_bin SET restoring = 1 WHERE id = ?").run(row.id);

    expect(await resetInterruptedRestores()).toBeGreaterThanOrEqual(1);

    const after = (await db.prepare("SELECT restoring, restore_error FROM recycle_bin WHERE id = ?").get(row.id)) as any;
    expect(Number(after.restoring)).toBe(0);
    expect(after.restore_error).toMatch(/interrupted by a restart/i);
    expect(fs.existsSync(partial)).toBe(false);

    await startRestoreFromRecycleBin(row.id);
    expect(await waitForRestoreToSettle(row.id)).toBeUndefined();
    expect(fs.readFileSync(src, "utf-8")).toBe("full content");
  });

  it("drops the entry when the restart hit after the file was already back in place", async () => {
    const { resetInterruptedRestores } = await import("../src/services/recycleBin.js");
    const { src, row } = await recycleNewFile("already-back.mkv", "restored");
    fs.renameSync(row.recycle_path, src); // the move finished; only the row delete was lost
    await db.prepare("UPDATE recycle_bin SET restoring = 1 WHERE id = ?").run(row.id);

    await resetInterruptedRestores();

    expect(await db.prepare("SELECT id FROM recycle_bin WHERE id = ?").get(row.id)).toBeUndefined();
    expect(fs.readFileSync(src, "utf-8")).toBe("restored");
  });

  it("leaves a restore running in this process alone", async () => {
    const { resetInterruptedRestores, startRestoreFromRecycleBin } = await import("../src/services/recycleBin.js");
    const { src, row } = await recycleNewFile("in-flight.mkv", "moving");
    let finishMove!: () => void;
    const moveMayFinish = new Promise<void>((resolve) => (finishMove = resolve));
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementationOnce(async (from, to) => {
      await moveMayFinish;
      return realRename(from, to);
    });
    await startRestoreFromRecycleBin(row.id);

    await resetInterruptedRestores();

    const during = (await db.prepare("SELECT restoring, restore_error FROM recycle_bin WHERE id = ?").get(row.id)) as any;
    expect(Number(during.restoring)).toBe(1);
    expect(during.restore_error).toBeNull();
    finishMove();
    expect(await waitForRestoreToSettle(row.id)).toBeUndefined();
    expect(fs.readFileSync(src, "utf-8")).toBe("moving");
  });

  it("a cross-device restore that fails partway leaves nothing at the original path, and a retry succeeds", async () => {
    const { startRestoreFromRecycleBin } = await import("../src/services/recycleBin.js");
    const { src, row } = await recycleNewFile("cross-device-restore.mkv", "whole file");
    forceNextRenameToLookCrossDevice();
    vi.spyOn(fsp, "cp").mockImplementationOnce(async (_from, to) => {
      fs.writeFileSync(String(to), "whole"); // part of the copy lands, then the disk errors
      throw Object.assign(new Error("i/o error"), { code: "EIO" });
    });

    await startRestoreFromRecycleBin(row.id);
    const failed = await waitForRestoreToSettle(row.id);

    expect(failed.restore_error).toMatch(/i\/o error/);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readdirSync(path.dirname(src))).toEqual([]);

    forceNextRenameToLookCrossDevice();
    await startRestoreFromRecycleBin(row.id);
    expect(await waitForRestoreToSettle(row.id)).toBeUndefined();
    expect(fs.readFileSync(src, "utf-8")).toBe("whole file");
    expect(fs.readdirSync(path.dirname(src))).toEqual(["cross-device-restore.mkv"]);
  });
});

describe("recycleFile with the recycle bin disabled", () => {
  it("deletes a file outright instead of moving it", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { recycleFile } = await import("../src/services/recycleBin.js");
    setSetting("recycleBinEnabled", "0");
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-src-")), "disabled.mkv");
    fs.writeFileSync(src, "x");

    await recycleFile(src, "movie", "Disabled Bin Movie", null);

    expect(fs.existsSync(src)).toBe(false);
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE original_path = ?").get(src)).toBeUndefined();
    setSetting("recycleBinEnabled", "1");
  });

  it("deletes a directory outright (not just a file) when disabled", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { recycleFile } = await import("../src/services/recycleBin.js");
    setSetting("recycleBinEnabled", "0");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-album-"));
    const albumDir = path.join(dir, "Album");
    fs.mkdirSync(albumDir);
    fs.writeFileSync(path.join(albumDir, "track.mp3"), "x");

    await recycleFile(albumDir, "artist", "Disabled Bin Album", null);

    expect(fs.existsSync(albumDir)).toBe(false);
    setSetting("recycleBinEnabled", "1");
  });
});
