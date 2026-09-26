import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let tmpDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-"));
});

afterEach(async () => {
  const { setSetting } = await import("../src/services/settingsStore.js");
  setSetting("unmonitorDeletedFiles", "0");
});

function realFile(name: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, "x");
  return p;
}

function goneFile(name: string): string {
  return path.join(tmpDir, name); // never created
}

async function insertMovie(filePath: string | null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('movie', 'Movie', 'movie', 1, 1, 'unknown', ?)`
        )
        .run(filePath)
    ).lastInsertRowid
  );
}

async function insertSeries(hasFile: number): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('series', 'Show', 'show', 1, ?, 'unknown', NULL)`
        )
        .run(hasFile)
    ).lastInsertRowid
  );
}

async function insertEpisode(showId: number, season: number, episode: number, filePath: string | null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          "INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, ?, ?, 1, 1, ?)"
        )
        .run(showId, season, episode, filePath)
    ).lastInsertRowid
  );
}

async function insertArtist(): Promise<number> {
  return Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Artist', 'artist', 1, 0, 'unknown')`)
        .run()
    ).lastInsertRowid
  );
}

async function insertSubItem(artistId: number, filePath: string | null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Album', 1, 1, ?)")
        .run(artistId, filePath)
    ).lastInsertRowid
  );
}

describe("checkForDeletedFiles — movies", () => {
  it("leaves a movie alone when its file still exists", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const filePath = realFile("still-here.mkv");
    const id = await insertMovie(filePath);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(1);
    expect(row.path).toBe(filePath);
  });

  it("clears has_file and path for a movie whose file vanished, keeping it monitored by default", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const id = await insertMovie(goneFile("vanished.mkv"));
    await db.prepare(`UPDATE media_items SET size_bytes = 1234, media_info = '{"videoCodec":"h264"}' WHERE id = ?`).run(id);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBeGreaterThanOrEqual(1);
    const row = (await db.prepare("SELECT has_file, path, monitored, size_bytes, media_info FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(0);
    expect(row.path).toBeNull();
    expect(row.monitored).toBe(1);
    // The Library's "Size on disk" column and sort must not keep showing the vanished file's size.
    expect(row.size_bytes).toBeNull();
    expect(row.media_info).toBeNull();
  });

  it("also unmonitors a movie with a vanished file when unmonitorDeletedFiles is enabled", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    setSetting("unmonitorDeletedFiles", "1");
    const id = await insertMovie(goneFile("vanished-unmonitor.mkv"));

    await checkForDeletedFiles();

    const row = (await db.prepare("SELECT monitored FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.monitored).toBe(0);
  });
});

describe("checkForDeletedFiles — episodes and sub-items", () => {
  it("clears an episode's file fields when its file vanished", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const showId = await insertSeries(1);
    const epId = await insertEpisode(showId, 1, 1, goneFile("ep-vanished.mkv"));
    await db.prepare(`UPDATE episodes SET size_bytes = 1234, media_info = '{"videoCodec":"h264"}' WHERE id = ?`).run(epId);

    await checkForDeletedFiles();

    const row = (await db.prepare("SELECT has_file, file_path, size_bytes, media_info FROM episodes WHERE id = ?").get(epId)) as any;
    expect(row.has_file).toBe(0);
    expect(row.file_path).toBeNull();
    expect(row.size_bytes).toBeNull();
    expect(row.media_info).toBeNull();
  });

  it("clears a sub-item's file fields when its file vanished", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const artistId = await insertArtist();
    const subId = await insertSubItem(artistId, goneFile("album-vanished.mp3"));
    await db.prepare(`UPDATE sub_items SET size_bytes = 1234, media_info = '{"audioCodec":"mp3"}' WHERE id = ?`).run(subId);

    await checkForDeletedFiles();

    const row = (await db.prepare("SELECT has_file, file_path, size_bytes, media_info FROM sub_items WHERE id = ?").get(subId)) as any;
    expect(row.has_file).toBe(0);
    expect(row.file_path).toBeNull();
    expect(row.size_bytes).toBeNull();
    expect(row.media_info).toBeNull();
  });

  it("rolls the parent's has_file back to 0 once its only file-bearing episode vanishes", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const showId = await insertSeries(1);
    await insertEpisode(showId, 1, 1, goneFile("only-ep-vanished.mkv"));

    await checkForDeletedFiles();

    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(showId)) as any;
    expect(row.has_file).toBe(0);
  });

  it("leaves the parent's has_file alone when another episode still has its file", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const showId = await insertSeries(1);
    await insertEpisode(showId, 1, 1, goneFile("one-vanishes.mkv"));
    await insertEpisode(showId, 1, 2, realFile("one-survives.mkv"));

    await checkForDeletedFiles();

    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(showId)) as any;
    expect(row.has_file).toBe(1);
  });

  it("counts every table's checked/missing files in the returned totals", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    await insertMovie(realFile("count-movie-ok.mkv"));
    await insertMovie(goneFile("count-movie-gone.mkv"));
    const showId = await insertSeries(1);
    await insertEpisode(showId, 5, 1, goneFile("count-ep-gone.mkv"));
    const artistId = await insertArtist();
    await insertSubItem(artistId, realFile("count-sub-ok.mp3"));

    const result = await checkForDeletedFiles();

    expect(result.checked).toBeGreaterThanOrEqual(4);
    expect(result.missing).toBeGreaterThanOrEqual(2);
  });
});

// An unmounted/offline share looks exactly like "every file in it was deleted" — its files must be
// left alone for this run rather than mass-flagged (and, with unmonitorDeletedFiles, unmonitored).
describe("checkForDeletedFiles — unavailable root folders", () => {
  async function insertRootFolder(rootPath: string): Promise<void> {
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(rootPath);
  }

  function newRootPath(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-root-")), "library");
  }

  /** One movie, one episode and one album sub-item, all with files under `root` that don't exist. */
  async function insertRowsUnder(root: string): Promise<{ movieId: number; epId: number; subId: number }> {
    const movieId = await insertMovie(path.join(root, "Movie (2020)", "movie.mkv"));
    const showId = await insertSeries(1);
    const epId = await insertEpisode(showId, 1, 1, path.join(root, "Show", "Season 01", "S01E01.mkv"));
    const artistId = await insertArtist();
    const subId = await insertSubItem(artistId, path.join(root, "Artist", "Album"));
    return { movieId, epId, subId };
  }

  async function expectUntouched(root: string, ids: { movieId: number; epId: number; subId: number }): Promise<void> {
    expect(await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(ids.movieId)).toMatchObject({
      has_file: 1,
      path: path.join(root, "Movie (2020)", "movie.mkv"),
      monitored: 1,
    });
    expect(await db.prepare("SELECT has_file, file_path, monitored FROM episodes WHERE id = ?").get(ids.epId)).toMatchObject({
      has_file: 1,
      file_path: path.join(root, "Show", "Season 01", "S01E01.mkv"),
      monitored: 1,
    });
    expect(await db.prepare("SELECT has_file, file_path, monitored FROM sub_items WHERE id = ?").get(ids.subId)).toMatchObject({
      has_file: 1,
      file_path: path.join(root, "Artist", "Album"),
      monitored: 1,
    });
  }

  beforeEach(async () => {
    // Flags whatever vanished-file rows earlier tests left behind, so `missing` below counts only
    // this test's own rows.
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    await checkForDeletedFiles();
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("unmonitorDeletedFiles", "1");
  });

  it("skips every file under a root folder that doesn't exist at all (an unmounted share)", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const root = newRootPath(); // never created
    await insertRootFolder(root);
    const ids = await insertRowsUnder(root);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    await expectUntouched(root, ids);
  });

  it("skips every file under a root folder that exists but is empty (a mount point with nothing mounted)", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const root = newRootPath();
    fs.mkdirSync(root);
    await insertRootFolder(root);
    const ids = await insertRowsUnder(root);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    await expectUntouched(root, ids);
  });

  it("skips every file under a root path that isn't a directory", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const root = newRootPath();
    fs.writeFileSync(root, "not a directory");
    await insertRootFolder(root);
    const ids = await insertRowsUnder(root);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    await expectUntouched(root, ids);
  });

  it("still flags (and unmonitors) a vanished file under an available, non-empty root folder", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const root = newRootPath();
    fs.mkdirSync(path.join(root, "Other Movie (2019)"), { recursive: true });
    const survivor = path.join(root, "Other Movie (2019)", "other.mkv");
    fs.writeFileSync(survivor, "x");
    await insertRootFolder(root);
    const survivorId = await insertMovie(survivor);
    const goneId = await insertMovie(path.join(root, "Gone Movie (2021)", "gone.mkv"));

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(1);
    expect(await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(goneId)).toMatchObject({
      has_file: 0,
      path: null,
      monitored: 0,
    });
    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(survivorId)).toMatchObject({ has_file: 1, path: survivor });
  });
});

// With the symlink import strategy the root folder holds local links into a debrid/rclone mount:
// the root stays populated while the mount is down, but every link dangles.
describe("checkForDeletedFiles — symlinks into an unavailable mount", () => {
  beforeEach(async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    await checkForDeletedFiles();
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("unmonitorDeletedFiles", "1");
  });

  /** A root folder of links to `<mount>/<release>/movie.mkv`, one per release. */
  async function linkedLibrary(releases: string[]): Promise<{ mount: string; links: string[] }> {
    const mount = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-mnt-")), "debrid");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-links-"));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(root);
    const links = releases.map((release) => {
      const target = path.join(mount, release, "movie.mkv");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "video");
      const link = path.join(root, release, "movie.mkv");
      fs.mkdirSync(path.dirname(link));
      fs.symlinkSync(target, link);
      return link;
    });
    return { mount, links };
  }

  it("leaves every link alone while the mount's directory is empty (unmounted)", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { mount, links } = await linkedLibrary(["Movie A (2020)", "Movie B (2021)"]);
    const ids = [await insertMovie(links[0]), await insertMovie(links[1])];
    fs.rmSync(mount, { recursive: true });
    fs.mkdirSync(mount);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    for (const [i, id] of ids.entries()) {
      expect(await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 1, path: links[i], monitored: 1 });
    }
  });

  it("leaves every link alone when the mount's directory itself is gone", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { mount, links } = await linkedLibrary(["Movie C (2020)"]);
    const id = await insertMovie(links[0]);
    fs.rmSync(mount, { recursive: true });

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 1, path: links[0] });
  });

  it("still flags (and unmonitors) a link whose target alone is gone while the mount is up", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { mount, links } = await linkedLibrary(["Kept (2019)", "Removed (2020)"]);
    const keptId = await insertMovie(links[0]);
    const removedId = await insertMovie(links[1]);
    fs.rmSync(path.join(mount, "Removed (2020)"), { recursive: true });

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(1);
    expect(await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(removedId)).toEqual({ has_file: 0, path: null, monitored: 0 });
    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(keptId)).toEqual({ has_file: 1, path: links[0] });
  });

  /** A link in a populated root folder to `<parentDir>/<release>/movie.mkv`, returning both paths. */
  async function linkInto(parentDir: string, prefix: string): Promise<{ release: string; link: string }> {
    const release = fs.mkdtempSync(path.join(parentDir, prefix));
    fs.writeFileSync(path.join(release, "movie.mkv"), "video");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-links-"));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(root);
    const link = path.join(root, "Movie (2020)", "movie.mkv");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(path.join(release, "movie.mkv"), link);
    return { release, link };
  }

  // os.tmpdir() stands in for a top-level download directory like /downloads (it's /tmp here): a
  // torrent removed along with its files takes only its own release folder with it.
  it("still flags a link whose release folder was removed from a populated download directory", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { release, link } = await linkInto(os.tmpdir(), "aonarr-deletedcheck-release-");
    const id = await insertMovie(link);
    fs.rmSync(release, { recursive: true });

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(1);
    expect(await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 0, path: null, monitored: 0 });
  });

  it.runIf(path.dirname(os.tmpdir()) === path.parse(os.tmpdir()).root)(
    "leaves a link alone when its mount directory right under a top-level directory is gone",
    async () => {
      const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
      const mount = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-topmnt-"));
      const { link } = await linkInto(mount, "Movie.2020.1080p-");
      const id = await insertMovie(link);
      fs.rmSync(mount, { recursive: true });

      const result = await checkForDeletedFiles();

      expect(result.missing).toBe(0);
      expect(await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 1, path: link, monitored: 1 });
    }
  );
});

// With a debrid client's symlink mode (Decypharr, rdt-client's Symlink Downloader) the client's own
// download folder holds links into the mount, and the symlink import links to those: library link
// -> download-folder link -> mount. The download folder stays populated with its dangling links
// while the mount is down.
describe("checkForDeletedFiles — symlink chains through a download folder", () => {
  beforeEach(async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    await checkForDeletedFiles();
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("unmonitorDeletedFiles", "1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Per release: `<root>/<release>/movie.mkv` -> `<downloads>/<release>/movie.mkv` -> `<mount>/<release>/movie.mkv`. */
  async function chainedLibrary(releases: string[]): Promise<{ root: string; mount: string; downloads: string; links: string[] }> {
    const mount = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-mnt-")), "debrid");
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-dl-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-links-"));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(root);
    const links = releases.map((release) => {
      const target = path.join(mount, release, "movie.mkv");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "video");
      const downloadLink = path.join(downloads, release, "movie.mkv");
      fs.mkdirSync(path.dirname(downloadLink));
      fs.symlinkSync(target, downloadLink);
      // The importer links to the download path as it is, not to where that link resolves.
      const link = path.join(root, release, "movie.mkv");
      fs.mkdirSync(path.dirname(link));
      fs.symlinkSync(downloadLink, link);
      return link;
    });
    return { root, mount, downloads, links };
  }

  async function movieRow(id: number): Promise<unknown> {
    return db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(id);
  }

  it("leaves every chained link alone while the mount's directory is empty (unmounted)", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { mount, links } = await chainedLibrary(["Chain A (2020)", "Chain B (2021)"]);
    const ids = [await insertMovie(links[0]), await insertMovie(links[1])];
    fs.rmSync(mount, { recursive: true });
    fs.mkdirSync(mount);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    for (const [i, id] of ids.entries()) expect(await movieRow(id)).toEqual({ has_file: 1, path: links[i], monitored: 1 });
  });

  it("leaves a chained link alone when the mount's directory itself is gone", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { mount, links } = await chainedLibrary(["Chain C (2020)"]);
    const id = await insertMovie(links[0]);
    fs.rmSync(mount, { recursive: true });

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    expect(await movieRow(id)).toEqual({ has_file: 1, path: links[0], monitored: 1 });
  });

  it("leaves a chained link alone when the mount behind the download link can't be reached (ENOTCONN)", async () => {
    const { checkForDeletedFiles, offlineStorageFor } = await import("../src/services/deletedFileCheck.js");
    const { root, mount, links } = await chainedLibrary(["Chain D (2020)", "Chain D2 (2021)"]);
    const id = await insertMovie(links[0]);
    // Its target is gone while the rest of the mount looks up, so only the unreachable lookups below
    // keep it from being flagged.
    fs.rmSync(path.join(mount, "Chain D (2020)"), { recursive: true });
    const underMount = (p: unknown) => typeof p === "string" && (p === mount || p.startsWith(mount + path.sep));
    const notConnected = (p: string) => Object.assign(new Error(`ENOTCONN: socket is not connected, lstat '${p}'`), { code: "ENOTCONN" });
    const realLstat = fs.lstatSync;
    const realStat = fs.statSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: string, ...rest: unknown[]) => {
      if (underMount(p)) throw notConnected(p);
      return (realLstat as any)(p, ...rest);
    }) as any);
    vi.spyOn(fs, "statSync").mockImplementation(((p: string, ...rest: unknown[]) => {
      if (underMount(p)) throw notConnected(p);
      return (realStat as any)(p, ...rest);
    }) as any);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    expect(await movieRow(id)).toEqual({ has_file: 1, path: links[0], monitored: 1 });
    expect(offlineStorageFor(links[0], [root])).toBe(`symlink target storage "${mount}" is unreachable or empty`);
  });

  it("still flags (and unmonitors) a chained link whose download folder was removed while the mount is up", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { downloads, links } = await chainedLibrary(["Chain Kept (2019)", "Chain Removed (2020)"]);
    const keptId = await insertMovie(links[0]);
    const removedId = await insertMovie(links[1]);
    fs.rmSync(path.join(downloads, "Chain Removed (2020)"), { recursive: true });

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(1);
    expect(await movieRow(removedId)).toEqual({ has_file: 0, path: null, monitored: 0 });
    expect(await movieRow(keptId)).toEqual({ has_file: 1, path: links[0], monitored: 1 });
  });

  it("still flags a chained link whose target alone is gone from a live mount", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { mount, links } = await chainedLibrary(["Chain Stays (2019)", "Chain Gone (2020)"]);
    const staysId = await insertMovie(links[0]);
    const goneId = await insertMovie(links[1]);
    fs.rmSync(path.join(mount, "Chain Gone (2020)"), { recursive: true });

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(1);
    expect(await movieRow(goneId)).toEqual({ has_file: 0, path: null, monitored: 0 });
    expect(await movieRow(staysId)).toEqual({ has_file: 1, path: links[0], monitored: 1 });
  });

  /** Per release: `<root>/<release>/movie.mkv` -> `<downloads>/<release>/movie.mkv`, where the
   * release folder `<downloads>/<release>` is itself a link to `<mount>/<release>`. */
  async function linkedReleaseFolders(releases: string[]): Promise<{ root: string; mount: string; links: string[] }> {
    const mount = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-mnt-")), "debrid");
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-dl-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-links-"));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(root);
    const links = releases.map((release) => {
      fs.mkdirSync(path.join(mount, release), { recursive: true });
      fs.writeFileSync(path.join(mount, release, "movie.mkv"), "video");
      fs.symlinkSync(path.join(mount, release), path.join(downloads, release));
      const link = path.join(root, release, "movie.mkv");
      fs.mkdirSync(path.dirname(link));
      fs.symlinkSync(path.join(downloads, release, "movie.mkv"), link);
      return link;
    });
    return { root, mount, links };
  }

  it("leaves every link alone while the mount its download release folders are linked into is empty", async () => {
    const { checkForDeletedFiles, offlineStorageFor } = await import("../src/services/deletedFileCheck.js");
    const { root, mount, links } = await linkedReleaseFolders(["Folder A (2020)", "Folder B (2021)"]);
    const ids = [await insertMovie(links[0]), await insertMovie(links[1])];
    fs.rmSync(mount, { recursive: true });
    fs.mkdirSync(mount);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    for (const [i, id] of ids.entries()) expect(await movieRow(id)).toEqual({ has_file: 1, path: links[i], monitored: 1 });
    expect(offlineStorageFor(links[0], [root])).toBe(`symlink target storage "${mount}" is unreachable or empty`);
  });

  it("still flags a link whose release was removed from a live mount behind a linked release folder", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { mount, links } = await linkedReleaseFolders(["Folder Kept (2019)", "Folder Gone (2020)"]);
    const keptId = await insertMovie(links[0]);
    const goneId = await insertMovie(links[1]);
    fs.rmSync(path.join(mount, "Folder Gone (2020)"), { recursive: true });

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(1);
    expect(await movieRow(goneId)).toEqual({ has_file: 0, path: null, monitored: 0 });
    expect(await movieRow(keptId)).toEqual({ has_file: 1, path: links[0], monitored: 1 });
  });

  it("leaves a link alone while the mount its whole download folder is linked into is empty", async () => {
    const { checkForDeletedFiles, offlineStorageFor } = await import("../src/services/deletedFileCheck.js");
    const mount = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-mnt-")), "debrid");
    fs.mkdirSync(path.join(mount, "downloads", "Linked DL (2020)"), { recursive: true });
    fs.writeFileSync(path.join(mount, "downloads", "Linked DL (2020)", "movie.mkv"), "video");
    // The download folder sits beside other local folders, so its parent stays populated.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-data-"));
    fs.mkdirSync(path.join(dataDir, "incomplete"));
    fs.symlinkSync(path.join(mount, "downloads"), path.join(dataDir, "downloads"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-links-"));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(root);
    const link = path.join(root, "Linked DL (2020)", "movie.mkv");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(path.join(dataDir, "downloads", "Linked DL (2020)", "movie.mkv"), link);
    const id = await insertMovie(link);
    fs.rmSync(mount, { recursive: true });
    fs.mkdirSync(mount);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    expect(await movieRow(id)).toEqual({ has_file: 1, path: link, monitored: 1 });
    expect(offlineStorageFor(link, [root])).toBe(`symlink target storage "${mount}" is unreachable or empty`);
  });

  /** A root folder holding `Show`, a directory link to `<mount>/Show`, with one episode file in it. */
  async function linkedShowFolder(): Promise<{ mount: string; episodePath: string }> {
    const mount = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-showmnt-")), "debrid");
    fs.mkdirSync(path.join(mount, "Show", "Season 01"), { recursive: true });
    fs.writeFileSync(path.join(mount, "Show", "Season 01", "S01E01.mkv"), "video");
    fs.mkdirSync(path.join(mount, "Other Show"));
    fs.writeFileSync(path.join(mount, "Other Show", "S01E01.mkv"), "video");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-showlinks-"));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'series')").run(root);
    fs.symlinkSync(path.join(mount, "Show"), path.join(root, "Show"));
    return { mount, episodePath: path.join(root, "Show", "Season 01", "S01E01.mkv") };
  }

  it("leaves an episode alone while the mount its show folder is linked into is empty", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { mount, episodePath } = await linkedShowFolder();
    const showId = await insertSeries(1);
    const epId = await insertEpisode(showId, 1, 1, episodePath);
    fs.rmSync(mount, { recursive: true });
    fs.mkdirSync(mount);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    expect(await db.prepare("SELECT has_file, file_path, monitored FROM episodes WHERE id = ?").get(epId)).toEqual({
      has_file: 1,
      file_path: episodePath,
      monitored: 1,
    });
  });

  it("still flags an episode whose linked show folder was removed from a live mount", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const { mount, episodePath } = await linkedShowFolder();
    const showId = await insertSeries(1);
    const epId = await insertEpisode(showId, 1, 1, episodePath);
    fs.rmSync(path.join(mount, "Show"), { recursive: true });

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(1);
    expect(await db.prepare("SELECT has_file, file_path, monitored FROM episodes WHERE id = ?").get(epId)).toEqual({
      has_file: 0,
      file_path: null,
      monitored: 0,
    });
  });
});

// A dead FUSE/rclone mount inside a root folder (root /media, mount /media/gdrive) keeps the root
// populated, but every lookup under the mount fails with ENOTCONN rather than ENOENT.
describe("checkForDeletedFiles — unreachable mount inside a root folder", () => {
  let root: string;
  let deadMount: string;

  beforeEach(async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    await checkForDeletedFiles();
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("unmonitorDeletedFiles", "1");

    root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-media-"));
    deadMount = path.join(root, "gdrive");
    fs.mkdirSync(deadMount);
    fs.mkdirSync(path.join(root, "local"));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(root);

    const underDeadMount = (p: unknown) => typeof p === "string" && (p === deadMount || p.startsWith(deadMount + path.sep));
    const notConnected = (p: string) => Object.assign(new Error(`ENOTCONN: socket is not connected, stat '${p}'`), { code: "ENOTCONN" });
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves every file on the dead mount alone, reporting the mount once", async () => {
    const { checkForDeletedFiles, offlineStorageFor } = await import("../src/services/deletedFileCheck.js");
    const moviePath = path.join(deadMount, "Movie (2020)", "movie.mkv");
    const episodePath = path.join(deadMount, "Show", "Season 01", "S01E01.mkv");
    const movieId = await insertMovie(moviePath);
    const showId = await insertSeries(1);
    const epId = await insertEpisode(showId, 1, 1, episodePath);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    expect(await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(movieId)).toEqual({ has_file: 1, path: moviePath, monitored: 1 });
    expect(await db.prepare("SELECT has_file, file_path, monitored FROM episodes WHERE id = ?").get(epId)).toEqual({
      has_file: 1,
      file_path: episodePath,
      monitored: 1,
    });
    const expected = `storage holding "${deadMount}" is unreachable (ENOTCONN)`;
    expect(offlineStorageFor(moviePath, [root])).toBe(expected);
    expect(offlineStorageFor(episodePath, [root])).toBe(expected);
  });

  it("still flags a vanished file elsewhere in the same root folder", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const id = await insertMovie(path.join(root, "local", "Gone (2021)", "gone.mkv"));

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(1);
    expect(await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(id)).toEqual({ has_file: 0, path: null, monitored: 0 });
  });
});
