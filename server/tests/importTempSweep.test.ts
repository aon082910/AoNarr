import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let sweepStaleImportTemps: (typeof import("../src/services/importTempSweep.js"))["sweepStaleImportTemps"];
let base: string;

const HOUR_MS = 60 * 60 * 1000;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ sweepStaleImportTemps } = await import("../src/services/importTempSweep.js"));
});

beforeEach(async () => {
  await db.prepare("DELETE FROM root_folders").run();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-tempsweep-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

async function addRoot(name: string, mediaType = "movie"): Promise<string> {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, ?, ?)").run(dir, mediaType, name);
  return dir;
}

/** A file whose last change was `ageMs` ago. */
function writeAged(file: string, ageMs: number, content = "partial copy"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

describe("sweepStaleImportTemps", () => {
  it("removes a partial copy that has sat untouched for more than an hour, in the root folder itself", async () => {
    const root = await addRoot("movies");
    const stale = writeAged(path.join(root, ".aonarr-tmp-0a1b2c3d-abcdef012345"), 2 * HOUR_MS);

    await sweepStaleImportTemps();

    expect(fs.existsSync(stale)).toBe(false);
  });

  it("removes stale partial copies in the folders below a root, as a library's show and season folders", async () => {
    const root = await addRoot("tv", "series");
    const inShow = writeAged(path.join(root, "Some Show (2020)", ".aonarr-tmp-11111111-aaaaaaaaaaaa"), 3 * HOUR_MS);
    const inSeason = writeAged(path.join(root, "Some Show (2020)", "Season 01", ".aonarr-tmp-22222222-bbbbbbbbbbbb"), 3 * HOUR_MS);
    const inOtherShow = writeAged(path.join(root, "Other Show", "Season 02", ".aonarr-tmp-33333333-cccccccccccc"), 3 * HOUR_MS);

    await sweepStaleImportTemps();

    expect(fs.existsSync(inShow)).toBe(false);
    expect(fs.existsSync(inSeason)).toBe(false);
    expect(fs.existsSync(inOtherShow)).toBe(false);
  });

  it("keeps a recent partial copy, which an import running in another process may still be writing", async () => {
    const root = await addRoot("movies");
    const justNow = writeAged(path.join(root, "A Film (2021)", ".aonarr-tmp-44444444-dddddddddddd"), 1000);
    const almostAnHour = writeAged(path.join(root, "A Film (2021)", ".aonarr-tmp-55555555-eeeeeeeeeeee"), HOUR_MS - 5 * 60 * 1000);

    await sweepStaleImportTemps();

    expect(fs.existsSync(justNow)).toBe(true);
    expect(fs.existsSync(almostAnHour)).toBe(true);
  });

  it("takes the stale temp and leaves the recent one when both sit in the same folder", async () => {
    const root = await addRoot("movies");
    const stale = writeAged(path.join(root, "Folder", ".aonarr-tmp-66666666-ffffffffffff"), 5 * HOUR_MS);
    const recent = writeAged(path.join(root, "Folder", ".aonarr-tmp-77777777-000000000000"), 60_000);

    await sweepStaleImportTemps();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("never touches files that are not import temps, however old they are", async () => {
    const root = await addRoot("movies");
    const movie = writeAged(path.join(root, "A Film (2021)", "A.Film.2021.1080p.mkv"), 400 * 24 * HOUR_MS);
    const hiddenOther = writeAged(path.join(root, "A Film (2021)", ".hidden-file"), 400 * 24 * HOUR_MS);
    const noDot = writeAged(path.join(root, "A Film (2021)", "aonarr-tmp-88888888-111111111111"), 400 * 24 * HOUR_MS);
    const suffixOnly = writeAged(path.join(root, "A Film (2021)", "poster.aonarr-tmp-"), 400 * 24 * HOUR_MS);
    const partialDownload = writeAged(path.join(root, "A Film (2021)", "A.Film.2021.mkv.part"), 400 * 24 * HOUR_MS);

    await sweepStaleImportTemps();

    for (const file of [movie, hiddenOther, noDot, suffixOnly, partialDownload]) expect(fs.existsSync(file)).toBe(true);
  });

  it("does not remove a directory whose name looks like a temp, but still sweeps inside it", async () => {
    const root = await addRoot("movies");
    const lookAlike = path.join(root, ".aonarr-tmp-99999999-222222222222");
    const inside = writeAged(path.join(lookAlike, ".aonarr-tmp-aaaaaaaa-333333333333"), 4 * HOUR_MS);
    const keepInside = writeAged(path.join(lookAlike, "keep.txt"), 4 * HOUR_MS);

    await sweepStaleImportTemps();

    expect(fs.statSync(lookAlike).isDirectory()).toBe(true);
    expect(fs.existsSync(inside)).toBe(false);
    expect(fs.existsSync(keepInside)).toBe(true);
  });

  it("sweeps every root folder", async () => {
    const movies = await addRoot("movies");
    const shows = await addRoot("shows", "series");
    const music = await addRoot("music", "artist");
    const files = [movies, shows, music].map((root) => writeAged(path.join(root, "Item", ".aonarr-tmp-bbbbbbbb-444444444444"), 2 * HOUR_MS));

    await sweepStaleImportTemps();

    for (const file of files) expect(fs.existsSync(file)).toBe(false);
  });

  it("goes four folders deep below a root and no further", async () => {
    const root = await addRoot("deep");
    const depth = (levels: number) => path.join(root, ...Array.from({ length: levels }, (_, i) => `level${i + 1}`), ".aonarr-tmp-cccccccc-555555555555");
    const levelFour = writeAged(depth(4), 2 * HOUR_MS);
    const levelFive = writeAged(depth(5), 2 * HOUR_MS);

    await sweepStaleImportTemps();

    expect(fs.existsSync(levelFour)).toBe(false);
    expect(fs.existsSync(levelFive)).toBe(true);
  });

  it("does nothing, and does not fail, with no root folders", async () => {
    await expect(sweepStaleImportTemps()).resolves.toBeUndefined();
  });

  it("carries on past a root folder that is missing or is not a folder", async () => {
    const gone = path.join(base, "gone");
    const notAFolder = path.join(base, "plain-file");
    fs.writeFileSync(notAFolder, "x");
    await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'series', 'gone')").run(gone);
    await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'artist', 'file')").run(notAFolder);
    const root = await addRoot("movies");
    const stale = writeAged(path.join(root, ".aonarr-tmp-dddddddd-666666666666"), 2 * HOUR_MS);

    await expect(sweepStaleImportTemps()).resolves.toBeUndefined();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(notAFolder)).toBe(true);
  });

  it("only looks at the library's root folders, not at other folders such as the downloads", async () => {
    const root = await addRoot("movies");
    const downloads = path.join(base, "downloads");
    const staleDownload = writeAged(path.join(downloads, "Some.Release", ".aonarr-tmp-eeeeeeee-777777777777"), 5 * HOUR_MS);
    const stale = writeAged(path.join(root, ".aonarr-tmp-ffffffff-888888888888"), 5 * HOUR_MS);

    await sweepStaleImportTemps();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(staleDownload)).toBe(true);
  });

  describe("cancelling", () => {
    it("does nothing when the signal is already aborted", async () => {
      const root = await addRoot("movies");
      const stale = writeAged(path.join(root, ".aonarr-tmp-01010101-999999999999"), 2 * HOUR_MS);
      const nested = writeAged(path.join(root, "Folder", ".aonarr-tmp-02020202-aaaaaaaaaaaa"), 2 * HOUR_MS);
      const controller = new AbortController();
      controller.abort();

      await sweepStaleImportTemps(controller.signal);

      expect(fs.existsSync(stale)).toBe(true);
      expect(fs.existsSync(nested)).toBe(true);
    });

    it("stops before the next folder when it is aborted during the sweep, keeping what it already did", async () => {
      const root = await addRoot("tv", "series");
      const rootTemp = writeAged(path.join(root, ".aonarr-tmp-03030303-bbbbbbbbbbbb"), 2 * HOUR_MS);
      const showA = writeAged(path.join(root, "Show A", ".aonarr-tmp-04040404-cccccccccccc"), 2 * HOUR_MS);
      const showB = writeAged(path.join(root, "Show B", ".aonarr-tmp-05050505-dddddddddddd"), 2 * HOUR_MS);
      const showC = writeAged(path.join(root, "Show C", ".aonarr-tmp-06060606-eeeeeeeeeeee"), 2 * HOUR_MS);
      const controller = new AbortController();
      // Abort once the first show folder has been listed (the listing with entry types is the sweep's own readdir).
      const realReaddir = fs.promises.readdir;
      let listedShows = 0;
      vi.spyOn(fs.promises, "readdir").mockImplementation((async (target: fs.PathLike, options?: unknown) => {
        const result = await (realReaddir as (...args: unknown[]) => Promise<unknown>)(target, options);
        if (options && String(target).startsWith(path.join(root, "Show"))) {
          listedShows++;
          controller.abort();
        }
        return result;
      }) as unknown as typeof fs.promises.readdir);

      await sweepStaleImportTemps(controller.signal);

      expect(listedShows).toBe(1);
      expect(fs.existsSync(rootTemp)).toBe(false); // the root was done before the abort
      const remaining = [showA, showB, showC].filter((file) => fs.existsSync(file));
      expect(remaining).toHaveLength(2); // exactly one show folder was swept, the other two were left alone
    });
  });
});
