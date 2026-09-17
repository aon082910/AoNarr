import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
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
