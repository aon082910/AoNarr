import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import NodeID3 from "node-id3";
import { setupTestDb } from "./helpers/testDb.js";
import {
  isLegacyTagSwitch,
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
  // The edit worker waits 5 s after an edit; the tests do not.
  audioRetag.configureEditRetagForTests({ debounceMs: 20, options: { throttleMs: 0 } });
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
    expect(audioRetag.getAudioTagSettings()).toEqual({ mode: "none", scrub: false, embedCover: false, legacy: false });
    setSetting("writeAudioTagsOnImport", "1");
    expect(audioRetag.getAudioTagSettings().mode).toBe("new");
    expect(audioRetag.writeTagsOnImportEnabled()).toBe(true);
    setSetting("writeAudioTagsMode", "none");
    expect(audioRetag.getAudioTagSettings().mode).toBe("none");
    expect(audioRetag.writeTagsOnImportEnabled()).toBe(false);
    setSetting("writeAudioTagsMode", "sync");
    setSetting("scrubAudioTags", "1");
    setSetting("embedAudioCover", "1");
    expect(audioRetag.getAudioTagSettings()).toEqual({ mode: "sync", scrub: true, embedCover: true, legacy: false });
  });

  it("the old on/off switch stays the old, MP3-only switch until a mode is chosen", () => {
    // Nothing chosen and the switch on: legacy. Any explicit mode (even "new") ends it, and the switch off is not legacy.
    expect(isLegacyTagSwitch(undefined, "1")).toBe(true);
    expect(isLegacyTagSwitch("", "1")).toBe(true);
    expect(isLegacyTagSwitch("bogus", "1")).toBe(true);
    expect(isLegacyTagSwitch("", "0")).toBe(false);
    expect(isLegacyTagSwitch(undefined, undefined)).toBe(false);
    for (const mode of ["none", "new", "all", "sync"]) expect(isLegacyTagSwitch(mode, "1")).toBe(false);

    setSetting("writeAudioTagsOnImport", "1");
    expect(audioRetag.getAudioTagSettings()).toMatchObject({ mode: "new", legacy: true });
    setSetting("writeAudioTagsMode", "new");
    expect(audioRetag.getAudioTagSettings()).toMatchObject({ mode: "new", legacy: false });
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
    expect(summary.reasons).toEqual({ "it is being moved, renamed or retagged right now": 2 });
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
    const ok = vi.fn().mockResolvedValue(new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    expect((await audioRetag.resolveCover(folder, "https://cdn.example.com/a.png", ok as never))?.mime).toBe("image/png");
    expect(ok).toHaveBeenCalledTimes(1);

    const local = vi.fn();
    expect(await audioRetag.resolveCover(folder, "http://192.168.1.5/art.jpg", local as never)).toBeNull();
    expect(await audioRetag.resolveCover(folder, "http://nas/art.jpg", local as never)).toBeNull();
    expect(await audioRetag.resolveCover(folder, "file:///etc/passwd", local as never)).toBeNull();
    expect(await audioRetag.resolveCover(folder, "/api/media/local-artwork/abc", local as never)).toBeNull();
    expect(local).not.toHaveBeenCalled();

    const html = vi.fn().mockResolvedValue(new Response("<html></html>", { status: 200, headers: { "content-type": "image/png" } }));
    expect(await audioRetag.resolveCover(folder, "https://cdn.example.com/a.png", html as never)).toBeNull();
    const down = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await audioRetag.resolveCover(folder, "https://cdn.example.com/a.png", down as never)).toBeNull();
  });

  describe("the provider's picture is fetched like the artwork files are", () => {
    const folder = () => {
      const dir = fs.mkdtempSync(path.join(tmp, "cover-fetch-"));
      return dir;
    };
    const image = (body: BodyInit, type = "image/png") => new Response(body, { status: 200, headers: { "content-type": type } });

    it("refuses a redirect to an address on the local network, and never asks it", async () => {
      const hops = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://192.168.1.1/admin/reboot" } })).mockResolvedValue(image(png));

      expect(await audioRetag.resolveCover(folder(), "https://cdn.example.com/a.png", hops as never)).toBeNull();

      expect(hops).toHaveBeenCalledTimes(1);
      // Redirects are followed by hand, each hop checked: the fetch itself is told not to follow them.
      expect(hops.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
      // Neither a redirect to a host name that has no dots, nor one to a loopback address, is followed.
      for (const location of ["http://nas/art.png", "http://127.0.0.1:8080/art.png", "http://[::1]/art.png"]) {
        const hop = vi.fn().mockResolvedValueOnce(new Response(null, { status: 301, headers: { location } })).mockResolvedValue(image(png));
        expect(await audioRetag.resolveCover(folder(), "https://cdn.example.com/a.png", hop as never), location).toBeNull();
        expect(hop, location).toHaveBeenCalledTimes(1);
      }
    });

    it("follows a redirect to another public address", async () => {
      const hops = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://img.example.net/full/a.png" } })).mockResolvedValue(image(png));

      const cover = await audioRetag.resolveCover(folder(), "https://cdn.example.com/a.png", hops as never);

      expect(cover?.mime).toBe("image/png");
      expect(hops).toHaveBeenCalledTimes(2);
      expect(hops.mock.calls[1][0]).toBe("https://img.example.net/full/a.png");
    });

    it("stops reading a body without a content-length once it is past the cap", async () => {
      let pulled = 0;
      const chunk = new Uint8Array(1024 * 1024).fill(0xff);
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(chunk);
          if (pulled >= 200) controller.close();
        },
      });
      const fetchEndless = vi.fn().mockResolvedValue(image(endless, "image/jpeg"));

      expect(await audioRetag.resolveCover(folder(), "https://cdn.example.com/huge.jpg", fetchEndless as never)).toBeNull();

      // 15 MB is the cap: a few chunks past it were read, not the 200 MB the server offered.
      expect(pulled).toBeLessThan(40);
    });

    it("uses a good picture, and not a JPEG-less or PNG-less one such as a GIF or WebP", async () => {
      const jpegCover = await audioRetag.resolveCover(folder(), "https://cdn.example.com/a.jpg", vi.fn().mockResolvedValue(image(jpeg, "image/jpeg")) as never);
      expect(jpegCover?.mime).toBe("image/jpeg");
      const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32, 1)]);
      expect(await audioRetag.resolveCover(folder(), "https://cdn.example.com/a.gif", vi.fn().mockResolvedValue(image(gif, "image/gif")) as never)).toBeNull();
    });
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
    expect(audioRetag.pendingEditRetags()).toEqual({ queued: 0, active: false });
    expect(backgroundJobs.listBackgroundJobs().some((j) => j.id === "retag:edits")).toBe(false);
    expect(NodeID3.read(files[0]).title).toBeUndefined();

    setSetting("writeAudioTagsMode", "sync");
    audioRetag.retagTitleAfterEdit(itemId, "movie");
    expect(audioRetag.pendingEditRetags().queued).toBe(0);
    audioRetag.retagTitleAfterEdit(itemId, "artist");
    await waitFor(() => backgroundJobs.listBackgroundJobs().some((j) => j.id === "retag:edits" && !j.running), "the retag after the edit");
    expect(NodeID3.read(files[0]).title).toBe("One");
    expect(backgroundJobs.listBackgroundJobs().find((j) => j.id === "retag:edits")).toMatchObject({ total: 1, done: 1, error: null, summary: "1 of 1 file(s) written (MP3 1)" });
  });
});

describe("following edits (sync mode)", () => {
  const quiet = () => new Promise((r) => setTimeout(r, 200));
  const idle = (what: string) => waitFor(() => !audioRetag.pendingEditRetags().active, what, 60_000);

  it("keeps a set of titles, not a job per edit: 5,000 edits of 200 titles are 200 retags, two files at most at once", async () => {
    setSetting("writeAudioTagsMode", "sync");
    const music = await root("edits-many", "artist");
    const titles: Fixture[] = [];
    for (let i = 0; i < 200; i++) titles.push(await title(music, { title: `Edited Artist ${i}`, names: ["One"] }));

    const { writeAudioTags } = await import("../src/services/audioTagWriter.js");
    const retagged: string[] = [];
    const countingWriter: Writer = async (file, info, options) => {
      retagged.push(file);
      return writeAudioTags(file, info, options);
    };
    // Counted where an MP3 is really rewritten (read in whole, renamed over), whoever asks.
    let active = 0;
    let peak = 0;
    const realRead = fsp.readFile.bind(fsp) as (...args: unknown[]) => Promise<unknown>;
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "readFile").mockImplementation((async (...args: unknown[]) => {
      if (!String(args[0]).endsWith(".mp3")) return realRead(...args);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      return realRead(...args);
    }) as never);
    vi.spyOn(fsp, "rename").mockImplementation((async (from: string, to: string) => {
      await realRename(from, to);
      if (String(to).endsWith(".mp3")) active--;
    }) as never);
    audioRetag.configureEditRetagForTests({ debounceMs: 10, options: { throttleMs: 0, writer: countingWriter } });

    const jobsBefore = backgroundJobs.listBackgroundJobs().map((j) => j.id).sort();
    const started = performance.now();
    for (let n = 0; n < 5000; n++) audioRetag.retagTitleAfterEdit(titles[n % 200].itemId, "artist");
    const elapsed = performance.now() - started;

    // Constant time each: 5,000 edits queue in a few milliseconds, as 200 ids, and no job of their own was started.
    expect(elapsed).toBeLessThan(250);
    expect(audioRetag.pendingEditRetags()).toEqual({ queued: 200, active: true });
    expect(backgroundJobs.listBackgroundJobs().map((j) => j.id).sort()).toEqual(jobsBefore);

    // While the worker is at it, eight imports tag files of their own: together never more than two files are being rewritten.
    await new Promise((r) => setTimeout(r, 40));
    const imported = Array.from({ length: 8 }, (_, i) => {
      const file = path.join(music.dir, "imported-" + i + ".mp3");
      fs.writeFileSync(file, Buffer.from("pretend audio"));
      return file;
    });
    const importResults = await Promise.all(imported.map((file) => writeAudioTags(file, { title: "Imported", artist: "Someone", album: "Else" })));
    expect(importResults.map((r) => r.outcome)).toEqual(Array(8).fill("written"));

    await idle("the worker to retag 200 titles");

    expect(retagged).toHaveLength(200);
    expect(new Set(retagged).size).toBe(200);
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(2);
    expect(NodeID3.read(titles[0].files[0]).artist).toBe("Edited Artist 0");
    expect(NodeID3.read(titles[199].files[0]).artist).toBe("Edited Artist 199");
    // One job for the whole pass, not one per title.
    const jobsAfter = backgroundJobs.listBackgroundJobs().map((j) => j.id).filter((id) => !jobsBefore.includes(id) || id === "retag:edits");
    expect(jobsAfter).toEqual(["retag:edits"]);
    expect(backgroundJobs.listBackgroundJobs().find((j) => j.id === "retag:edits")).toMatchObject({ running: false, total: 200, done: 200, error: null });
  }, 60_000);

  it("a burst of edits is one pass, and a title edited ten times is retagged once", async () => {
    setSetting("writeAudioTagsMode", "sync");
    const music = await root("edits-burst", "artist");
    const { itemId } = await title(music, { names: ["One"] });
    const { writer, calls } = stubWriter();
    audioRetag.configureEditRetagForTests({ debounceMs: 100, options: { throttleMs: 0, writer } });

    for (let n = 0; n < 10; n++) {
      audioRetag.retagTitleAfterEdit(itemId, "artist");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls).toHaveLength(0);
    await idle("the pass");

    expect(calls).toHaveLength(1);
  });

  it("goes again for a title that is edited while its files are being retagged", async () => {
    setSetting("writeAudioTagsMode", "sync");
    const music = await root("edits-again", "artist");
    const { itemId } = await title(music, { names: ["One"] });
    const seen: string[] = [];
    let edited = false;
    const writer: Writer = async (file, info) => {
      seen.push(info.artist);
      if (!edited) {
        edited = true;
        await db.prepare("UPDATE media_items SET title = 'Second Name' WHERE id = ?").run(itemId);
        audioRetag.retagTitleAfterEdit(itemId, "artist");
      }
      return { outcome: "written", format: "MP3" };
    };
    audioRetag.configureEditRetagForTests({ debounceMs: 20, options: { throttleMs: 0, writer } });

    audioRetag.retagTitleAfterEdit(itemId, "artist");
    await idle("both passes");

    expect(seen).toEqual(["Some Artist", "Second Name"]);
  });

  it("waits for a title that is being moved or retagged by hand, then retags it", async () => {
    setSetting("writeAudioTagsMode", "sync");
    const music = await root("edits-busy", "artist");
    const { itemId } = await title(music, { names: ["One"] });
    const { writer, calls } = stubWriter();
    audioRetag.configureEditRetagForTests({ debounceMs: 20, options: { throttleMs: 0, writer } });
    titleMoveLock.tryLockTitleMove(itemId);

    audioRetag.retagTitleAfterEdit(itemId, "artist");
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toHaveLength(0);
    expect(audioRetag.pendingEditRetags().queued).toBe(1);

    titleMoveLock.unlockTitleMove(itemId);
    await idle("the title to be retagged");
    expect(calls).toHaveLength(1);
  });

  it("drops the waiting titles when the mode is changed away from sync", async () => {
    setSetting("writeAudioTagsMode", "sync");
    const music = await root("edits-off", "artist");
    const { itemId } = await title(music, { names: ["One"] });
    const { writer, calls } = stubWriter();
    audioRetag.configureEditRetagForTests({ debounceMs: 50, options: { throttleMs: 0, writer } });

    audioRetag.retagTitleAfterEdit(itemId, "artist");
    setSetting("writeAudioTagsMode", "new");
    await idle("the worker");

    expect(calls).toHaveLength(0);
    expect(audioRetag.pendingEditRetags()).toEqual({ queued: 0, active: false });
  });

  describe("through the routes, only an edit that changes what the files carry is followed", () => {
    const patch = (url: string, body: object) => request(app).patch(url).set("X-Api-Key", apiKey).send(body);
    const rematch = (url: string, body: object) => request(app).post(url).set("X-Api-Key", apiKey).send(body);

    it("a title PATCH that sends the same name, or changes only the year, overview or poster, queues nothing", async () => {
      setSetting("writeAudioTagsMode", "sync");
      const music = await root("route-same", "artist");
      const { itemId } = await title(music, { names: ["One"], genres: ["Rock"] });
      const { writer, calls } = stubWriter();
      audioRetag.configureEditRetagForTests({ debounceMs: 30, options: { throttleMs: 0, writer } });

      expect((await patch(`/api/media/${itemId}`, { title: "Some Artist" })).status).toBe(200);
      expect((await patch(`/api/media/${itemId}`, { title: "Some Artist", year: 2021, overview: "About", posterUrl: "https://example.com/p.jpg" })).status).toBe(200);
      expect((await patch(`/api/media/${itemId}`, { monitored: 0 })).status).toBe(200);
      await quiet();
      expect(calls).toHaveLength(0);

      expect((await patch(`/api/media/${itemId}`, { title: "Another Name" })).status).toBe(200);
      await idle("the retag");
      expect(calls).toHaveLength(1);
      expect(calls[0].info.artist).toBe("Another Name");
    });

    it("a PATCH of an album that sends the narrator it has queues nothing; a different one does", async () => {
      setSetting("writeAudioTagsMode", "sync");
      const books = await root("route-same-books", "audiobook");
      const book = await title(books, { type: "audiobook", title: "Some Author", names: ["Part"], sub: { title: "The Book", narrator: "A Reader", series_name: "A Series", series_position: 2 } });
      const { writer, calls } = stubWriter();
      audioRetag.configureEditRetagForTests({ debounceMs: 30, options: { throttleMs: 0, writer } });
      const url = `/api/media/${book.itemId}/subitems/${book.subId}`;

      expect((await patch(url, { narrator: "A Reader", seriesName: "A Series", seriesPosition: 2 })).status).toBe(200);
      expect((await patch(url, { seriesPosition: "2", monitored: 1 })).status).toBe(200);
      await quiet();
      expect(calls).toHaveLength(0);

      expect((await patch(url, { narrator: "Another Reader" })).status).toBe(200);
      await idle("the retag");
      expect(calls).toHaveLength(1);
      expect(calls[0].info.composer).toBe("Another Reader");
    });

    it("a rematch to the same match queues nothing", async () => {
      setSetting("writeAudioTagsMode", "sync");
      const music = await root("route-rematch", "artist");
      const artist = await title(music, { names: ["One"], genres: ["Rock"], sub: { title: "Some Album", release_date: "2020-05-06", external_id: "g1", external_provider: "musicbrainz" } });
      const { writer, calls } = stubWriter();
      audioRetag.configureEditRetagForTests({ debounceMs: 30, options: { throttleMs: 0, writer } });

      expect((await rematch(`/api/media/${artist.itemId}/subitems/${artist.subId}/rematch`, { title: "Some Album", releaseDate: "2020-05-06", externalIds: { musicbrainz: "g1" } })).status).toBe(200);
      expect((await rematch(`/api/media/${artist.itemId}/rematch`, { title: "Some Artist", genres: ["Rock"] })).status).toBe(200);
      await quiet();
      expect(calls).toHaveLength(0);

      expect((await rematch(`/api/media/${artist.itemId}/rematch`, { title: "Some Artist", genres: ["Jazz"] })).status).toBe(200);
      await idle("the retag");
      expect(calls).toHaveLength(1);
    });
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

  it("follows an edit of the title, an album or a book's narrator, and a rematch, in sync mode only", async () => {
    const music = await root("route-edit", "artist");
    const books = await root("route-edit-books", "audiobook");
    const artist = await title(music, { names: ["One"] });
    const book = await title(books, { type: "audiobook", title: "Some Author", names: ["Part"], sub: { title: "The Book" } });
    const patch = (url: string, body: object) => request(app).patch(url).set("X-Api-Key", apiKey).send(body);

    // Not in "all": nothing follows the edit.
    setSetting("writeAudioTagsMode", "all");
    expect((await patch(`/api/media/${artist.itemId}`, { title: "Edited Artist" })).status).toBe(200);
    expect((await patch(`/api/media/${book.itemId}/subitems/${book.subId}`, { narrator: "Early Reader" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(NodeID3.read(artist.files[0]).artist).toBeUndefined();
    expect(NodeID3.read(book.files[0]).composer).toBeUndefined();

    setSetting("writeAudioTagsMode", "sync");
    expect((await patch(`/api/media/${artist.itemId}`, { title: "Edited Again" })).status).toBe(200);
    await waitFor(() => NodeID3.read(artist.files[0]).artist === "Edited Again", "the artist's file to follow the edit");
    expect((await patch(`/api/media/${book.itemId}/subitems/${book.subId}`, { narrator: "Late Reader", seriesName: "A Series", seriesPosition: 3 })).status).toBe(200);
    await waitFor(() => NodeID3.read(book.files[0]).composer === "Late Reader", "the book's file to follow the narrator");
    expect(NodeID3.read(book.files[0]).contentGroup).toBe("A Series");

    const rematch = await request(app).post(`/api/media/${artist.itemId}/subitems/${artist.subId}/rematch`).set("X-Api-Key", apiKey).send({ title: "Rematched Album" });
    expect(rematch.status).toBe(200);
    await waitFor(() => NodeID3.read(artist.files[0]).album === "Rematched Album", "the file to follow the rematch");
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
