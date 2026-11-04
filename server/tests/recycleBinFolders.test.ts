import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
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
