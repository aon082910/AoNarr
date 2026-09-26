import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

// The real probe by default (this environment has no ffprobe binary, so it always fails); a test
// can swap in its own result for one run.
let probeOverride: ((filePath: string) => Promise<unknown>) | null = null;
vi.mock("../src/services/ffprobe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/ffprobe.js")>();
  return {
    ...actual,
    probeMediaInfo: (filePath: string) => (probeOverride ? probeOverride(filePath) : actual.probeMediaInfo(filePath)),
  };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let tmpDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-corruptcheck-"));
});

afterEach(async () => {
  const { setSetting } = await import("../src/services/settingsStore.js");
  setSetting("corruptMediaReviewEnabled", "0");
  probeOverride = null;
});

function goneFile(name: string): string {
  return path.join(tmpDir, name);
}

function realFile(name: string, content = "x"): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

async function insertMovie(filePath: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path, quality) VALUES ('movie', 'Movie', 'movie', 1, 1, 'unknown', ?, 'HD-1080p')`
        )
        .run(filePath)
    ).lastInsertRowid
  );
}

describe("checkForCorruptMedia — missing files", () => {
  it("flags a missing file as corrupt and recycles it (review disabled, the default)", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const id = await insertMovie(goneFile("missing-movie.mkv"));

    const result = await checkForCorruptMedia();

    expect(result.corrupt).toBeGreaterThanOrEqual(1);
    const row = (await db.prepare("SELECT has_file, path, quality FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(0);
    expect(row.path).toBeNull();
    expect(row.quality).toBeNull();
  });

  it("queues a missing file for review instead of recycling it when review is enabled", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    setSetting("corruptMediaReviewEnabled", "1");
    const filePath = goneFile("review-missing-movie.mkv");
    const id = await insertMovie(filePath);

    await checkForCorruptMedia();

    const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(1);
    expect(row.path).toBe(filePath);
    const reviewRow = (await db.prepare("SELECT * FROM corrupt_media_review WHERE table_name = 'media_items' AND row_id = ?").get(id)) as any;
    expect(reviewRow).toBeDefined();
    expect(reviewRow.reason).toBe("File is missing from disk");
  });

  it("does not queue a second review row for the same item on a repeated check", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    setSetting("corruptMediaReviewEnabled", "1");
    const id = await insertMovie(goneFile("repeated-review-movie.mkv"));

    await checkForCorruptMedia();
    await checkForCorruptMedia();

    const count = (await db.prepare("SELECT COUNT(*) AS c FROM corrupt_media_review WHERE table_name = 'media_items' AND row_id = ?").get(id)) as {
      c: number;
    };
    expect(Number(count.c)).toBe(1);
  });
});

describe("checkForCorruptMedia — non-probeable and skipped shapes", () => {
  it("never flags a non-probeable file type (e.g. an ebook) just because ffprobe can't read it", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const filePath = realFile("book.epub", "fake epub content");
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('book', 'Book', 'book', 1, 1, 'unknown', ?)`
          )
          .run(filePath)
      ).lastInsertRowid
    );

    await checkForCorruptMedia();

    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(1);
  });

  it("skips sub-items of a multiFilePerChild type (e.g. artist albums) entirely", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const artistId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Artist', 'artist', 1, 0, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    const subId = Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Album', 1, 1, ?)")
          .run(artistId, goneFile("skipped-album"))
      ).lastInsertRowid
    );

    await checkForCorruptMedia();

    const row = (await db.prepare("SELECT has_file FROM sub_items WHERE id = ?").get(subId)) as any;
    expect(row.has_file).toBe(1);
  });
});

describe("checkForCorruptMedia — probeable file that ffprobe can't read", () => {
  it("flags a probeable file as corrupt after ffprobe fails (this environment has no ffprobe binary)", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    // A real, never-modified file so isStillBeingWritten's before/after size check reports "stable"
    // and the code proceeds past its false-positive guard into the genuine-failure path.
    const filePath = realFile("unprobeable-content.mkv", "not a real video file");
    const id = await insertMovie(filePath);

    const result = await checkForCorruptMedia();

    expect(result.corrupt).toBeGreaterThanOrEqual(1);
    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(0);
  }, 20000);
});

describe("isCorruptMediaReviewEnabled", () => {
  it("reflects the corruptMediaReviewEnabled setting", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { isCorruptMediaReviewEnabled } = await import("../src/services/corruptMediaCheck.js");
    expect(isCorruptMediaReviewEnabled()).toBe(false);

    setSetting("corruptMediaReviewEnabled", "1");
    expect(isCorruptMediaReviewEnabled()).toBe(true);
  });
});

describe("recycleAndMarkMissing", () => {
  it("clears file_path (not path) for an episode row", async () => {
    const { recycleAndMarkMissing } = await import("../src/services/corruptMediaCheck.js");
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Show', 'show', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    const epId = Number(
      (
        await db
          .prepare(
            "INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path, quality) VALUES (?, 1, 1, 1, 1, ?, 'HD-1080p')"
          )
          .run(showId, goneFile("ep-to-recycle.mkv"))
      ).lastInsertRowid
    );
    await db.prepare(`UPDATE episodes SET size_bytes = 1234, media_info = '{"videoCodec":"h264"}' WHERE id = ?`).run(epId);

    await recycleAndMarkMissing("episodes", epId, goneFile("ep-to-recycle.mkv"), "series", "Show — S01E01", showId);

    const row = (await db.prepare("SELECT has_file, file_path, quality, size_bytes, media_info FROM episodes WHERE id = ?").get(epId)) as any;
    expect(row.has_file).toBe(0);
    expect(row.file_path).toBeNull();
    expect(row.quality).toBeNull();
    // The Library's "Size on disk" column and sort must not keep showing the recycled file's size.
    expect(row.size_bytes).toBeNull();
    expect(row.media_info).toBeNull();
  });

  it("rolls the parent's has_file back once its only episode file is recycled, but not while a sibling still has one", async () => {
    const { recycleAndMarkMissing } = await import("../src/services/corruptMediaCheck.js");
    async function insertShow(): Promise<number> {
      return Number(
        (
          await db
            .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Show', 'show', 1, 1, 'unknown')`)
            .run()
        ).lastInsertRowid
      );
    }
    async function insertEpisode(showId: number, episode: number, filePath: string): Promise<number> {
      return Number(
        (
          await db
            .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, ?, 1, 1, ?)")
            .run(showId, episode, filePath)
        ).lastInsertRowid
      );
    }
    const onlyShowId = await insertShow();
    const onlyEpId = await insertEpisode(onlyShowId, 1, goneFile("only-ep-corrupt.mkv"));
    const siblingShowId = await insertShow();
    const recycledEpId = await insertEpisode(siblingShowId, 1, goneFile("sibling-ep-corrupt.mkv"));
    await insertEpisode(siblingShowId, 2, realFile("sibling-ep-healthy.mkv"));

    expect(await recycleAndMarkMissing("episodes", onlyEpId, goneFile("only-ep-corrupt.mkv"), "series", "Show — S01E01", onlyShowId)).toBe("recycled");
    expect(
      await recycleAndMarkMissing("episodes", recycledEpId, goneFile("sibling-ep-corrupt.mkv"), "series", "Show — S01E01", siblingShowId)
    ).toBe("recycled");

    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(onlyShowId)) as any).has_file).toBe(0);
    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(siblingShowId)) as any).has_file).toBe(1);
  });
});

// An unmounted share, or a stopped debrid/rclone mount behind a symlink library, makes every file
// on it look missing — the weekly check must leave those alone rather than recycle-and-clear them.
describe("checkForCorruptMedia — unavailable storage", () => {
  beforeEach(async () => {
    // Only this test's own rows get checked (a leftover missing file would add a 3 s confirmation
    // wait per run).
    await db.prepare("UPDATE media_items SET has_file = 0").run();
    await db.prepare("UPDATE episodes SET has_file = 0").run();
    await db.prepare("UPDATE sub_items SET has_file = 0").run();
  });

  function newDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  async function insertRootFolder(rootPath: string): Promise<void> {
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(rootPath);
  }

  /** `<root>/Movie (2020)/Movie (2020).mkv` -> `<downloads>/<release>/movie.mkv` -> `<mount>/<release>/movie.mkv`,
   * with another release left in both the mount and the download folder. */
  async function chainedLink(): Promise<{ mount: string; downloadLink: string; link: string }> {
    const mount = newDir("aonarr-corrupt-chainmnt-");
    const downloads = newDir("aonarr-corrupt-chaindl-");
    for (const release of ["Movie.2020.1080p", "Other.2019.1080p"]) {
      fs.mkdirSync(path.join(mount, release));
      fs.writeFileSync(path.join(mount, release, "movie.mkv"), "video");
      fs.mkdirSync(path.join(downloads, release));
      fs.symlinkSync(path.join(mount, release, "movie.mkv"), path.join(downloads, release, "movie.mkv"));
    }
    const root = newDir("aonarr-corrupt-chainlinks-");
    await insertRootFolder(root);
    const downloadLink = path.join(downloads, "Movie.2020.1080p", "movie.mkv");
    const link = path.join(root, "Movie (2020)", "Movie (2020).mkv");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(downloadLink, link);
    return { mount, downloadLink, link };
  }

  async function insertShowEpisode(filePath: string): Promise<number> {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Show', 'show', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    return Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, 1, 1, 1, ?)")
          .run(showId, filePath)
      ).lastInsertRowid
    );
  }

  it("skips every file under a root folder that is missing or empty", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const missingRoot = path.join(newDir("aonarr-corrupt-root-"), "library"); // never created
    const emptyRoot = newDir("aonarr-corrupt-root-"); // a mount point with nothing mounted
    await insertRootFolder(missingRoot);
    await insertRootFolder(emptyRoot);
    const moviePath = path.join(missingRoot, "Movie (2020)", "Movie (2020).mkv");
    const episodePath = path.join(emptyRoot, "Show", "Season 01", "S01E01.mkv");
    const movieId = await insertMovie(moviePath);
    const episodeId = await insertShowEpisode(episodePath);

    const result = await checkForCorruptMedia();

    expect(result).toEqual({ checked: 0, corrupt: 0 });
    expect(await db.prepare("SELECT has_file, path, quality FROM media_items WHERE id = ?").get(movieId)).toEqual({
      has_file: 1,
      path: moviePath,
      quality: "HD-1080p",
    });
    expect(await db.prepare("SELECT has_file, file_path FROM episodes WHERE id = ?").get(episodeId)).toEqual({ has_file: 1, file_path: episodePath });
  });

  it("leaves a library symlink alone (not recycled, not marked missing) while the mount it points into is down", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const mount = newDir("aonarr-corrupt-mount-");
    const target = path.join(mount, "Movie.2020.1080p", "movie.mkv");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, "video");
    const root = newDir("aonarr-corrupt-links-");
    await insertRootFolder(root);
    const link = path.join(root, "Movie (2020)", "Movie (2020).mkv");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(target, link);
    const id = await insertMovie(link);
    // The mount goes away: its mount point is left behind, empty.
    fs.rmSync(mount, { recursive: true });
    fs.mkdirSync(mount);

    const result = await checkForCorruptMedia();

    expect(result.corrupt).toBe(0);
    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 1, path: link });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE original_path = ?").get(link)).toBeUndefined();
  });

  // With a debrid client's symlink mode the library link points at the client's own link in its
  // download folder, which points into the mount; that download folder stays populated while the
  // mount is down.
  it("leaves a library link alone while the mount behind its download-folder link is down", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const { mount, link } = await chainedLink();
    const id = await insertMovie(link);
    fs.rmSync(mount, { recursive: true });
    fs.mkdirSync(mount);

    const result = await checkForCorruptMedia();

    expect(result).toEqual({ checked: 0, corrupt: 0 });
    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 1, path: link });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE original_path = ?").get(link)).toBeUndefined();
  });

  it("still recycles a library link whose download-folder link was removed while the mount is up", async () => {
    const { recycleAndMarkMissing } = await import("../src/services/corruptMediaCheck.js");
    const { downloadLink, link } = await chainedLink();
    const id = await insertMovie(link);
    fs.rmSync(path.dirname(downloadLink), { recursive: true });

    expect(await recycleAndMarkMissing("media_items", id, link, "movie", "Chained Movie", id)).toBe("recycled");

    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 0, path: null });
    expect(() => fs.lstatSync(link)).toThrow();
  });

  /** `<root>/Movie (2020)/Movie (2020).mkv` -> `<downloads>/Movie.2020.1080p/movie.mkv`, where that
   * release folder is itself a link to `<mount>/Movie.2020.1080p`; another release stays in the mount. */
  async function linkedReleaseFolder(): Promise<{ mount: string; link: string }> {
    const mount = newDir("aonarr-corrupt-relmnt-");
    const downloads = newDir("aonarr-corrupt-reldl-");
    for (const release of ["Movie.2020.1080p", "Other.2019.1080p"]) {
      fs.mkdirSync(path.join(mount, release));
      fs.writeFileSync(path.join(mount, release, "movie.mkv"), "video");
      fs.symlinkSync(path.join(mount, release), path.join(downloads, release));
    }
    const root = newDir("aonarr-corrupt-rellinks-");
    await insertRootFolder(root);
    const link = path.join(root, "Movie (2020)", "Movie (2020).mkv");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(path.join(downloads, "Movie.2020.1080p", "movie.mkv"), link);
    return { mount, link };
  }

  it("leaves a library link alone while the mount its download release folder is linked into is down", async () => {
    const { checkForCorruptMedia, recycleAndMarkMissing } = await import("../src/services/corruptMediaCheck.js");
    const { mount, link } = await linkedReleaseFolder();
    const id = await insertMovie(link);
    fs.rmSync(mount, { recursive: true });
    fs.mkdirSync(mount);

    expect(await checkForCorruptMedia()).toEqual({ checked: 0, corrupt: 0 });
    expect(await recycleAndMarkMissing("media_items", id, link, "movie", "Linked Release", id)).toBe("unavailable");

    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 1, path: link });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE original_path = ?").get(link)).toBeUndefined();
  });

  it("still recycles a library link whose release was removed from a live mount behind a linked release folder", async () => {
    const { recycleAndMarkMissing } = await import("../src/services/corruptMediaCheck.js");
    const { mount, link } = await linkedReleaseFolder();
    const id = await insertMovie(link);
    fs.rmSync(path.join(mount, "Movie.2020.1080p"), { recursive: true });

    expect(await recycleAndMarkMissing("media_items", id, link, "movie", "Linked Release", id)).toBe("recycled");

    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 0, path: null });
    expect(() => fs.lstatSync(link)).toThrow();
  });

  it("leaves files alone on a dead FUSE mount inside a populated root folder (ENOTCONN, not ENOENT)", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const root = newDir("aonarr-corrupt-media-");
    const deadMount = path.join(root, "gdrive");
    fs.mkdirSync(deadMount);
    fs.mkdirSync(path.join(root, "local"));
    await insertRootFolder(root);
    const moviePath = path.join(deadMount, "Movie (2020)", "Movie (2020).mkv");
    const id = await insertMovie(moviePath);
    const underDeadMount = (p: unknown) => typeof p === "string" && (p === deadMount || p.startsWith(deadMount + path.sep));
    const notConnected = (p: string) => Object.assign(new Error(`ENOTCONN: socket is not connected, lstat '${p}'`), { code: "ENOTCONN" });
    const realLstat = fs.lstatSync;
    const realStat = fs.statSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: string, ...rest: unknown[]) => {
      if (underDeadMount(p)) throw notConnected(p);
      return (realLstat as any)(p, ...rest);
    }) as any);
    vi.spyOn(fs, "statSync").mockImplementation(((p: string, ...rest: unknown[]) => {
      if (underDeadMount(p)) throw notConnected(p);
      return (realStat as any)(p, ...rest);
    }) as any);

    try {
      const result = await checkForCorruptMedia();

      expect(result).toEqual({ checked: 0, corrupt: 0 });
      expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 1, path: moviePath });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("stops flagging a root's files once that root drops partway through the run", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const root = newDir("aonarr-corrupt-drop-");
    await insertRootFolder(root);
    const moviePath = path.join(root, "Movie (2020)", "Movie (2020).mkv");
    fs.mkdirSync(path.dirname(moviePath));
    fs.writeFileSync(moviePath, "video");
    await insertMovie(moviePath);
    // Its file is already gone, but the root is up when the run starts — only the drop below
    // (while the movie is being probed) must keep it from being flagged.
    const episodePath = path.join(root, "Show", "Season 01", "S01E01.mkv");
    const episodeId = await insertShowEpisode(episodePath);
    probeOverride = async () => {
      fs.renameSync(root, `${root}-gone`);
      fs.mkdirSync(root);
      return { videoCodec: "h264" };
    };

    const result = await checkForCorruptMedia();

    expect(result.corrupt).toBe(0);
    expect(await db.prepare("SELECT has_file, file_path FROM episodes WHERE id = ?").get(episodeId)).toEqual({ has_file: 1, file_path: episodePath });
  });
});

// The weekly run reads every row up front and can take hours to reach one; by then an upgrade or
// rename may have given the row a different file.
describe("handleCorrupt / recycleAndMarkMissing — rows that changed since detection", () => {
  it("does nothing to a row that now points at a different file", async () => {
    const { handleCorrupt, recycleAndMarkMissing } = await import("../src/services/corruptMediaCheck.js");
    const oldPath = goneFile("Upgraded Movie (2020).mp4"); // replaced by the upgrade below
    const newPath = realFile("Upgraded Movie (2020).mkv", "new good file");
    const id = await insertMovie(newPath);

    expect(await handleCorrupt("media_items", id, oldPath, "movie", "Upgraded Movie", id, "File is missing from disk")).toBe("stale");
    expect(await recycleAndMarkMissing("media_items", id, oldPath, "movie", "Upgraded Movie", id)).toBe("stale");

    expect(await db.prepare("SELECT has_file, path, quality FROM media_items WHERE id = ?").get(id)).toEqual({
      has_file: 1,
      path: newPath,
      quality: "HD-1080p",
    });
    expect(fs.readFileSync(newPath, "utf-8")).toBe("new good file");
  });

  it("does not queue a review entry for a row that no longer has that file", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { handleCorrupt } = await import("../src/services/corruptMediaCheck.js");
    setSetting("corruptMediaReviewEnabled", "1");
    const id = await insertMovie(realFile("Renamed Movie (2020) - New Name.mkv"));

    const action = await handleCorrupt("media_items", id, goneFile("Renamed Movie (2020).mkv"), "movie", "Renamed Movie", id, "File is missing from disk");

    expect(action).toBe("stale");
    expect(await db.prepare("SELECT id FROM corrupt_media_review WHERE table_name = 'media_items' AND row_id = ?").get(id)).toBeUndefined();
  });

  it("moves a dangling symlink into the recycle bin as a link when its storage is up but the target is gone", async () => {
    const { recycleAndMarkMissing } = await import("../src/services/corruptMediaCheck.js");
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-corrupt-mount-"));
    fs.writeFileSync(path.join(mount, "another-release.mkv"), "still here"); // the mount itself is up
    const target = path.join(mount, "Removed.Release", "movie.mkv"); // removed from the debrid account
    const link = path.join(tmpDir, "Linked Movie (2020).mkv");
    fs.symlinkSync(target, link);
    const id = await insertMovie(link);

    expect(await recycleAndMarkMissing("media_items", id, link, "movie", "Linked Movie", id)).toBe("recycled");

    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 0, path: null });
    const binRow = (await db.prepare("SELECT recycle_path FROM recycle_bin WHERE original_path = ?").get(link)) as { recycle_path: string };
    expect(fs.lstatSync(binRow.recycle_path).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(binRow.recycle_path)).toBe(target);
    expect(() => fs.lstatSync(link)).toThrow();
  });
});
