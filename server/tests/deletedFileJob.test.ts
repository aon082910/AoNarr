import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

vi.mock("../src/services/ffprobe.js", () => ({ probeMediaInfo: vi.fn().mockResolvedValue(null) }));
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return { ...actual, searchMetadata: vi.fn().mockResolvedValue([]) };
});

// Passes through to the real follow-up scan, but lets a test look at the state while it runs, make it fail or cancel it.
const scanHook = vi.hoisted(() => ({
  calls: 0,
  before: null as null | ((signal?: AbortSignal) => Promise<void> | void),
}));
vi.mock("../src/services/libraryScan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/libraryScan.js")>();
  return {
    ...actual,
    scanAndImportAllLibraries: vi.fn(async (signal?: AbortSignal) => {
      scanHook.calls++;
      await scanHook.before?.(signal);
      return actual.scanAndImportAllLibraries(signal);
    }),
  };
});

// Passes through to the real existence check, except for the paths a test makes "stop answering" (a dead mount).
const storageHook = vi.hoisted(() => ({ hangingPaths: new Set<string>() }));
vi.mock("../src/services/fsAsync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/fsAsync.js")>();
  return {
    ...actual,
    pathExistsAsync: (target: string, timeoutMs?: number) => {
      if (storageHook.hangingPaths.has(target)) return Promise.reject(new actual.StorageTimeoutError(target, 30_000));
      return actual.pathExistsAsync(target, timeoutMs);
    },
  };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let getSetting: (typeof import("../src/services/settingsStore.js"))["getSetting"];
let runDeletedFileCheckJob: (typeof import("../src/services/deletedFileJob.js"))["runDeletedFileCheckJob"];
let root: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting, getSetting } = await import("../src/services/settingsStore.js"));
  ({ runDeletedFileCheckJob } = await import("../src/services/deletedFileJob.js"));
});

beforeEach(async () => {
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM sub_items").run();
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM root_folders").run();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedjob-"));
  await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'movie', 'movie')").run(root);
});

afterEach(() => {
  setSetting("unmonitorDeletedFiles", "0");
  fs.rmSync(root, { recursive: true, force: true });
});

async function insertMovie(title: string, year: number, filePath: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, path, status) VALUES ('movie', ?, ?, ?, 1, 1, ?, 'downloaded')`)
        .run(title, title.toLowerCase(), year, filePath)
    ).lastInsertRowid
  );
}

function writeFile(...parts: string[]): string {
  const p = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "fake bytes");
  return p;
}

describe("runDeletedFileCheckJob — a file that only moved (MM6)", () => {
  it("re-links the file in the same run instead of leaving the title missing until the next scan", async () => {
    const oldPath = path.join(root, "Old Folder", "Dune.2021.1080p.mkv"); // another tool moved it...
    const moved = writeFile("New Folder", "Dune.2021.1080p.mkv"); // ...here
    const id = await insertMovie("Dune", 2021, oldPath);

    await runDeletedFileCheckJob();

    const row = (await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(id)) as any;
    expect(Number(row.has_file)).toBe(1);
    expect(row.path).toBe(moved);
    expect(Number(row.monitored)).toBe(1);
  });

  it("applies Unmonitor Deleted only to the files that are really gone, not the ones that moved", async () => {
    setSetting("unmonitorDeletedFiles", "1");
    const moved = writeFile("New Folder", "Dune.2021.1080p.mkv");
    const movedId = await insertMovie("Dune", 2021, path.join(root, "Old Folder", "Dune.2021.1080p.mkv"));
    const goneId = await insertMovie("Gone Movie", 2019, path.join(root, "Gone Movie (2019)", "Gone.Movie.2019.mkv"));
    writeFile("Keep", "Keep.This.2018.mkv"); // keeps the root folder populated, so it is not read as an offline mount

    await runDeletedFileCheckJob();

    const movedRow = (await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(movedId)) as any;
    expect(Number(movedRow.has_file)).toBe(1);
    expect(movedRow.path).toBe(moved);
    expect(Number(movedRow.monitored)).toBe(1);
    const goneRow = (await db.prepare("SELECT has_file, monitored FROM media_items WHERE id = ?").get(goneId)) as any;
    expect(Number(goneRow.has_file)).toBe(0);
    expect(Number(goneRow.monitored)).toBe(0);
  });

  it("does not scan the library when nothing is missing", async () => {
    const present = writeFile("Dune (2021)", "Dune.2021.1080p.mkv");
    await insertMovie("Dune", 2021, present);
    writeFile("Unlinked Movie (2020)", "Unlinked.Movie.2020.mkv"); // a scan would create an item for this

    await runDeletedFileCheckJob();

    const rows = (await db.prepare("SELECT title FROM media_items WHERE type='movie'").all()) as any[];
    expect(rows.map((r) => r.title)).toEqual(["Dune"]);
  });
});

const PENDING_KEY = "deletedFilePendingUnmonitor";

type PendingRows = { mediaItems: number[]; episodes: number[]; subItems: number[] };

const readPending = (): PendingRows | null => {
  const raw = getSetting(PENDING_KEY);
  return raw ? (JSON.parse(raw) as PendingRows) : null;
};

const movieRow = async (id: number) => {
  const row = (await db.prepare("SELECT has_file, monitored, path FROM media_items WHERE id = ?").get(id)) as any;
  return { hasFile: Number(row.has_file), monitored: Number(row.monitored), path: row.path as string | null };
};

describe("runDeletedFileCheckJob — keeping the cleared rows until they are unmonitored (pending setting)", () => {
  beforeEach(() => {
    scanHook.calls = 0;
    scanHook.before = null;
    storageHook.hangingPaths.clear();
    setSetting(PENDING_KEY, "");
    setSetting("lastFullScanAt", "");
    setSetting("unmonitorDeletedFiles", "1");
    writeFile("Keep", "Keep.This.2018.mkv"); // keeps the root folder populated, so it is not read as an offline mount
  });

  afterEach(() => {
    scanHook.before = null;
    storageHook.hangingPaths.clear();
    setSetting(PENDING_KEY, "");
    vi.restoreAllMocks();
  });

  const goneMoviePath = (name: string) => path.join(root, `${name} (2019)`, `${name}.2019.mkv`);

  it("stores the rows the check cleared while the follow-up scan runs, holds their monitoring, and clears the setting once they are unmonitored", async () => {
    const goneId = await insertMovie("Gone Movie", 2019, goneMoviePath("Gone"));
    let duringScan: { pending: PendingRows | null; row: Awaited<ReturnType<typeof movieRow>> } | null = null;
    scanHook.before = async () => {
      duringScan = { pending: readPending(), row: await movieRow(goneId) };
    };

    await runDeletedFileCheckJob();

    expect(scanHook.calls).toBe(1);
    expect(duringScan!.pending).toEqual({ mediaItems: [goneId], episodes: [], subItems: [] });
    expect(duringScan!.row).toMatchObject({ hasFile: 0, monitored: 1, path: null }); // cleared, but still monitored until the scan has had its look
    expect(await movieRow(goneId)).toMatchObject({ hasFile: 0, monitored: 0 });
    expect(readPending()).toBeNull();
  });

  it("keeps cleared episodes and sub-items pending too, and unmonitors them afterwards", async () => {
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES ('series', 'Gone Show', 'gone show', 2020, 1, 1, 'downloaded')`).run())
        .lastInsertRowid
    );
    const episodeId = Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?, 1, 1, 'Pilot', 1, 1, ?)")
          .run(showId, path.join(root, "Gone Show", "Season 01", "Gone.Show.S01E01.mkv"))
      ).lastInsertRowid
    );
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Gone Artist', 'gone artist', 1, 1, 'downloaded')`).run())
        .lastInsertRowid
    );
    const albumId = Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Gone Album', 1, 1, ?)")
          .run(artistId, path.join(root, "Gone Artist", "Gone Album"))
      ).lastInsertRowid
    );
    let duringScan: PendingRows | null = null;
    scanHook.before = () => {
      duringScan = readPending();
    };

    await runDeletedFileCheckJob();

    expect(duringScan).toEqual({ mediaItems: [], episodes: [episodeId], subItems: [albumId] });
    const episode = (await db.prepare("SELECT has_file, monitored FROM episodes WHERE id = ?").get(episodeId)) as any;
    const album = (await db.prepare("SELECT has_file, monitored FROM sub_items WHERE id = ?").get(albumId)) as any;
    expect([Number(episode.has_file), Number(episode.monitored)]).toEqual([0, 0]);
    expect([Number(album.has_file), Number(album.monitored)]).toEqual([0, 0]);
    expect(readPending()).toBeNull();
  });

  it("stores nothing and does not scan when nothing is missing and nothing is pending", async () => {
    const present = writeFile("Dune (2021)", "Dune.2021.1080p.mkv");
    await insertMovie("Dune", 2021, present);

    await runDeletedFileCheckJob();

    expect(scanHook.calls).toBe(0);
    expect(readPending()).toBeNull();
  });

  describe("rows left pending by an earlier run that was cut off", () => {
    /** A movie the earlier run's check had already cleared (so the next check no longer sees it as missing). */
    async function insertClearedMovie(title: string, year: number): Promise<number> {
      const id = await insertMovie(title, year, path.join(root, "never-used", `${title}.mkv`));
      await db.prepare("UPDATE media_items SET has_file = 0, path = NULL, status = 'missing' WHERE id = ?").run(id);
      return id;
    }

    it("scans first and unmonitors them together with the rows the new check cleared", async () => {
      const leftoverId = await insertClearedMovie("Leftover Movie", 2017);
      const newId = await insertMovie("Newly Gone", 2019, goneMoviePath("Newly Gone"));
      setSetting(PENDING_KEY, JSON.stringify({ mediaItems: [leftoverId], episodes: [], subItems: [] }));
      let duringScan: PendingRows | null = null;
      let leftoverDuringScan: Awaited<ReturnType<typeof movieRow>> | null = null;
      scanHook.before = async () => {
        duringScan = readPending();
        leftoverDuringScan = await movieRow(leftoverId);
      };

      await runDeletedFileCheckJob();

      expect(duringScan!.mediaItems.slice().sort()).toEqual([leftoverId, newId].sort());
      expect(leftoverDuringScan).toMatchObject({ hasFile: 0, monitored: 1 }); // not unmonitored before the scan
      expect(await movieRow(leftoverId)).toMatchObject({ hasFile: 0, monitored: 0 });
      expect(await movieRow(newId)).toMatchObject({ hasFile: 0, monitored: 0 });
      expect(readPending()).toBeNull();
    });

    it("scans for them even though nothing new is missing, then unmonitors them", async () => {
      const leftoverId = await insertClearedMovie("Leftover Alone", 2016);
      setSetting(PENDING_KEY, JSON.stringify({ mediaItems: [leftoverId], episodes: [], subItems: [] }));

      await runDeletedFileCheckJob();

      expect(scanHook.calls).toBe(1);
      expect(await movieRow(leftoverId)).toMatchObject({ hasFile: 0, monitored: 0 });
      expect(readPending()).toBeNull();
    });

    it("does not unmonitor one whose file the scan found again", async () => {
      const leftoverId = await insertClearedMovie("Dune", 2021);
      const relinked = writeFile("Dune (2021)", "Dune.2021.1080p.mkv");
      setSetting(PENDING_KEY, JSON.stringify({ mediaItems: [leftoverId], episodes: [], subItems: [] }));

      await runDeletedFileCheckJob();

      expect(await movieRow(leftoverId)).toMatchObject({ hasFile: 1, monitored: 1, path: relinked });
      expect(readPending()).toBeNull();
    });

    it("clears them without unmonitoring when Unmonitor Deleted is off", async () => {
      setSetting("unmonitorDeletedFiles", "0");
      const leftoverId = await insertClearedMovie("Leftover Kept", 2015);
      setSetting(PENDING_KEY, JSON.stringify({ mediaItems: [leftoverId], episodes: [], subItems: [] }));

      await runDeletedFileCheckJob();

      expect(await movieRow(leftoverId)).toMatchObject({ hasFile: 0, monitored: 1 });
      expect(readPending()).toBeNull();
    });

    it("ignores a pending setting that cannot be read, and does not scan for it", async () => {
      setSetting(PENDING_KEY, "this is not json");

      await expect(runDeletedFileCheckJob()).resolves.toBeUndefined();

      expect(scanHook.calls).toBe(0);
    });

    it("keeps only whole-number ids from the pending setting", async () => {
      const leftoverId = await insertClearedMovie("Leftover Ids", 2014);
      setSetting(PENDING_KEY, JSON.stringify({ mediaItems: [leftoverId, String(leftoverId + 1), "not a number", null, "", true, 1.5, -3, 0], episodes: "oops" }));
      let duringScan: PendingRows | null = null;
      scanHook.before = () => {
        duringScan = readPending();
      };

      await runDeletedFileCheckJob();

      expect(scanHook.calls).toBe(1);
      expect(duringScan).toEqual({ mediaItems: [leftoverId], episodes: [], subItems: [] });
      expect(await movieRow(leftoverId)).toMatchObject({ hasFile: 0, monitored: 0 });
    });
  });

  describe("a run that is cancelled", () => {
    it("keeps the pending ids, unmonitors nothing, and does not count the scan as a full scan", async () => {
      const goneId = await insertMovie("Cancelled Movie", 2019, goneMoviePath("Cancelled"));
      const controller = new AbortController();
      scanHook.before = () => controller.abort();

      await runDeletedFileCheckJob(controller.signal);

      expect(readPending()).toEqual({ mediaItems: [goneId], episodes: [], subItems: [] });
      expect(await movieRow(goneId)).toMatchObject({ hasFile: 0, monitored: 1 });
      expect(getSetting("lastFullScanAt")).toBe(""); // the cancelled scan looked at nothing
    });

    it("lets the next run scan first and unmonitor what the cancelled one left", async () => {
      const goneId = await insertMovie("Cancelled Then Done", 2019, goneMoviePath("Cancelled Then Done"));
      const controller = new AbortController();
      scanHook.before = () => controller.abort();
      await runDeletedFileCheckJob(controller.signal);
      scanHook.before = null;
      scanHook.calls = 0;

      await runDeletedFileCheckJob(new AbortController().signal);

      expect(scanHook.calls).toBe(1);
      expect(await movieRow(goneId)).toMatchObject({ hasFile: 0, monitored: 0 });
      expect(readPending()).toBeNull();
      expect(Date.parse(getSetting("lastFullScanAt") ?? "")).toBeGreaterThan(0); // this scan did complete
    });
  });

  describe("a follow-up scan that fails", () => {
    it("is logged, and the rows stay pending and monitored until a later run has scanned", async () => {
      const { log } = await import("../src/services/logger.js");
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      const goneId = await insertMovie("Scan Failed Movie", 2019, goneMoviePath("Scan Failed"));
      scanHook.before = () => {
        throw new Error("scan exploded");
      };

      await expect(runDeletedFileCheckJob()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("library scan after the check failed"), "scan exploded");
      // A scan that never looked re-linked nothing, so nothing moved can be told from nothing gone.
      expect(await movieRow(goneId)).toMatchObject({ hasFile: 0, monitored: 1 });
      expect(readPending()).toEqual({ mediaItems: [goneId], episodes: [], subItems: [] });

      scanHook.before = null;
      await runDeletedFileCheckJob();

      expect(await movieRow(goneId)).toMatchObject({ hasFile: 0, monitored: 0 });
      expect(readPending()).toBeNull();
    });

    it("also holds the unmonitor back when another scan of a library was already running", async () => {
      const { scanAndImportLibrary } = await import("../src/services/libraryScan.js");
      const goneId = await insertMovie("Overlapping Scan Movie", 2019, goneMoviePath("Overlapping"));
      let overlapped: Promise<unknown> | null = null;
      scanHook.before = () => {
        // The admin's own scan of the movie library is running when the job's scan reaches that type.
        overlapped = scanAndImportLibrary("movie");
      };

      await runDeletedFileCheckJob();
      await overlapped;

      expect(await movieRow(goneId)).toMatchObject({ hasFile: 0, monitored: 1 });
      expect(readPending()).toEqual({ mediaItems: [goneId], episodes: [], subItems: [] });
    });
  });

  describe("a storage location that stops answering during the check", () => {
    it("keeps what was cleared before it as pending and skips the follow-up scan, then finishes it on the next run", async () => {
      const goneId = await insertMovie("Gone Before The Outage", 2019, goneMoviePath("Gone Before"));
      const stuckPath = writeFile("Stuck (2020)", "Stuck.2020.mkv");
      const stuckId = await insertMovie("Stuck", 2020, stuckPath);
      storageHook.hangingPaths.add(stuckPath);

      await runDeletedFileCheckJob();

      expect(scanHook.calls).toBe(0);
      expect(readPending()).toEqual({ mediaItems: [goneId], episodes: [], subItems: [] });
      expect(await movieRow(goneId)).toMatchObject({ hasFile: 0, monitored: 1 });
      expect(await movieRow(stuckId)).toMatchObject({ hasFile: 1, monitored: 1 }); // never read as gone

      storageHook.hangingPaths.clear();
      await runDeletedFileCheckJob();

      expect(scanHook.calls).toBe(1);
      expect(await movieRow(goneId)).toMatchObject({ hasFile: 0, monitored: 0 });
      expect(await movieRow(stuckId)).toMatchObject({ hasFile: 1, monitored: 1 });
      expect(readPending()).toBeNull();
    });
  });
});
