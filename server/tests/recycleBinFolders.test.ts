import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let tmp: string;
let recycleFile: (typeof import("../src/services/recycleBin.js"))["recycleFile"];
let startRestoreFromRecycleBin: (typeof import("../src/services/recycleBin.js"))["startRestoreFromRecycleBin"];
let directorySizeAsync: (typeof import("../src/services/fsAsync.js"))["directorySizeAsync"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  const { setSetting } = await import("../src/services/settingsStore.js");
  ({ recycleFile, startRestoreFromRecycleBin } = await import("../src/services/recycleBin.js"));
  ({ directorySizeAsync } = await import("../src/services/fsAsync.js"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-bin-folders-"));
  setSetting("recycleBinDir", path.join(tmp, "bin"));
  setSetting("recycleBinEnabled", "1");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.prepare("DELETE FROM recycle_bin").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function settled(id: number): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const row = (await db.prepare("SELECT * FROM recycle_bin WHERE id = ?").get(id)) as any;
    if (!row || Number(row.restoring) === 0) return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`entry ${id} never finished restoring`);
}

const entryFor = async (original: string) => (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(original)) as any;

/** A title folder whose episode file is recycled on its own, then the folder with what is left (a poster and an NFO). */
async function recycleTitleFolder(name: string) {
  const folder = path.join(tmp, "lib", name);
  const file = write(path.join(folder, "Movie.mkv"), "episode-bytes");
  write(path.join(folder, "poster.jpg"), "poster");
  write(path.join(folder, "extras", "movie.nfo"), "nfo!");
  await recycleFile(file, "movie", name, null);
  await recycleFile(folder, "movie", `${name} (folder)`, null);
  return { folder, file, fileEntry: await entryFor(file), folderEntry: await entryFor(folder) };
}

describe("a recycled folder entry shows what is in it (round 30c)", () => {
  it("records the total of its files, not the folder's own 4 KB", async () => {
    const { folderEntry } = await recycleTitleFolder("Sized");

    expect(Number(folderEntry.size_bytes)).toBe("poster".length + "nfo!".length);
  });

  it("counts a folder's files in nested folders, within bounds", async () => {
    const dir = path.join(tmp, "count");
    for (let i = 0; i < 5; i++) write(path.join(dir, `d${i}`, "f.bin"), "12345");

    expect(await directorySizeAsync(dir)).toEqual({ bytes: 25, complete: true });
    const bounded = await directorySizeAsync(dir, { maxEntries: 3 });
    expect(bounded.complete).toBe(false);
    expect(bounded.bytes).toBeLessThanOrEqual(25);
  });
});

describe("restoring a file or a folder in either order (round 30c)", () => {
  it("restores a file while the folder it came from is still in the bin, creating its folder", async () => {
    const { folder, file, fileEntry } = await recycleTitleFolder("FileFirst");
    expect(fs.existsSync(folder)).toBe(false);

    await startRestoreFromRecycleBin(Number(fileEntry.id));
    expect(await settled(Number(fileEntry.id))).toBeUndefined();

    expect(fs.readFileSync(file, "utf-8")).toBe("episode-bytes");
    // The folder's own entry is still there to be restored.
    expect(await entryFor(folder)).toBeTruthy();
  });

  it("then restores the folder by merging into the folder the file made, replacing nothing", async () => {
    const { folder, file, fileEntry, folderEntry } = await recycleTitleFolder("MergeBack");
    await startRestoreFromRecycleBin(Number(fileEntry.id));
    await settled(Number(fileEntry.id));

    await startRestoreFromRecycleBin(Number(folderEntry.id));
    expect(await settled(Number(folderEntry.id))).toBeUndefined();

    expect(fs.readFileSync(file, "utf-8")).toBe("episode-bytes");
    expect(fs.readFileSync(path.join(folder, "poster.jpg"), "utf-8")).toBe("poster");
    expect(fs.readFileSync(path.join(folder, "extras", "movie.nfo"), "utf-8")).toBe("nfo!");
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM recycle_bin").get()) as any).c)).toBe(0);
  });

  it("keeps a file the merge would have replaced in the bin, and says so", async () => {
    const { folder, folderEntry } = await recycleTitleFolder("Conflict");
    write(path.join(folder, "poster.jpg"), "a newer poster");

    await startRestoreFromRecycleBin(Number(folderEntry.id));
    const left = await settled(Number(folderEntry.id));

    expect(fs.readFileSync(path.join(folder, "poster.jpg"), "utf-8")).toBe("a newer poster");
    expect(fs.readFileSync(path.join(folder, "extras", "movie.nfo"), "utf-8")).toBe("nfo!");
    expect(left.restore_error).toMatch(/1 file\(s\) in it already exist/);
    expect(fs.existsSync(left.recycle_path)).toBe(true);
  });

  it("restoring the folder first brings back the files recycled from beneath it too", async () => {
    const { folder, file, folderEntry, fileEntry } = await recycleTitleFolder("FolderFirst");

    await startRestoreFromRecycleBin(Number(folderEntry.id));
    expect(await settled(Number(folderEntry.id))).toBeUndefined();
    // The restore of what was beneath it runs on its own right after.
    expect(await settled(Number(fileEntry.id))).toBeUndefined();

    expect(fs.readFileSync(file, "utf-8")).toBe("episode-bytes");
    expect(fs.readFileSync(path.join(folder, "poster.jpg"), "utf-8")).toBe("poster");
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM recycle_bin").get()) as any).c)).toBe(0);
  });

  it("still refuses to put a single file over one that is already there", async () => {
    const file = write(path.join(tmp, "lib", "Single", "a.mkv"), "old");
    await recycleFile(file, "movie", "Single", null);
    write(file, "newer");
    const entry = await entryFor(file);

    await startRestoreFromRecycleBin(Number(entry.id));
    const after = await settled(Number(entry.id));

    expect(after.restore_error).toMatch(/already exists/);
    expect(fs.readFileSync(file, "utf-8")).toBe("newer");
  });
});

/** A bin entry's recycle time, moved back by `seconds` (the table keeps UTC text, "YYYY-MM-DD HH:MM:SS"). */
async function recycledAgo(id: number, seconds: number): Promise<void> {
  const text = new Date(Date.now() - seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
  await db.prepare("UPDATE recycle_bin SET deleted_at = ? WHERE id = ?").run(text, id);
}

describe("restoring a folder brings back only what was recycled with it (round 30c review M5)", () => {
  it("leaves an older file beneath the folder in the bin (an upgrade's replaced file)", async () => {
    const folder = path.join(tmp, "lib", "Upgraded");
    const old720 = write(path.join(folder, "Movie.720p.mkv"), "old quality");
    await recycleFile(old720, "movie", "Upgraded", null);
    const oldEntry = await entryFor(old720);
    await recycledAgo(Number(oldEntry.id), 3 * 24 * 3600);
    const current = write(path.join(folder, "Movie.1080p.mkv"), "current");
    await recycleFile(current, "movie", "Upgraded", null);
    write(path.join(folder, "poster.jpg"), "poster");
    await recycleFile(folder, "movie", "Upgraded (folder)", null);
    const folderEntry = await entryFor(folder);
    const currentEntry = await entryFor(current);

    await startRestoreFromRecycleBin(Number(folderEntry.id));
    await settled(Number(folderEntry.id));
    expect(await settled(Number(currentEntry.id))).toBeUndefined();

    expect(fs.readFileSync(current, "utf-8")).toBe("current");
    expect(fs.existsSync(old720)).toBe(false);
    const stillThere = await entryFor(old720);
    expect(stillThere).toBeTruthy();
    expect(fs.existsSync(stillThere.recycle_path)).toBe(true);
  });

  it("leaves an entry of another title beneath the folder, even one recycled just now", async () => {
    const a = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'Mine', 'mine', 1, 0, 'unknown')").run()).lastInsertRowid);
    const b = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'Theirs', 'theirs', 1, 0, 'unknown')").run()).lastInsertRowid);
    const folder = path.join(tmp, "lib", "Shared");
    const mine = write(path.join(folder, "Mine.mkv"), "mine");
    const theirs = write(path.join(folder, "Theirs.mkv"), "theirs");
    await recycleFile(mine, "movie", "Mine", a);
    await recycleFile(theirs, "movie", "Theirs", b);
    write(path.join(folder, "poster.jpg"), "poster");
    await recycleFile(folder, "movie", "Mine (folder)", a);
    const folderEntry = await entryFor(folder);
    const mineEntry = await entryFor(mine);

    await startRestoreFromRecycleBin(Number(folderEntry.id));
    await settled(Number(folderEntry.id));
    expect(await settled(Number(mineEntry.id))).toBeUndefined();

    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.existsSync(theirs)).toBe(false);
    expect(await entryFor(theirs)).toBeTruthy();
  });

  it("restores the files recycled with the folder one after the other, not all at once", async () => {
    const folder = path.join(tmp, "lib", "Many");
    const files = ["a", "b", "c"].map((n) => write(path.join(folder, `${n}.mkv`), n));
    for (const f of files) await recycleFile(f, "movie", "Many", null);
    write(path.join(folder, "poster.jpg"), "poster");
    await recycleFile(folder, "movie", "Many (folder)", null);
    const folderEntry = await entryFor(folder);

    let inFlight = 0;
    let most = 0;
    const real = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation((async (a: any, b: any) => {
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 15));
        return await real(a, b);
      } finally {
        inFlight--;
      }
    }) as any);

    await startRestoreFromRecycleBin(Number(folderEntry.id));
    for (let i = 0; i < 300 && Number(((await db.prepare("SELECT COUNT(*) AS c FROM recycle_bin").get()) as any).c) > 0; i++) await new Promise((r) => setTimeout(r, 20));

    for (const f of files) expect(fs.existsSync(f)).toBe(true);
    expect(most).toBe(1);
  });
});

describe("the size of a recycled folder (round 30c review L7)", () => {
  it("is counted after the folder has moved, and is not recorded when the count is incomplete", async () => {
    const folder = path.join(tmp, "lib", "Locked");
    write(path.join(folder, "a.bin"), "12345");
    write(path.join(folder, "locked", "b.bin"), "123");
    const realReaddir = fsp.readdir.bind(fsp);
    let folderStillThereAtFirstWalk: boolean | null = null;
    vi.spyOn(fsp, "readdir").mockImplementation(((p: any, ...rest: any[]) => {
      if (folderStillThereAtFirstWalk === null && String(p).startsWith(path.join(tmp, "bin"))) folderStillThereAtFirstWalk = fs.existsSync(folder);
      if (String(p).endsWith(path.sep + "locked")) return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      return (realReaddir as any)(p, ...rest);
    }) as any);

    await recycleFile(folder, "movie", "Locked", null);

    const entry = await entryFor(folder);
    expect(folderStillThereAtFirstWalk).toBe(false);
    expect(entry.size_bytes).toBeNull();
  });
});
