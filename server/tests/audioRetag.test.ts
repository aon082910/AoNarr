import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import NodeID3 from "node-id3";
import { setupTestDb } from "./helpers/testDb.js";
import {
  modeFollowsEdits,
  modeRetagsLibrary,
  modeTagsOnImport,
  resolveWriteTagsMode,
  type AudioTagInfo,
  type CoverImage,
  type TagWriteResult,
  type WriteAudioTagsOptions,
} from "../src/services/audioTagCommon.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let tmp: string;
let setSetting: (key: string, value: string) => void;
let audioRetag: typeof import("../src/services/audioRetag.js");
let backgroundJobs: typeof import("../src/services/backgroundJobs.js");
let titleMoveLock: typeof import("../src/services/titleMoveLock.js");

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  audioRetag = await import("../src/services/audioRetag.js");
  backgroundJobs = await import("../src/services/backgroundJobs.js");
  titleMoveLock = await import("../src/services/titleMoveLock.js");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-retag-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ["history", "queue", "tracks", "episodes", "sub_items", "media_items", "root_folders"]) await db.prepare(`DELETE FROM ${t}`).run();
  for (const name of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
  for (const key of ["writeAudioTagsMode", "writeAudioTagsOnImport", "scrubAudioTags", "embedAudioCover"]) setSetting(key, "");
  titleMoveLock.resetTitleMoveLocksForTests();
  audioRetag.resetRetagStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function root(name: string, mediaType: string, readOnly = false): Promise<{ id: number; dir: string }> {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const id = Number((await db.prepare("INSERT INTO root_folders (path, media_type, read_only) VALUES (?, ?, ?)").run(dir, mediaType, readOnly ? 1 : 0)).lastInsertRowid);
  return { id, dir };
}

interface Fixture {
  itemId: number;
  subId: number;
  files: string[];
}

/** An artist or audiobook title with one album of `names.length` tracks, each with a file on disk. */
async function title(
  rootRow: { id: number; dir: string },
  options: { type?: string; title?: string; names?: string[]; sub?: Record<string, unknown>; externalIds?: Record<string, string>; genres?: string[]; ext?: string; withFiles?: boolean } = {}
): Promise<Fixture> {
  const type = options.type ?? "artist";
  const itemTitle = options.title ?? "Some Artist";
  const names = options.names ?? ["Track One", "Track Two"];
  const itemId = Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, monitored, status, external_ids, genres) VALUES (?, ?, ?, 2020, ?, 1, 1, 'downloaded', ?, ?)")
        .run(type, itemTitle, itemTitle.toLowerCase(), rootRow.id, options.externalIds ? JSON.stringify(options.externalIds) : null, options.genres ? JSON.stringify(options.genres) : null)
    ).lastInsertRowid
  );
  const sub = { title: "Some Album", release_date: "2020-05-06", external_id: null, external_provider: null, series_name: null, series_position: null, narrator: null, ...options.sub };
  const subId = Number(
    (
      await db
        .prepare("INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, series_name, series_position, narrator, has_file, monitored) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)")
        .run(itemId, sub.title, sub.release_date, sub.external_id, sub.external_provider, sub.series_name, sub.series_position, sub.narrator)
    ).lastInsertRowid
  );
  const folder = path.join(rootRow.dir, itemTitle, String(sub.title));
  fs.mkdirSync(folder, { recursive: true });
  const files: string[] = [];
  for (const [i, name] of names.entries()) {
    const file = path.join(folder, `${String(i + 1).padStart(2, "0")} - ${name}${options.ext ?? ".mp3"}`);
    if (options.withFiles !== false) fs.writeFileSync(file, Buffer.from(`pretend audio ${i}`));
    files.push(file);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, ?, ?, 1, ?)").run(subId, i + 1, name, file);
  }
  return { itemId, subId, files };
}

type Writer = NonNullable<import("../src/services/audioRetag.js").RetagOptions["writer"]>;
function stubWriter(outcome: TagWriteResult["outcome"] = "written", reason?: string) {
  const calls: { file: string; info: AudioTagInfo; options: WriteAudioTagsOptions }[] = [];
  const writer: Writer = async (file, info, options) => {
    calls.push({ file, info, options });
    return { outcome, format: file.toLowerCase().endsWith(".flac") ? "FLAC" : "MP3", ...(reason ? { reason } : {}) };
  };
  return { writer, calls };
}

describe("the write-tags mode", () => {
  it("maps the old on/off flag to 'new' only while no mode was chosen", () => {
    expect(resolveWriteTagsMode(undefined, undefined)).toBe("none");
    expect(resolveWriteTagsMode("", "0")).toBe("none");
    expect(resolveWriteTagsMode("", "1")).toBe("new");
    expect(resolveWriteTagsMode(undefined, "1")).toBe("new");
    expect(resolveWriteTagsMode("all", "0")).toBe("all");
    expect(resolveWriteTagsMode("sync", "1")).toBe("sync");
    // An explicit "none" wins over the old flag: the admin switched it off in the new control.
    expect(resolveWriteTagsMode("none", "1")).toBe("none");
    expect(resolveWriteTagsMode("bogus", "1")).toBe("new");
  });

  it("says what each mode does", () => {
    expect(["none", "new", "all", "sync"].map((m) => modeTagsOnImport(m as never))).toEqual([false, true, true, true]);
    expect(["none", "new", "all", "sync"].map((m) => modeRetagsLibrary(m as never))).toEqual([false, false, true, true]);
    expect(["none", "new", "all", "sync"].map((m) => modeFollowsEdits(m as never))).toEqual([false, false, false, true]);
  });

  it("reads the mode, scrub and cover settings", () => {
    expect(audioRetag.getAudioTagSettings()).toEqual({ mode: "none", scrub: false, embedCover: false });
    setSetting("writeAudioTagsOnImport", "1");
    expect(audioRetag.getAudioTagSettings().mode).toBe("new");
    expect(audioRetag.writeTagsOnImportEnabled()).toBe(true);
    setSetting("writeAudioTagsMode", "none");
    expect(audioRetag.getAudioTagSettings().mode).toBe("none");
    expect(audioRetag.writeTagsOnImportEnabled()).toBe(false);
    setSetting("writeAudioTagsMode", "sync");
    setSetting("scrubAudioTags", "1");
    setSetting("embedAudioCover", "1");
    expect(audioRetag.getAudioTagSettings()).toEqual({ mode: "sync", scrub: true, embedCover: true });
  });

  it("refuses a mode the registry does not know, over the settings API", async () => {
    const bad = await request(app).put("/api/settings/writeAudioTagsMode").set("X-Api-Key", apiKey).send({ value: "sometimes" });
    expect(bad.status).toBe(400);
    expect(bad.body.error ?? JSON.stringify(bad.body)).toContain("none, new, all, sync");
    const good = await request(app).put("/api/settings/writeAudioTagsMode").set("X-Api-Key", apiKey).send({ value: "all" });
    expect(good.status).toBe(200);
    for (const key of ["scrubAudioTags", "embedAudioCover"]) {
      expect((await request(app).put(`/api/settings/${key}`).set("X-Api-Key", apiKey).send({ value: "maybe" })).status).toBe(400);
    }
  });
});

describe("the tags a track gets", () => {
  it("gives a music track its artist, album, numbers, dates, genre and the MusicBrainz ids AoNarr has", () => {
    const info = audioTagInfoOf("artist");
    expect(info).toMatchObject({
      title: "Track Two",
      artist: "Some Artist",
      albumArtist: "Some Artist",
      album: "Some Album",
      trackNumber: 2,
      trackTotal: 11,
      year: "2020",
      date: "2020-05-06",
      // Three at most: a long list of sub-genres is noise in a player.
      genre: "Rock; Pop; Jazz",
      musicbrainz: { artistId: "artist-mbid", albumArtistId: "artist-mbid", releaseGroupId: "group-mbid" },
    });
    expect(info.composer).toBeUndefined();
  });

  it("gives an audiobook its author, narrator as composer and its series, and no MusicBrainz ids", () => {
    const info = audioTagInfoOf("audiobook");
    expect(info).toMatchObject({ artist: "Some Artist", albumArtist: "Some Artist", composer: "A Narrator", series: "The Series", seriesPart: "2.5" });
    expect(info.musicbrainz).toBeUndefined();
  });

  it("leaves out what it does not know", () => {
    const info = audioRetag.audioTagInfoFor({ item: { type: "artist", title: "A" }, sub: { title: "B", release_date: "TBA" }, track: { track_number: 1, title: "C" } });
    expect(info.year).toBeNull();
    expect(info.date).toBeNull();
    expect(info.genre).toBeNull();
    expect(info.trackTotal).toBeNull();
    expect(info.musicbrainz).toMatchObject({ artistId: null, releaseGroupId: null });
    // A partial date is kept for what it is; a total below the track number is not a total.
    const partial = audioRetag.audioTagInfoFor({ item: { type: "artist", title: "A" }, sub: { title: "B", release_date: "2019-07" }, track: { track_number: 5, title: "C" }, trackTotal: 3 });
    expect(partial).toMatchObject({ year: "2019", date: "2019-07", trackTotal: null });
  });

  function audioTagInfoOf(type: string): AudioTagInfo {
    return audioRetag.audioTagInfoFor({
      item: { type, title: "Some Artist", external_ids: JSON.stringify({ musicbrainz: "artist-mbid", tmdb: "1" }), genres: JSON.stringify(["Rock", "Pop", "Jazz", "Blues"]) },
      sub: {
        title: "Some Album",
        release_date: "2020-05-06",
        external_id: "group-mbid",
        external_provider: "musicbrainz",
        series_name: "The Series",
        series_position: 2.5,
        narrator: "A Narrator",
      },
      track: { track_number: "2", title: "Track Two" },
      trackTotal: 11,
    });
  }
});

describe("retagging a title", () => {
  it("writes every file of the title with its own tags, once per file, and counts them by format", async () => {
    const library = await root("music", "artist");
    const { itemId, files } = await title(library, { names: ["Track One", "Track Two", "Track Three"], externalIds: { musicbrainz: "mb-artist" } });
    const { writer, calls } = stubWriter();

    const summary = await audioRetag.retagTitle(itemId, { writer, throttleMs: 0 });

    expect(calls.map((c) => c.file)).toEqual(files);
    expect(calls.map((c) => c.info.title)).toEqual(["Track One", "Track Two", "Track Three"]);
    expect(calls[2].info).toMatchObject({ trackNumber: 3, trackTotal: 3, artist: "Some Artist", musicbrainz: { artistId: "mb-artist" } });
    expect(summary).toMatchObject({ titles: 1, files: 3, written: 3, skipped: 0, failed: 0, cancelled: false });
    expect(summary.byFormat).toEqual({ MP3: { written: 3, skipped: 0, failed: 0 } });
    expect(audioRetag.retagSummaryText(summary)).toBe("3 of 3 file(s) written (MP3 3)");
  });

  it("counts what the writer says per format and keeps the reasons", async () => {
    const library = await root("mixed", "artist");
    const first = await title(library, { names: ["One"], ext: ".flac" });
    const writer: Writer = async (file) =>
      file === first.files[0] ? { outcome: "failed", reason: "ffmpeg stopped with code 1: boom", format: "FLAC" } : { outcome: "skipped", reason: "the tags are already up to date", format: "MP3" };
    const second = await title(library, { title: "Other Artist", names: ["Two", "Three"] });

    const a = await audioRetag.retagTitle(first.itemId, { writer, throttleMs: 0 });
    const b = await audioRetag.retagTitle(second.itemId, { writer, throttleMs: 0 });

    expect(a).toMatchObject({ failed: 1, written: 0 });
    expect(a.failures).toEqual([{ file: first.files[0], reason: "ffmpeg stopped with code 1: boom" }]);
    expect(b).toMatchObject({ skipped: 2 });
    expect(b.reasons).toEqual({ "the tags are already up to date": 2 });
  });

  it("passes the scrub and cover options to the writer and looks the cover up once per album", async () => {
    const library = await root("covers", "artist");
    const { itemId } = await title(library, { names: ["One", "Two", "Three"] });
    const cover: CoverImage = { data: Buffer.from("jpeg"), mime: "image/jpeg" };
    const coverFor = vi.fn().mockResolvedValue(cover);
    const { writer, calls } = stubWriter();

    await audioRetag.retagTitle(itemId, { writer, throttleMs: 0, coverFor, settings: { scrub: true, embedCover: true } });
    expect(coverFor).toHaveBeenCalledTimes(1);
    expect(calls.every((c) => c.options.scrub === true && c.options.cover === cover)).toBe(true);

    coverFor.mockClear();
    const plain = stubWriter();
    await audioRetag.retagTitle(itemId, { writer: plain.writer, throttleMs: 0, coverFor, settings: { scrub: false, embedCover: false } });
    expect(coverFor).not.toHaveBeenCalled();
    expect(plain.calls.every((c) => c.options.scrub === false && !c.options.cover)).toBe(true);
  });

  it("never touches a title in a read-only root folder, whatever the writer would have said", async () => {
    const library = await root("served", "artist", true);
    const { itemId, files } = await title(library, { names: ["One", "Two"] });
    const before = files.map((f) => fs.readFileSync(f));
    const { writer, calls } = stubWriter();

    const summary = await audioRetag.retagTitle(itemId, { writer, throttleMs: 0 });

    expect(calls).toHaveLength(0);
    expect(summary).toMatchObject({ files: 2, written: 0, skipped: 2 });
    expect(summary.reasons).toEqual({ "its root folder is read-only": 2 });
    files.forEach((f, i) => expect(fs.readFileSync(f).equals(before[i])).toBe(true));

    // The real writer too: nothing is written.
    const real = await audioRetag.retagTitle(itemId, { throttleMs: 0 });
    expect(real.written).toBe(0);
    files.forEach((f, i) => expect(fs.readFileSync(f).equals(before[i])).toBe(true));
  });

  it("skips a title whose root folder is gone empty while the library has files recorded in it", async () => {
    const library = await root("unmounted", "artist");
    const { itemId, files } = await title(library, { withFiles: false });
    // The share did not come up: the mount point is an empty folder.
    fs.rmSync(path.join(library.dir, "Some Artist"), { recursive: true, force: true });
    const { writer, calls } = stubWriter();

    const summary = await audioRetag.retagTitle(itemId, { writer, throttleMs: 0 });

    expect(calls).toHaveLength(0);
    expect(summary.reasons).toEqual({ "its root folder looks unmounted": files.length });
  });

  it("skips a file that is missing and one that sits outside the title's root folder", async () => {
    const library = await root("odd", "artist");
    const { itemId, subId, files } = await title(library, { names: ["One", "Two"] });
    fs.rmSync(files[0]);
    const elsewhere = path.join(tmp, "elsewhere.mp3");
    fs.writeFileSync(elsewhere, "x");
    await db.prepare("UPDATE tracks SET file_path = ? WHERE sub_item_id = ? AND track_number = 2").run(elsewhere, subId);
    const { writer, calls } = stubWriter();

    const summary = await audioRetag.retagTitle(itemId, { writer, throttleMs: 0 });

    expect(calls).toHaveLength(0);
    expect(summary.reasons).toEqual({ "the file is missing": 1, "the file is not inside the title's root folder": 1 });
  });

  it("leaves a title alone while it is being moved", async () => {
    const library = await root("moving", "artist");
    const { itemId } = await title(library);
    titleMoveLock.tryLockTitleMove(itemId);
    const { writer, calls } = stubWriter();

    const summary = await audioRetag.retagTitle(itemId, { writer, throttleMs: 0 });

    expect(calls).toHaveLength(0);
    expect(summary.reasons).toEqual({ "it is being moved or renamed right now": 2 });
    // And the lock it did not take is still the mover's.
    expect(titleMoveLock.isTitleMoving(itemId)).toBe(true);
  });

  it("holds the title's lock while it works and gives it back", async () => {
    const library = await root("lock", "artist");
    const { itemId } = await title(library, { names: ["One"] });
    let during = false;
    const writer: Writer = async () => {
      during = titleMoveLock.isTitleMoving(itemId);
      return { outcome: "written", format: "MP3" };
    };

    await audioRetag.retagTitle(itemId, { writer, throttleMs: 0 });

    expect(during).toBe(true);
    expect(titleMoveLock.isTitleMoving(itemId)).toBe(false);
  });

  it("stops between files when it is cancelled", async () => {
    const library = await root("cancel", "artist");
    const { itemId } = await title(library, { names: ["One", "Two", "Three"] });
    const controller = new AbortController();
    const calls: string[] = [];
    const writer: Writer = async (file) => {
      calls.push(file);
      controller.abort();
      return { outcome: "written", format: "MP3" };
    };

    const summary = await audioRetag.retagTitle(itemId, { writer, throttleMs: 0, signal: controller.signal });

    expect(calls).toHaveLength(1);
    expect(summary).toMatchObject({ cancelled: true, written: 1, files: 1 });
    expect(titleMoveLock.isTitleMoving(itemId)).toBe(false);
  });

  it("refuses a title that is not music or an audiobook, and one that does not exist", async () => {
    const library = await root("movies", "movie");
    const movieId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, has_file, monitored, status) VALUES ('movie', 'Heat', 'heat', ?, 1, 1, 'downloaded')").run(library.id)).lastInsertRowid
    );
    await expect(audioRetag.retagTitle(movieId)).rejects.toMatchObject({ status: 400 });
    await expect(audioRetag.retagTitle(999999)).rejects.toMatchObject({ status: 404 });
  });

  it("writes real tags into real MP3 files and leaves the second run nothing to do", async () => {
    const library = await root("real", "artist");
    const { itemId, files } = await title(library, { names: ["One", "Two"], genres: ["Rock"], externalIds: { musicbrainz: "mb-artist" } });

    const first = await audioRetag.retagTitle(itemId, { throttleMs: 0, settings: { scrub: false, embedCover: false } });

    expect(first).toMatchObject({ written: 2, failed: 0 });
    const tags = NodeID3.read(files[1]);
    expect(tags).toMatchObject({ title: "Two", artist: "Some Artist", album: "Some Album", trackNumber: "2/2", year: "2020", genre: "Rock" });
    expect(tags.userDefinedText).toContainEqual({ description: "MusicBrainz Artist Id", value: "mb-artist" });
    const second = await audioRetag.retagTitle(itemId, { throttleMs: 0, settings: { scrub: false, embedCover: false } });
    expect(second).toMatchObject({ written: 0, skipped: 2 });
    expect(second.reasons).toEqual({ "the tags are already up to date": 2 });
  });
});

describe("the cover", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

  it("recognises a JPEG and a PNG by their first bytes and nothing else", () => {
    expect(audioRetag.coverFromBytes(jpeg)?.mime).toBe("image/jpeg");
    expect(audioRetag.coverFromBytes(png)?.mime).toBe("image/png");
    expect(audioRetag.coverFromBytes(Buffer.from("<html>not a picture</html>"))).toBeNull();
    expect(audioRetag.coverFromBytes(Buffer.alloc(11 * 1024 * 1024, 0xff))).toBeNull();
  });

  it("takes the picture in the album's folder before the provider's, whatever the case of its name", async () => {
    const folder = path.join(tmp, "cover-local");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "Cover.JPG"), jpeg);
    const fetchSpy = vi.fn();

    const cover = await audioRetag.resolveCover(folder, "https://example.com/art.png", fetchSpy as never);

    expect(cover?.mime).toBe("image/jpeg");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("looks in the album's folder for a disc folder", async () => {
    const album = path.join(tmp, "cover-disc");
    fs.mkdirSync(path.join(album, "CD1"), { recursive: true });
    fs.writeFileSync(path.join(album, "folder.png"), png);
    expect((await audioRetag.resolveCover(path.join(album, "CD1"), null))?.mime).toBe("image/png");
  });

  it("falls back to the provider's picture, but never to an address on the local network or a page that is not a picture", async () => {
    const folder = path.join(tmp, "cover-remote");
    fs.mkdirSync(folder, { recursive: true });
    const ok = vi.fn().mockResolvedValue(new Response(png, { status: 200 }));
    expect((await audioRetag.resolveCover(folder, "https://cdn.example.com/a.png", ok as never))?.mime).toBe("image/png");
    expect(ok).toHaveBeenCalledTimes(1);

    const local = vi.fn();
    expect(await audioRetag.resolveCover(folder, "http://192.168.1.5/art.jpg", local as never)).toBeNull();
    expect(await audioRetag.resolveCover(folder, "http://nas/art.jpg", local as never)).toBeNull();
    expect(await audioRetag.resolveCover(folder, "file:///etc/passwd", local as never)).toBeNull();
    expect(await audioRetag.resolveCover(folder, "/api/media/local-artwork/abc", local as never)).toBeNull();
    expect(local).not.toHaveBeenCalled();

    const html = vi.fn().mockResolvedValue(new Response("<html></html>", { status: 200 }));
    expect(await audioRetag.resolveCover(folder, "https://cdn.example.com/a.png", html as never)).toBeNull();
    const down = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await audioRetag.resolveCover(folder, "https://cdn.example.com/a.png", down as never)).toBeNull();
  });
});

describe("the library pass", () => {
  it("retags every music and audiobook title, nothing else, as one tracked job with the counts in its message", async () => {
    const music = await root("lib-music", "artist");
    const books = await root("lib-books", "audiobook");
    const a = await title(music, { names: ["One", "Two"] });
    const b = await title(books, { type: "audiobook", title: "Some Author", names: ["Part 1"], sub: { title: "The Book", narrator: "Reader" } });
    const author = await root("lib-authors", "author");
    await title(author, { type: "author", title: "Ebook Author", names: ["EPUB"], ext: ".epub" });
    const { writer, calls } = stubWriter();

    const summary = await audioRetag.runLibraryRetag(new AbortController().signal, { manual: true, writer, throttleMs: 0 });

    expect(calls.map((c) => c.file).sort()).toEqual([...a.files, ...b.files].sort());
    expect(calls.find((c) => c.file === b.files[0])!.info).toMatchObject({ artist: "Some Author", album: "The Book", composer: "Reader" });
    expect(summary).toMatchObject({ titles: 2, files: 3, written: 3 });
    expect(audioRetag.getLastLibraryRetag()).toBe(summary);
    const job = backgroundJobs.listBackgroundJobs().find((j) => j.id === "retag:library");
    expect(job).toMatchObject({ running: false, total: 2, done: 2, error: null });
    expect(job?.summary).toBe("3 of 3 file(s) written (MP3 3)");
  });

  it("does nothing on its schedule while the mode is none or new, and works for all and sync", async () => {
    const music = await root("lib-sched", "artist");
    await title(music);
    const { writer, calls } = stubWriter();
    const run = () => audioRetag.runLibraryRetag(new AbortController().signal, { writer, throttleMs: 0 });

    for (const mode of ["none", "new"]) {
      setSetting("writeAudioTagsMode", mode);
      expect((await run()).files).toBe(0);
    }
    expect(calls).toHaveLength(0);

    for (const mode of ["all", "sync"]) {
      setSetting("writeAudioTagsMode", mode);
      expect((await run()).written).toBe(2);
    }
    // The button runs whatever the mode.
    setSetting("writeAudioTagsMode", "none");
    expect((await audioRetag.runLibraryRetag(new AbortController().signal, { manual: true, writer, throttleMs: 0 })).written).toBe(2);
  });

  it("stops between titles when it is cancelled and reports failures on the job", async () => {
    const music = await root("lib-cancel", "artist");
    const first = await title(music, { title: "A Artist", names: ["One"] });
    await title(music, { title: "B Artist", names: ["Two"] });
    const controller = new AbortController();
    const writer: Writer = async () => {
      controller.abort();
      return { outcome: "failed", reason: "ffmpeg stopped with code 1: boom", format: "MP3" };
    };

    const summary = await audioRetag.runLibraryRetag(controller.signal, { manual: true, writer, throttleMs: 0 });

    expect(summary).toMatchObject({ cancelled: true, titles: 1, failed: 1 });
    expect(summary.failures[0].file).toBe(first.files[0]);
    expect(backgroundJobs.listBackgroundJobs().find((j) => j.id === "retag:library")?.error).toMatch(/1 file\(s\) could not be tagged/);
  });
});

describe("a single title's retag job", () => {
  it("starts at once, shows in the progress list and ends with the counts", async () => {
    const music = await root("job-title", "artist");
    const { itemId, files } = await title(music, { names: ["One", "Two"] });
    setSetting("writeAudioTagsMode", "new");

    const started = await audioRetag.startTitleRetag(itemId);

    expect(started).toEqual({ started: true, files: 2 });
    await waitFor(() => backgroundJobs.listBackgroundJobs().some((j) => j.id === `retag:title-${itemId}` && !j.running), "the retag job to finish");
    const job = backgroundJobs.listBackgroundJobs().find((j) => j.id === `retag:title-${itemId}`)!;
    expect(job).toMatchObject({ total: 2, done: 2, error: null });
    expect(job.summary).toBe("2 of 2 file(s) written (MP3 2)");
    expect(NodeID3.read(files[0]).title).toBe("One");
  });

  it("refuses a title with no files, one that is being moved, and a type with nothing to tag", async () => {
    const music = await root("job-refuse", "artist");
    const { itemId } = await title(music, { withFiles: true });
    await db.prepare("UPDATE tracks SET has_file = 0, file_path = NULL").run();
    await expect(audioRetag.startTitleRetag(itemId)).rejects.toMatchObject({ status: 400 });

    await db.prepare("UPDATE tracks SET has_file = 1, file_path = '/x' WHERE track_number = 1").run();
    titleMoveLock.tryLockTitleMove(itemId);
    await expect(audioRetag.startTitleRetag(itemId)).rejects.toMatchObject({ status: 409 });

    const movies = await root("job-movies", "movie");
    const movieId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, status) VALUES ('movie', 'Heat', 'heat', ?, 1, 'missing')").run(movies.id)).lastInsertRowid);
    await expect(audioRetag.startTitleRetag(movieId)).rejects.toMatchObject({ status: 400 });
  });

  it("follows an edit only in sync mode", async () => {
    const music = await root("job-sync", "artist");
    const { itemId, files } = await title(music, { names: ["One"] });

    audioRetag.retagTitleAfterEdit(itemId, "artist");
    setSetting("writeAudioTagsMode", "all");
    audioRetag.retagTitleAfterEdit(itemId, "artist");
    await new Promise((r) => setTimeout(r, 150));
    expect(backgroundJobs.listBackgroundJobs().some((j) => j.id === `retag:title-${itemId}`)).toBe(false);
    expect(NodeID3.read(files[0]).title).toBeUndefined();

    setSetting("writeAudioTagsMode", "sync");
    audioRetag.retagTitleAfterEdit(itemId, "movie");
    audioRetag.retagTitleAfterEdit(itemId, "artist");
    await waitFor(() => backgroundJobs.listBackgroundJobs().some((j) => j.id === `retag:title-${itemId}` && !j.running), "the retag after the edit");
    expect(NodeID3.read(files[0]).title).toBe("One");
  });
});

describe("the retag routes", () => {
  const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
  const post = (url: string) => request(app).post(url).set("X-Api-Key", apiKey).send({});

  it("reports the settings in force, the formats it can write and the last run", async () => {
    setSetting("writeAudioTagsOnImport", "1");

    const res = await get("/api/media/retag/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "new", scrub: false, embedCover: false, running: false, last: null });
    expect(res.body.formats).toEqual(expect.arrayContaining([".mp3", ".flac", ".m4a", ".m4b", ".ogg", ".opus"]));
  });

  it("retags a title through the API and answers at once", async () => {
    const music = await root("route-title", "artist");
    const { itemId, files } = await title(music, { names: ["One"] });

    const res = await post(`/api/media/${itemId}/retag`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ started: true, files: 1 });
    await waitFor(() => NodeID3.read(files[0]).title === "One", "the tags to be written");
  });

  it("answers 404 for a title that is not there and 400 for one with nothing to retag", async () => {
    expect((await post("/api/media/424242/retag")).status).toBe(404);
    const books = await root("route-books", "author");
    const { itemId } = await title(books, { type: "author", ext: ".epub" });
    expect((await post(`/api/media/${itemId}/retag`)).status).toBe(400);
  });

  it("runs the library pass as the registered job, and says so when it is already running", async () => {
    const { registerJob, listJobs } = await import("../src/services/jobRegistry.js");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    registerJob({
      key: "audioRetag",
      name: "Retag Audio Files",
      scheduleType: "cron",
      defaultSchedule: "45 4 * * 0",
      heavy: true,
      run: async (signal, info) => {
        await gate;
        await audioRetag.runLibraryRetag(signal, { manual: info?.manual === true, throttleMs: 0 });
      },
    });
    const music = await root("route-lib", "artist");
    const { files } = await title(music, { names: ["One"] });

    const first = await post("/api/media/retag");
    expect(first.body).toEqual({ started: true });
    await waitFor(() => listJobs().find((j) => j.key === "audioRetag")?.running === true, "the job to start");
    expect((await post("/api/media/retag")).body).toEqual({ started: false, reason: "already-running" });
    expect((await get("/api/media/retag/status")).body.running).toBe(true);

    release();
    await waitFor(() => audioRetag.getLastLibraryRetag()?.finishedAt != null, "the pass to finish");
    expect(NodeID3.read(files[0]).title).toBe("One");
    expect((await get("/api/media/retag/status")).body.last).toMatchObject({ titles: 1, written: 1 });
  });
});
