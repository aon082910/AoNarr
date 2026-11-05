import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const fetchSeriesEpisodesFor = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/metadata.js")>()),
  fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
}));

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let files: typeof import("../src/services/metadataFiles.js");
let options: typeof import("../src/services/metadataFileOptions.js");
let backgroundJobs: typeof import("../src/services/backgroundJobs.js");
let titleMoveLock: typeof import("../src/services/titleMoveLock.js");
let libraryDir: string;
let fetched: string[];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  files = await import("../src/services/metadataFiles.js");
  options = await import("../src/services/metadataFileOptions.js");
  backgroundJobs = await import("../src/services/backgroundJobs.js");
  titleMoveLock = await import("../src/services/titleMoveLock.js");
});

const jpegFor = (url: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(url)]);

const SWITCHES = [
  "writeNfoOnImport", "nfoTvEnabled", "nfoMusicEnabled", "writeImagesOnImport",
  "imagesPosterFanart", "imagesSeasonPosters", "imagesEpisodeThumbs", "imagesMusicCover", "overwriteMetadataFiles",
];

beforeEach(async () => {
  for (const table of ["history", "tracks", "episodes", "seasons", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  for (const key of SWITCHES) setSetting(key, "");
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-metafiles-job-"));
  files.metadataFilesPacing.titleMs = 0;
  files.metadataFilesPacing.providerMs = 0;
  fetched = [];
  fetchSeriesEpisodesFor.mockReset().mockResolvedValue([]);
  titleMoveLock.resetTitleMoveLocksForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      fetched.push(url);
      return new Response(jpegFor(url), { status: 200, headers: { "content-type": "image/jpeg" } });
    })
  );
});

afterEach(() => {
  fs.rmSync(libraryDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function rootFolder(mediaType: string, readOnly = false): Promise<{ id: number; path: string }> {
  const p = path.join(libraryDir, mediaType);
  fs.mkdirSync(p, { recursive: true });
  const result = await db.prepare("INSERT INTO root_folders (path, media_type, name, read_only) VALUES (?, ?, ?, ?)").run(p, mediaType, mediaType, readOnly ? 1 : 0);
  return { id: Number(result.lastInsertRowid), path: p };
}

function touch(file: string, content = "x"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function movie(root: { id: number; path: string }, title = "Heat", year = 1995): Promise<{ id: number; dir: string; file: string }> {
  const dir = path.join(root.path, `${title} (${year})`);
  const file = touch(path.join(dir, `${title} (${year}).mkv`));
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, path, monitored, status, poster_url, backdrop_url, overview, external_ids)
       VALUES ('movie', ?, ?, ?, ?, 1, ?, 1, 'downloaded', ?, ?, 'Robbers.', ?)`
    )
    .run(title, title.toLowerCase(), year, root.id, file, `https://img.example.com/${title}-poster.jpg`, `https://img.example.com/${title}-fanart.jpg`, JSON.stringify({ tmdb: "949" }));
  return { id: Number(result.lastInsertRowid), dir, file };
}

async function show(root: { id: number; path: string }, thumbs: (string | null)[]) {
  const dir = path.join(root.path, "Show");
  const showId = Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, root_folder_id, has_file, monitored, status, poster_url, backdrop_url, overview, external_ids)
           VALUES ('series', 'Show', 'show', ?, 1, 1, 'downloaded', 'https://img.example.com/show-poster.jpg', 'https://img.example.com/show-fanart.jpg', 'A show.', ?)`
        )
        .run(root.id, JSON.stringify({ tvdb: "81189" }))
    ).lastInsertRowid
  );
  await db.prepare("INSERT INTO seasons (media_item_id, season_number, poster_url) VALUES (?, 1, 'https://img.example.com/show-s1.jpg')").run(showId);
  const episodeFiles: string[] = [];
  for (const [index, thumb] of thumbs.entries()) {
    const n = index + 1;
    const file = touch(path.join(dir, "Season 01", `Show - S01E0${n} - Episode ${n}.mkv`));
    episodeFiles.push(file);
    await db
      .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path, thumb_url) VALUES (?, 1, ?, ?, 1, 1, ?, ?)")
      .run(showId, n, `Episode ${n}`, file, thumb);
  }
  return { id: showId, dir, episodeFiles };
}

async function artist(root: { id: number; path: string }) {
  const artistDir = path.join(root.path, "Daft Punk");
  const albumDir = path.join(artistDir, "Discovery");
  touch(path.join(albumDir, "01 - One More Time.mp3"));
  const artistId = Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, root_folder_id, has_file, monitored, status, poster_url, backdrop_url, overview, external_ids, genres)
           VALUES ('artist', 'Daft Punk', 'daft punk', ?, 1, 1, 'downloaded', 'https://img.example.com/artist.jpg', 'https://img.example.com/artist-fanart.jpg', 'French duo.', ?, ?)`
        )
        .run(root.id, JSON.stringify({ musicbrainz: "056e4f3e" }), JSON.stringify(["Electronic"]))
    ).lastInsertRowid
  );
  const albumId = Number(
    (
      await db
        .prepare("INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, poster_url, monitored, has_file, file_path) VALUES (?, 'Discovery', '2001-03-12', 'rg-1', 'musicbrainz', 'https://img.example.com/discovery.jpg', 1, 1, ?)")
        .run(artistId, albumDir)
    ).lastInsertRowid
  );
  await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, duration_seconds) VALUES (?, 1, 'One More Time', 320)").run(albumId);
  return { id: artistId, artistDir, albumDir };
}

const names = (dir: string) => fs.readdirSync(dir).sort();

describe("the switches", () => {
  it("are all off on a fresh install, and nothing is written for any kind of title", () => {
    const o = options.readMetadataFileOptions();
    expect(o.nfo).toEqual({ movie: false, tv: false, music: false, other: false });
    expect(o).toMatchObject({ images: false, posterFanart: false, seasonPosters: false, episodeThumbs: false, musicCover: false, overwrite: false });
    for (const type of ["movie", "series", "anime", "artist", "author"]) expect(options.anythingEnabledFor({ type }, o)).toBe(false);
  });

  it("keep what Write NFO on Import does today: it covers movies, shows and the single-file collections, but not music", () => {
    setSetting("writeNfoOnImport", "1");
    const o = options.readMetadataFileOptions();
    expect(o.nfo).toEqual({ movie: true, tv: true, music: false, other: true });
    expect(o.images).toBe(false);
  });

  it("let shows be switched apart from the rest in both directions, and music on by itself", () => {
    setSetting("writeNfoOnImport", "1");
    setSetting("nfoTvEnabled", "0");
    expect(options.readMetadataFileOptions().nfo).toMatchObject({ movie: true, tv: false });

    setSetting("writeNfoOnImport", "0");
    setSetting("nfoTvEnabled", "1");
    setSetting("nfoMusicEnabled", "1");
    expect(options.readMetadataFileOptions().nfo).toEqual({ movie: false, tv: true, music: true, other: false });
  });

  it("turn the picture kinds on with the master switch unless one is switched off", () => {
    setSetting("imagesSeasonPosters", "1");
    expect(options.readMetadataFileOptions().seasonPosters).toBe(false); // no master

    setSetting("writeImagesOnImport", "1");
    setSetting("imagesEpisodeThumbs", "0");
    expect(options.readMetadataFileOptions()).toMatchObject({ images: true, posterFanart: true, seasonPosters: true, episodeThumbs: false, musicCover: true });
  });

  it("classify the types by the shape of their library", () => {
    expect(["movie", "ppv", "rom"].map((type) => options.metadataKindOf({ type }))).toEqual(["movie", "movie", "movie"]);
    expect(["series", "anime", "sports", "course", "adult"].map((type) => options.metadataKindOf({ type }))).toEqual(["tv", "tv", "tv", "tv", "tv"]);
    expect(options.metadataKindOf({ type: "artist" })).toBe("music");
    expect(["author", "audiobook", "comic", "manga", "video", "podcast"].map((type) => options.metadataKindOf({ type }))).toEqual(Array(6).fill("other"));
    expect(options.imagesApplyTo({ type: "rom" })).toBe(false);
    expect(options.imagesApplyTo({ type: "author" })).toBe(false);
    expect(options.imagesApplyTo({ type: "artist" })).toBe(true);
  });

  it("are checked when saved, and are known settings", async () => {
    for (const key of SWITCHES.filter((k) => k !== "writeNfoOnImport")) {
      expect((await request(app).put(`/api/settings/${key}`).set("X-Api-Key", apiKey).send({ value: "maybe" })).status, key).toBe(400);
      expect((await request(app).put(`/api/settings/${key}`).set("X-Api-Key", apiKey).send({ value: "1" })).status, key).toBe(200);
      expect((await request(app).put(`/api/settings/${key}`).set("X-Api-Key", apiKey).send({ value: "" })).status, key).toBe(200);
    }
  });
});

describe("writeMetadataFilesForItem", () => {
  it("writes a movie's NFO, poster and fanart, keeps them on a second run, and refreshes only with overwrite", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);
    setSetting("writeNfoOnImport", "1");
    setSetting("writeImagesOnImport", "1");

    const first = await files.writeMetadataFilesForItem(m.id);
    expect(first).toMatchObject({ written: 3, skipped: 0, failed: 0 });
    expect(names(m.dir)).toEqual(["Heat (1995).mkv", "Heat (1995).nfo", "fanart.jpg", "poster.jpg"]);

    fetched = [];
    const second = await files.writeMetadataFilesForItem(m.id);
    expect(second).toMatchObject({ written: 0, skipped: 3, failed: 0 });
    expect(fetched).toEqual([]);

    await db.prepare("UPDATE media_items SET overview = 'Changed.' WHERE id = ?").run(m.id);
    expect(fs.readFileSync(path.join(m.dir, "Heat (1995).nfo"), "utf-8")).toContain("Robbers.");
    setSetting("overwriteMetadataFiles", "1");
    const third = await files.writeMetadataFilesForItem(m.id);
    expect(third.written).toBe(3);
    expect(fs.readFileSync(path.join(m.dir, "Heat (1995).nfo"), "utf-8")).toContain("Changed.");
    expect(names(m.dir).filter((n) => n.startsWith(".aonarr-tmp-"))).toEqual([]);
  });

  it("never replaces an NFO another tool wrote, overwrite or not", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);
    const theirs = `<movie><title>Heat</title><actor><name>Al Pacino</name></actor></movie>`;
    fs.writeFileSync(path.join(m.dir, "Heat (1995).nfo"), theirs);
    setSetting("writeNfoOnImport", "1");
    setSetting("overwriteMetadataFiles", "1");

    const report = await files.writeMetadataFilesForItem(m.id);

    expect(report).toMatchObject({ written: 0, skipped: 1, failed: 0 });
    expect(fs.readFileSync(path.join(m.dir, "Heat (1995).nfo"), "utf-8")).toBe(theirs);
  });

  it("writes a show's tvshow.nfo, episode NFOs, poster, fanart, season poster and stills", async () => {
    const root = await rootFolder("series");
    const s = await show(root, ["https://img.example.com/e1.jpg", "https://img.example.com/e2.jpg"]);
    setSetting("nfoTvEnabled", "1");
    setSetting("writeImagesOnImport", "1");

    const report = await files.writeMetadataFilesForItem(s.id);

    expect(report).toMatchObject({ written: 8, failed: 0 });
    expect(names(s.dir)).toEqual(["Season 01", "fanart.jpg", "poster.jpg", "season01-poster.jpg", "tvshow.nfo"]);
    expect(names(path.join(s.dir, "Season 01"))).toEqual([
      "Show - S01E01 - Episode 1-thumb.jpg",
      "Show - S01E01 - Episode 1.mkv",
      "Show - S01E01 - Episode 1.nfo",
      "Show - S01E02 - Episode 2-thumb.jpg",
      "Show - S01E02 - Episode 2.mkv",
      "Show - S01E02 - Episode 2.nfo",
    ]);
    expect(fs.readFileSync(path.join(s.dir, "Season 01", "Show - S01E01 - Episode 1.nfo"), "utf-8")).toContain("<episode>1</episode>");
  });

  it("calls the Specials poster season-specials-poster.jpg", async () => {
    const root = await rootFolder("series");
    const s = await show(root, [null]);
    await db.prepare("UPDATE episodes SET season_number = 0 WHERE media_item_id = ?").run(s.id);
    await db.prepare("UPDATE seasons SET season_number = 0 WHERE media_item_id = ?").run(s.id);
    setSetting("writeImagesOnImport", "1");

    await files.writeMetadataFilesForItem(s.id);

    expect(names(s.dir)).toContain("season-specials-poster.jpg");
  });

  it("writes only the kinds switched on for the show", async () => {
    const root = await rootFolder("series");
    const s = await show(root, ["https://img.example.com/e1.jpg"]);
    setSetting("writeImagesOnImport", "1");
    setSetting("imagesPosterFanart", "0");
    setSetting("imagesEpisodeThumbs", "0");

    await files.writeMetadataFilesForItem(s.id);

    expect(names(s.dir)).toEqual(["Season 01", "season01-poster.jpg"]);
  });

  it("looks up the stills of episodes that have none from the provider once, and stores them", async () => {
    const root = await rootFolder("series");
    const s = await show(root, [null, null]);
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 1, title: "Episode 1", airDate: null, overview: null, thumbUrl: "https://img.example.com/looked-up-1.jpg" },
      { seasonNumber: 1, episodeNumber: 2, title: "Episode 2", airDate: null, overview: null },
    ]);
    setSetting("writeImagesOnImport", "1");
    setSetting("imagesPosterFanart", "0");
    setSetting("imagesSeasonPosters", "0");

    const report = await files.writeMetadataFilesForItem(s.id);

    expect(fetchSeriesEpisodesFor).toHaveBeenCalledTimes(1);
    expect(fetchSeriesEpisodesFor).toHaveBeenCalledWith({ tvdb: "81189" });
    expect(report.written).toBe(1);
    expect(report.skipped).toBe(1); // the second episode has no still at the provider either
    expect(names(path.join(s.dir, "Season 01"))).toContain("Show - S01E01 - Episode 1-thumb.jpg");
    const rows = (await db.prepare("SELECT episode_number, thumb_url FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(s.id)) as any[];
    expect(rows.map((r) => r.thumb_url)).toEqual(["https://img.example.com/looked-up-1.jpg", null]);
  });

  it("still writes everything else when the provider cannot be asked", async () => {
    const root = await rootFolder("series");
    const s = await show(root, [null]);
    fetchSeriesEpisodesFor.mockRejectedValue(new Error("TMDB API key is not set"));
    setSetting("nfoTvEnabled", "1");
    setSetting("writeImagesOnImport", "1");

    const report = await files.writeMetadataFilesForItem(s.id);

    expect(report.failed).toBe(0);
    expect(names(s.dir)).toEqual(["Season 01", "fanart.jpg", "poster.jpg", "season01-poster.jpg", "tvshow.nfo"]);
  });

  it("writes an artist's and an album's files, with the track list", async () => {
    const root = await rootFolder("artist");
    const a = await artist(root);
    setSetting("nfoMusicEnabled", "1");
    setSetting("writeImagesOnImport", "1");

    const report = await files.writeMetadataFilesForItem(a.id);

    expect(report).toMatchObject({ written: 5, failed: 0 });
    expect(names(a.albumDir)).toEqual(["01 - One More Time.mp3", "album.nfo", "folder.jpg"]);
    expect(names(a.artistDir)).toEqual(["Discovery", "artist.jpg", "artist.nfo", "fanart.jpg"]);
    expect(fs.readFileSync(path.join(a.albumDir, "album.nfo"), "utf-8")).toContain("<duration>5:20</duration>");
  });

  it("says no file kind is switched on, and writes nothing", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);

    const report = await files.writeMetadataFilesForItem(m.id);

    expect(report.code).toBe("not-enabled");
    expect(report.reason).toContain("Metadata Files");
    expect(names(m.dir)).toEqual(["Heat (1995).mkv"]);
  });

  it("says books get an NFO only at import, and does not touch them", async () => {
    const root = await rootFolder("author");
    const authorId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, has_file, monitored, status) VALUES ('author','Frank Herbert','frank herbert',?,1,1,'downloaded')").run(root.id))
        .lastInsertRowid
    );
    setSetting("writeNfoOnImport", "1");
    setSetting("writeImagesOnImport", "1");

    const report = await files.writeMetadataFilesForItem(authorId);

    expect(report.code).toBe("not-enabled");
    expect(report.reason).toContain("only when a file is imported");
  });

  it("writes nothing into a read-only library", async () => {
    const root = await rootFolder("movie", true);
    const m = await movie(root);
    setSetting("writeNfoOnImport", "1");
    setSetting("writeImagesOnImport", "1");

    const report = await files.writeMetadataFilesForItem(m.id);

    expect(report).toMatchObject({ code: "unavailable", written: 0 });
    expect(report.reason).toContain("read-only");
    expect(names(m.dir)).toEqual(["Heat (1995).mkv"]);
    expect(fetched).toEqual([]);
  });

  it("writes nothing into a root folder whose share is not mounted (empty, yet files recorded in it)", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);
    fs.rmSync(m.dir, { recursive: true, force: true }); // the share did not come up: an empty mount point
    setSetting("writeNfoOnImport", "1");
    setSetting("writeImagesOnImport", "1");

    const report = await files.writeMetadataFilesForItem(m.id);

    expect(report.code).toBe("unavailable");
    expect(report.reason).toContain("is the share mounted");
    expect(fs.readdirSync(root.path)).toEqual([]);
  });

  it("passes over a title whose file is gone from disk", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);
    touch(path.join(root.path, "keep.txt")); // the root is not empty: the share is up, this file is just gone
    fs.rmSync(m.file);
    setSetting("writeNfoOnImport", "1");

    const report = await files.writeMetadataFilesForItem(m.id);

    expect(report).toMatchObject({ code: "no-files", written: 0 });
    expect(report.reason).toContain("could not be found on disk");
  });

  it("waits for a move or rename of the title to end", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);
    setSetting("writeNfoOnImport", "1");
    titleMoveLock.tryLockTitleMove(m.id);

    const report = await files.writeMetadataFilesForItem(m.id);

    expect(report.code).toBe("busy");
    expect(names(m.dir)).toEqual(["Heat (1995).mkv"]);
  });

  it("counts a picture it could not fetch as failed and still writes the rest", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => (String(input).includes("fanart") ? new Response("down", { status: 500 }) : new Response(jpegFor("p"), { status: 200, headers: { "content-type": "image/jpeg" } }))));
    setSetting("writeNfoOnImport", "1");
    setSetting("writeImagesOnImport", "1");

    const report = await files.writeMetadataFilesForItem(m.id);

    expect(report).toMatchObject({ written: 2, failed: 1 });
    expect(names(m.dir)).toEqual(["Heat (1995).mkv", "Heat (1995).nfo", "poster.jpg"]);
  });
});

describe("runMetadataFilesJob", () => {
  it("does nothing, and shows no job, while nothing is switched on", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);

    const summary = await files.runMetadataFilesJob();

    expect(summary).toMatchObject({ titles: 0, written: 0 });
    expect(names(m.dir)).toEqual(["Heat (1995).mkv"]);
    expect(backgroundJobs.listBackgroundJobs().some((j) => j.type === "metadata-files" && j.running)).toBe(false);
  });

  it("writes for every title that has files, counts what it wrote, kept and could not write, and reports progress", async () => {
    const movies = await rootFolder("movie");
    const series = await rootFolder("series");
    const readOnly = await rootFolder("anime", true);
    const good = await movie(movies, "Heat", 1995);
    const broken = await movie(movies, "Alien", 1979); // its poster URL answers 500
    const s = await show(series, ["https://img.example.com/e1.jpg"]);
    await db
      .prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, has_file, monitored, status, path) VALUES ('anime','Locked','locked',?,1,1,'downloaded',?)")
      .run(readOnly.id, touch(path.join(readOnly.path, "Locked", "Locked.mkv")));
    await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, has_file, monitored, status) VALUES ('movie','Wanted','wanted',?,0,1,'missing')").run(movies.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => (String(input).includes("Alien-poster") ? new Response("down", { status: 500 }) : new Response(jpegFor(String(input)), { status: 200, headers: { "content-type": "image/jpeg" } })))
    );
    setSetting("writeNfoOnImport", "1");
    setSetting("writeImagesOnImport", "1");

    const summary = await files.runMetadataFilesJob();

    // Heat: nfo + poster + fanart (3); Alien: nfo + fanart written, poster failed; Show: tvshow.nfo, episode nfo, poster, fanart, season poster, still (6)
    expect(summary).toMatchObject({ titles: 4, written: 3 + 2 + 6, failed: 1, titlesSkipped: 1, cancelled: false });
    expect(names(good.dir)).toEqual(["Heat (1995).mkv", "Heat (1995).nfo", "fanart.jpg", "poster.jpg"]);
    expect(names(broken.dir)).toEqual(["Alien (1979).mkv", "Alien (1979).nfo", "fanart.jpg"]);
    expect(names(s.dir)).toContain("tvshow.nfo");
    expect(fs.readdirSync(path.join(readOnly.path, "Locked"))).toEqual(["Locked.mkv"]);

    const job = backgroundJobs.listBackgroundJobs().find((j) => j.type === "metadata-files");
    expect(job).toMatchObject({ kind: "organize", running: false, total: 4, done: 4 });
    expect(job?.error).toContain("1 file(s) could not be written");
  });

  it("is safe to run again: a second run writes nothing and fetches nothing", async () => {
    const root = await rootFolder("movie");
    await movie(root);
    setSetting("writeNfoOnImport", "1");
    setSetting("writeImagesOnImport", "1");
    await files.runMetadataFilesJob();
    fetched = [];

    const summary = await files.runMetadataFilesJob();

    expect(summary).toMatchObject({ titles: 1, written: 0, skipped: 3, failed: 0 });
    expect(fetched).toEqual([]);
  });

  it("stops between titles when cancelled and leaves no half-written file", async () => {
    const root = await rootFolder("movie");
    const all = [await movie(root, "Alpha", 2001), await movie(root, "Beta", 2002), await movie(root, "Gamma", 2003)];
    setSetting("writeImagesOnImport", "1");
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        // the cancel arrives while the first title is being written
        controller.abort(new Error("cancelled"));
        return new Response(jpegFor(String(input)), { status: 200, headers: { "content-type": "image/jpeg" } });
      })
    );

    const summary = await files.runMetadataFilesJob(controller.signal);

    expect(summary.cancelled).toBe(true);
    expect(summary.titles).toBeLessThan(3);
    for (const m of all.slice(1)) expect(names(m.dir)).toEqual([path.basename(m.file)]);
    for (const m of all) expect(names(m.dir).filter((n) => n.startsWith(".aonarr-tmp-"))).toEqual([]);
    expect(backgroundJobs.listBackgroundJobs().find((j) => j.type === "metadata-files")?.running).toBe(false);
  });

  it("pauses between the titles it wrote files for, so a big library is not hammered", async () => {
    const root = await rootFolder("movie");
    for (const [i, title] of ["One", "Two", "Three"].entries()) await movie(root, title, 2000 + i);
    setSetting("writeNfoOnImport", "1");
    files.metadataFilesPacing.titleMs = 40;

    const started = Date.now();
    await files.runMetadataFilesJob();

    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("carries on after a title that throws", async () => {
    const root = await rootFolder("movie");
    const good = await movie(root, "Heat", 1995);
    const bad = await movie(root, "Alien", 1979);
    setSetting("writeNfoOnImport", "1");
    // A row that cannot be read as a title: the run reports one failure and still writes the other.
    await db.prepare("UPDATE media_items SET genres = 'not json' WHERE id = ?").run(bad.id);

    const summary = await files.runMetadataFilesJob();

    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(names(good.dir)).toContain("Heat (1995).nfo");
  });
});

describe("a job that starts switched off", () => {
  it("has no timer and is listed disabled until switched on, and still runs on request", async () => {
    const registry = await import("../src/services/jobRegistry.js");
    let ran = 0;
    registry.registerJob({ key: "testDefaultOff", name: "Default off", scheduleType: "cron", defaultSchedule: "0 0 1 1 *", defaultOff: true, run: async () => void ran++ });
    registry.registerJob({ key: "testDefaultOn", name: "Default on", scheduleType: "cron", defaultSchedule: "0 0 1 1 *", run: async () => void ran++ });

    expect(registry.listJobs().find((j) => j.key === "testDefaultOff")?.enabled).toBe(false);
    expect(registry.listJobs().find((j) => j.key === "testDefaultOn")?.enabled).toBe(true);

    expect(registry.runJobNow("testDefaultOff")).toBe("started");
    for (let i = 0; i < 100 && ran === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toBe(1);

    expect(registry.setJobEnabled("testDefaultOff", true).ok).toBe(true);
    expect(registry.listJobs().find((j) => j.key === "testDefaultOff")?.enabled).toBe(true);
    registry.setJobEnabled("testDefaultOff", false);
  });
});

describe("POST /api/media/:id/write-metadata-files", () => {
  const post = (id: number | string) => request(app).post(`/api/media/${id}/write-metadata-files`).set("X-Api-Key", apiKey).send({});

  it("writes the files that are switched on and answers with the counts", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);
    setSetting("writeNfoOnImport", "1");
    setSetting("writeImagesOnImport", "1");

    const res = await post(m.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: "Heat", written: 3, skipped: 0, failed: 0 });
    expect(res.body.files.sort()).toEqual(["Heat (1995).nfo", "fanart.jpg", "poster.jpg"]);
    expect(names(m.dir)).toEqual(["Heat (1995).mkv", "Heat (1995).nfo", "fanart.jpg", "poster.jpg"]);
  });

  it("answers 404 for a title that does not exist", async () => {
    expect((await post(999999)).status).toBe(404);
    expect((await post("abc")).status).toBe(404);
  });

  it("answers 400, and writes nothing, while no file kind is switched on for the title", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);

    const res = await post(m.id);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Metadata Files");
    expect(names(m.dir)).toEqual(["Heat (1995).mkv"]);
  });

  it("answers 409 while the title is being moved", async () => {
    const root = await rootFolder("movie");
    const m = await movie(root);
    setSetting("writeNfoOnImport", "1");
    titleMoveLock.tryLockTitleMove(m.id);

    expect((await post(m.id)).status).toBe(409);
  });

  it("is for admins only", async () => {
    const { createSession, hashPassword } = await import("../src/services/auth.js");
    const root = await rootFolder("movie");
    const m = await movie(root);
    setSetting("writeNfoOnImport", "1");
    const userId = Number((await db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')").run("metadata-files-household", hashPassword("x"))).lastInsertRowid);
    const { token } = await createSession(userId);

    const res = await request(app).post(`/api/media/${m.id}/write-metadata-files`).set("X-Session-Token", token).send({});

    expect(res.status).toBe(403);
    expect(names(m.dir)).toEqual(["Heat (1995).mkv"]);
  });
});
