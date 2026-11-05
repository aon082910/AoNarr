import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";
import { matchAlbumFolders, type FolderMatch, type MatchableAlbum } from "../src/services/discographyMatch.js";
import {
  fileAlbumTagsFrom,
  identifyFolderByTags,
  matchFoldersByTags,
  sampleFiles,
  TAG_FILES_PER_FOLDER,
  TAG_FOLDERS_PER_RELEASE,
  type FileAlbumTags,
  type TagFolder,
  type TagReader,
} from "../src/services/discographyTags.js";

// Round 30h: a folder of a downloaded discography whose NAME says nothing ("CD1 - misc rips") is identified by the tags of a few of
// its files, as a second step after the name step; and the import of a discography runs on the import lane, not in the queue poll.

const notifyImported = vi.fn();
const notifyManualInteractionRequired = vi.fn();
vi.mock("../src/services/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/notifications.js")>()),
  notifyImported: (...args: unknown[]) => notifyImported(...args),
  notifyManualInteractionRequired: (...args: unknown[]) => notifyManualInteractionRequired(...args),
}));

vi.mock("../src/services/audioTagWriter.js", () => ({ writeAudioTags: vi.fn() }));

const unpackDownloadedArchives = vi.fn();
vi.mock("../src/services/archiveExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/archiveExtract.js")>()),
  unpackDownloadedArchives: (...args: unknown[]) => unpackDownloadedArchives(...args),
}));

const getDownloadClientAdapter = vi.fn();
const removeQueueItemDownload = vi.fn();
const markDownloadImported = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
  removeQueueItemDownload: (...args: unknown[]) => removeQueueItemDownload(...args),
  markDownloadImported: (...args: unknown[]) => markDownloadImported(...args),
}));

vi.mock("../src/services/ffprobe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ffprobe.js")>()),
  probeMediaInfo: vi.fn().mockResolvedValue(null),
}));

// The real reader runs ffprobe, which the node image does not have: the import tests tell the tags by folder.
const readTags = vi.fn();
vi.mock("../src/services/discographyTags.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/discographyTags.js")>()),
  readFileAlbumTags: (...args: unknown[]) => readTags(...args),
}));

// ---- the decision, without a database or ffprobe -----------------------------------------------------------------------

const ALBUMS: MatchableAlbum[] = [
  { id: 1, title: "Queen", releaseDate: "1973-07-13", target: true },
  { id: 2, title: "Queen II", releaseDate: "1974-03-08", target: true },
  { id: 3, title: "Sheer Heart Attack", releaseDate: "1974-11-08", target: true },
  { id: 4, title: "A Night at the Opera", releaseDate: "1975-11-21", target: true },
  { id: 5, title: "Greatest Hits", releaseDate: "1981-10-26", target: true },
  { id: 6, title: "Greatest Hits", releaseDate: "2000-01-01", target: true },
];

function folderOf(name: string, fileCount = 10): TagFolder {
  const dir = `/dl/Queen - Discography/${name}`;
  return { path: dir, name, files: fileCount, audioFiles: Array.from({ length: fileCount }, (_, i) => `${dir}/${String(i + 1).padStart(3, "0")} - Song.flac`) };
}

const tagsOf = (album: string | null, extra: Partial<FileAlbumTags> = {}): FileAlbumTags => ({ album, artist: "Queen", year: null, disc: null, discTotal: null, ...extra });

/** A reader that answers by the folder a file is in, and keeps the files it was asked about. */
function readerFor(byFolder: Record<string, FileAlbumTags | null | "throws">) {
  const asked: string[] = [];
  const reader: TagReader = async (file) => {
    asked.push(file);
    const answer = byFolder[path.basename(path.dirname(file))];
    if (answer === "throws") throw new Error("ffprobe blew up");
    return answer ?? null;
  };
  return { reader, asked, foldersAsked: () => new Set(asked.map((file) => path.basename(path.dirname(file)))) };
}

async function run(folders: TagFolder[], byFolder: Record<string, FileAlbumTags | null | "throws">, extra: { albums?: MatchableAlbum[]; onlyFolder?: string; releaseDir?: string; maxFolders?: number } = {}) {
  const albums = extra.albums ?? ALBUMS;
  const reading = readerFor(byFolder);
  const nameMatches = matchAlbumFolders(folders, "Queen", albums);
  const result = await matchFoldersByTags(folders, albums, nameMatches, reading.reader, { artist: "Queen", releaseDir: extra.releaseDir, onlyFolder: extra.onlyFolder, maxFolders: extra.maxFolders });
  const matchOf = (name: string): FolderMatch => result.matches.get(`/dl/Queen - Discography/${name}`)!;
  return { ...result, ...reading, matchOf, nameMatches };
}

describe("naming a folder from the tags of its files", () => {
  it("identifies a folder whose name says nothing by its album tag", async () => {
    const r = await run([folderOf("CD1 - misc rips")], { "CD1 - misc rips": tagsOf("Queen II", { year: 1974 }) });
    expect(r.nameMatches.get("/dl/Queen - Discography/CD1 - misc rips")).toMatchObject({ kind: "unmatched" });
    expect(r.matchOf("CD1 - misc rips")).toEqual({ kind: "album", albumId: 2, target: true, by: "tags" });
    expect(r.identified).toBe(1);
  });

  it("reads the same words as the name step: editions, rip tags and disc markers do not matter, other words do", async () => {
    const r = await run([folderOf("a"), folderOf("b"), folderOf("c"), folderOf("d")], {
      a: tagsOf("Queen II (Deluxe Edition) [Remastered]"),
      b: tagsOf("A Night At The Opera (Disc 1)", { disc: 1 }),
      c: tagsOf("queen ii live"),
      d: tagsOf("Queen III"),
    });
    expect(r.matchOf("a")).toMatchObject({ kind: "album", albumId: 2, by: "tags" });
    expect(r.matchOf("b")).toMatchObject({ kind: "album", albumId: 4, by: "tags" });
    expect(r.matchOf("c")).toMatchObject({ kind: "unmatched" });
    expect(r.matchOf("d")).toMatchObject({ kind: "unmatched" });
    expect(r.matchOf("d")).toMatchObject({ reason: expect.stringContaining("by its tags") });
  });

  it("never reads a folder the name matched, and never overrides a name", async () => {
    const r = await run([folderOf("1974 - Queen II"), folderOf("1973 - Queen"), folderOf("odd folder")], {
      "1974 - Queen II": tagsOf("Sheer Heart Attack"),
      "1973 - Queen": tagsOf("Sheer Heart Attack"),
      "odd folder": tagsOf("Sheer Heart Attack"),
    });
    expect(r.matchOf("1974 - Queen II")).toEqual({ kind: "album", albumId: 2, target: true });
    expect(r.matchOf("1973 - Queen")).toEqual({ kind: "album", albumId: 1, target: true });
    expect(r.matchOf("odd folder")).toMatchObject({ kind: "album", albumId: 3, by: "tags" });
    expect(r.foldersAsked()).toEqual(new Set(["odd folder"]));
    expect(r.probed).toBe(1);
  });

  it("makes a folder that the tags show to be a second copy of an album the name already settled a duplicate", async () => {
    const r = await run([folderOf("1974 - Queen II"), folderOf("rip 2")], { "rip 2": tagsOf("Queen II") });
    expect(r.matchOf("1974 - Queen II")).toEqual({ kind: "album", albumId: 2, target: true });
    expect(r.matchOf("rip 2")).toMatchObject({ kind: "duplicate", albumId: 2 });
    expect(r.identified).toBe(0);
  });

  it("refuses an album of another artist", async () => {
    const r = await run([folderOf("misc")], { misc: tagsOf("Queen II", { artist: "Queen Latifah" }) });
    expect(r.matchOf("misc")).toMatchObject({ kind: "unmatched", reason: expect.stringContaining("Queen Latifah") });
    expect(r.identified).toBe(0);
  });

  it("refuses a Various Artists compilation, whatever its album is called", async () => {
    for (const artist of ["Various Artists", "various artists", "VA", "Various"]) {
      const r = await run([folderOf("misc")], { misc: tagsOf("Queen II", { artist }) });
      expect(r.matchOf("misc"), artist).toMatchObject({ kind: "unmatched", reason: expect.stringContaining("compilation") });
    }
  });

  it("counts the album artist before the track artist, and the same letters as the same artist", async () => {
    // fileAlbumTagsFrom puts the album artist first, so a guest on the track does not matter.
    expect(fileAlbumTagsFrom({ artist: "Queen feat. David Bowie", albumArtist: "Queen", author: null, album: "Queen II", title: "x" })).toMatchObject({ artist: "Queen" });
    const acdc = [{ id: 9, title: "Back in Black", releaseDate: "1980-07-25", target: true }];
    const folder = folderOf("misc");
    const reading = readerFor({ misc: tagsOf("Back in Black", { artist: "ACDC" }) });
    const result = await matchFoldersByTags([folder], acdc, matchAlbumFolders([folder], "AC/DC", acdc), reading.reader, { artist: "AC/DC" });
    expect(result.matches.get(folder.path)).toMatchObject({ kind: "album", albumId: 9, by: "tags" });
  });

  it("leaves a folder whose files carry different albums whole (ambiguous)", async () => {
    const folder = folderOf("mixed", 9);
    const albumOf = (file: string) => (file.includes("/001 ") ? "Queen II" : file.includes("/005 ") ? "Sheer Heart Attack" : "Queen II");
    const result = await matchFoldersByTags([folder], ALBUMS, matchAlbumFolders([folder], "Queen", ALBUMS), async (file) => tagsOf(albumOf(file)), { artist: "Queen" });
    expect(result.matches.get(folder.path)).toMatchObject({ kind: "ambiguous", reason: expect.stringContaining("different album tags") });
  });

  it("leaves a folder with a file that has no album tag, or none that can be read", async () => {
    const r1 = await run([folderOf("untagged")], { untagged: tagsOf(null) });
    expect(r1.matchOf("untagged")).toMatchObject({ kind: "unmatched" });
    const noArtist = await run([folderOf("untagged")], { untagged: tagsOf("Queen II", { artist: null }) });
    expect(noArtist.matchOf("untagged")).toMatchObject({ kind: "unmatched" });
    const unreadable = await run([folderOf("broken")], { broken: null });
    expect(unreadable.matchOf("broken")).toEqual(unreadable.nameMatches.get("/dl/Queen - Discography/broken"));
    expect(unreadable.identified).toBe(0);
  });

  it("does not guess when one file of the sample could not be read", async () => {
    const folder = folderOf("half");
    let n = 0;
    const result = await matchFoldersByTags([folder], ALBUMS, matchAlbumFolders([folder], "Queen", ALBUMS), async () => (n++ === 1 ? null : tagsOf("Queen II")), { artist: "Queen" });
    expect(result.matches.get(folder.path)).toMatchObject({ kind: "unmatched" });
    expect(result.identified).toBe(0);
  });

  it("survives a reader that throws", async () => {
    const r = await run([folderOf("boom")], { boom: "throws" });
    expect(r.matchOf("boom")).toMatchObject({ kind: "unmatched" });
    expect(r.identified).toBe(0);
  });

  describe("two albums of one title", () => {
    it("breaks the tie with the year tag", async () => {
      const r = await run([folderOf("old hits"), folderOf("new hits")], { "old hits": tagsOf("Greatest Hits", { year: 1981 }), "new hits": tagsOf("Greatest Hits", { year: 2000 }) });
      expect(r.matchOf("old hits")).toMatchObject({ kind: "album", albumId: 5, by: "tags" });
      expect(r.matchOf("new hits")).toMatchObject({ kind: "album", albumId: 6, by: "tags" });
    });

    it("settles a folder the name left ambiguous for want of a year", async () => {
      const r = await run([folderOf("Greatest Hits")], { "Greatest Hits": tagsOf("Greatest Hits", { year: 2000 }) });
      expect(r.nameMatches.get("/dl/Queen - Discography/Greatest Hits")).toMatchObject({ kind: "ambiguous" });
      expect(r.matchOf("Greatest Hits")).toMatchObject({ kind: "album", albumId: 6, by: "tags" });
    });

    it("stays ambiguous when the tags name no year, a year that fits neither, or two years", async () => {
      for (const year of [null, 1999]) {
        const r = await run([folderOf("hits")], { hits: tagsOf("Greatest Hits", { year }) });
        expect(r.matchOf("hits"), String(year)).toMatchObject({ kind: "ambiguous" });
      }
      const folder = folderOf("hits", 9);
      const result = await matchFoldersByTags([folder], ALBUMS, matchAlbumFolders([folder], "Queen", ALBUMS), async (file) => tagsOf("Greatest Hits", { year: file.includes("/001 ") ? 1981 : 2000 }), { artist: "Queen" });
      expect(result.matches.get(folder.path)).toMatchObject({ kind: "ambiguous" });
    });
  });

  describe("the discs of one album in folders of their own", () => {
    const discs = (a: Partial<FileAlbumTags>, b: Partial<FileAlbumTags>) => ({
      "A Night at the Opera CD1": tagsOf("A Night at the Opera", { disc: 1, discTotal: 2, ...a }),
      "A Night at the Opera CD2": tagsOf("A Night at the Opera", { disc: 2, discTotal: 2, ...b }),
    });

    it("are one album when the tags agree, and are placed together (the name step leaves them whole)", async () => {
      const folders = [folderOf("A Night at the Opera CD1", 5), folderOf("A Night at the Opera CD2", 4)];
      const r = await run(folders, discs({}, {}));
      expect(r.nameMatches.get(folders[0].path)).toMatchObject({ kind: "ambiguous" });
      const expected = { kind: "album", albumId: 4, target: true, by: "tags", discs: [{ path: folders[0].path, disc: 1 }, { path: folders[1].path, disc: 2 }] };
      expect(r.matchOf("A Night at the Opera CD1")).toEqual(expected);
      expect(r.matchOf("A Night at the Opera CD2")).toEqual(expected);
      expect(r.identified).toBe(2);
    });

    it("are one album with no disc total in the tags, when the numbers run 1, 2", async () => {
      const r = await run([folderOf("A Night at the Opera CD1"), folderOf("A Night at the Opera CD2")], discs({ discTotal: null }, { discTotal: null }));
      expect(r.matchOf("A Night at the Opera CD1")).toMatchObject({ kind: "album", by: "tags", discs: [{ disc: 1 }, { disc: 2 }] });
    });

    it("are not one album when the disc numbers repeat", async () => {
      const r = await run([folderOf("A Night at the Opera CD1"), folderOf("A Night at the Opera CD2")], discs({}, { disc: 1 }));
      expect(r.matchOf("A Night at the Opera CD1")).toMatchObject({ kind: "ambiguous", reason: expect.stringContaining("same disc") });
      expect(r.matchOf("A Night at the Opera CD2")).toMatchObject({ kind: "ambiguous" });
      expect(r.identified).toBe(0);
    });

    it("are not one album when the count of folders is not the count of discs the tags give", async () => {
      const r = await run([folderOf("A Night at the Opera CD1"), folderOf("A Night at the Opera CD2")], discs({ discTotal: 3 }, { discTotal: 3 }));
      expect(r.matchOf("A Night at the Opera CD1")).toMatchObject({ kind: "ambiguous", reason: expect.stringContaining("3 discs") });
      const gap = await run([folderOf("A Night at the Opera CD1"), folderOf("A Night at the Opera CD2")], discs({}, { disc: 3, discTotal: 3 }));
      expect(gap.matchOf("A Night at the Opera CD2")).toMatchObject({ kind: "ambiguous" });
    });

    it("are not one album when the albums differ: each folder goes to its own", async () => {
      const r = await run([folderOf("Disc A"), folderOf("Disc B")], {
        "Disc A": tagsOf("Queen II", { disc: 1, discTotal: 1 }),
        "Disc B": tagsOf("Sheer Heart Attack", { disc: 1, discTotal: 1 }),
      });
      expect(r.matchOf("Disc A")).toEqual({ kind: "album", albumId: 2, target: true, by: "tags" });
      expect(r.matchOf("Disc B")).toEqual({ kind: "album", albumId: 3, target: true, by: "tags" });
    });

    it("are not one album when a folder keeps its tracks in subfolders (they would be left behind)", async () => {
      const nested: TagFolder = { ...folderOf("A Night at the Opera CD1", 2), audioFiles: ["/dl/Queen - Discography/A Night at the Opera CD1/Part 1/001 - Song.flac", "/dl/Queen - Discography/A Night at the Opera CD1/Part 1/002 - Song.flac"] };
      const r = await run([nested, folderOf("A Night at the Opera CD2")], { "Part 1": discs({}, {})["A Night at the Opera CD1"], "A Night at the Opera CD2": discs({}, {})["A Night at the Opera CD2"] });
      expect(r.matchOf("A Night at the Opera CD1")).toMatchObject({ kind: "ambiguous", reason: expect.stringContaining("subfolders") });
      expect(r.identified).toBe(0);
    });

    it("are not one album when their artists differ", async () => {
      const r = await run([folderOf("A Night at the Opera CD1"), folderOf("A Night at the Opera CD2")], discs({}, { artist: "Someone Else" }));
      expect(r.matchOf("A Night at the Opera CD2")).toMatchObject({ kind: "ambiguous", reason: expect.stringContaining("Someone Else") });
      expect(r.matchOf("A Night at the Opera CD1")).toMatchObject({ kind: "ambiguous", reason: expect.stringContaining("disc 1 of the 2") });
    });

    it("leaves one disc of several alone, unless the admin picked its folder", async () => {
      const only = { "misc rips CD2": tagsOf("A Night at the Opera", { disc: 2, discTotal: 2 }) };
      const lone = await run([folderOf("misc rips CD2")], only);
      expect(lone.matchOf("misc rips CD2")).toMatchObject({ kind: "ambiguous", reason: expect.stringContaining("disc 2 of the 2") });
      const picked = await run([folderOf("misc rips CD2")], only, { onlyFolder: folderOf("misc rips CD2").path });
      expect(picked.matchOf("misc rips CD2")).toMatchObject({ kind: "album", albumId: 4, by: "tags" });
    });

    it("takes a folder that holds several discs itself as the whole album", async () => {
      const folder = folderOf("Opera 2CD", 8);
      const result = await matchFoldersByTags([folder], ALBUMS, matchAlbumFolders([folder], "Queen", ALBUMS), async (file) => tagsOf("A Night at the Opera", { disc: file.includes("/008 ") ? 2 : 1, discTotal: 2 }), { artist: "Queen" });
      expect(result.matches.get(folder.path)).toEqual({ kind: "album", albumId: 4, target: true, by: "tags" });
    });

    it("lets the admin's hand-picked disc go with its other discs even when the tags say more discs exist", async () => {
      const r = await run([folderOf("A Night at the Opera CD1"), folderOf("A Night at the Opera CD2")], discs({ discTotal: 3 }, { discTotal: 3 }), { onlyFolder: folderOf("A Night at the Opera CD2").path });
      expect(r.matchOf("A Night at the Opera CD1")).toMatchObject({ kind: "album", by: "tags", discs: [{ disc: 1 }, { disc: 2 }] });
    });
  });

  describe("what it costs", () => {
    it("reads only the first, the middle and the last file of a folder", async () => {
      const r = await run([folderOf("odd", 100)], { odd: tagsOf("Queen II") });
      expect(r.asked).toEqual(["001", "051", "100"].map((n) => `/dl/Queen - Discography/odd/${n} - Song.flac`));
      expect(r.asked).toHaveLength(TAG_FILES_PER_FOLDER);
    });

    it("reads every file of a folder of two", async () => {
      const r = await run([folderOf("odd", 2)], { odd: tagsOf("Queen II") });
      expect(r.asked).toHaveLength(2);
    });

    it("reads at most a dozen folders of one release", async () => {
      const folders = Array.from({ length: 20 }, (_, i) => folderOf(`odd ${String(i).padStart(2, "0")}`, 4));
      const byFolder = Object.fromEntries(folders.map((f) => [f.name, tagsOf("Queen II")]));
      const r = await run(folders, byFolder);
      expect(r.probed).toBe(TAG_FOLDERS_PER_RELEASE);
      expect(r.foldersAsked().size).toBe(TAG_FOLDERS_PER_RELEASE);
      // The ones not read keep what their names said.
      expect(r.matchOf("odd 19")).toMatchObject({ kind: "unmatched" });
    });

    it("reads nothing when the names matched every folder", async () => {
      const r = await run([folderOf("1973 - Queen"), folderOf("1974 - Queen II"), folderOf("Sheer Heart Attack")], {});
      expect(r.asked).toEqual([]);
      expect(r.probed).toBe(0);
      expect(r.matches.size).toBe(3);
    });

    it("never reads tracks lying loose in the release's own folder", async () => {
      const releaseDir = "/dl/Queen - Discography";
      const loose: TagFolder = { path: releaseDir, name: "Queen - Discography", files: 3, audioFiles: [`${releaseDir}/01.flac`, `${releaseDir}/02.flac`, `${releaseDir}/03.flac`] };
      const reading = readerFor({ "Queen - Discography": tagsOf("Queen II") });
      const result = await matchFoldersByTags([loose], ALBUMS, matchAlbumFolders([loose], "Queen", ALBUMS), reading.reader, { artist: "Queen", releaseDir });
      expect(reading.asked).toEqual([]);
      expect(result.matches.get(releaseDir)).toMatchObject({ kind: "unmatched" });
    });

    it("stops after three folders in a row that cannot be read at all (no ffprobe)", async () => {
      const folders = Array.from({ length: 8 }, (_, i) => folderOf(`odd ${i}`, 4));
      const r = await run(folders, {});
      expect(r.foldersAsked().size).toBe(3);
      expect(r.identified).toBe(0);
    });

    it("reads nothing for a manual import of a folder the name already settled", async () => {
      const r = await run([folderOf("1974 - Queen II"), folderOf("odd folder")], { "odd folder": tagsOf("Sheer Heart Attack") }, { onlyFolder: folderOf("1974 - Queen II").path });
      expect(r.asked).toEqual([]);
      expect(r.probed).toBe(0);
      expect(r.matchOf("odd folder")).toMatchObject({ kind: "unmatched" });
    });

    it("reads the admin's folder first, within the cap", async () => {
      const folders = Array.from({ length: 15 }, (_, i) => folderOf(`odd ${String(i).padStart(2, "0")}`, 4));
      const byFolder = Object.fromEntries(folders.map((f) => [f.name, tagsOf(f === folders[14] ? "Queen II" : "Sheer Heart Attack")]));
      const r = await run(folders, byFolder, { onlyFolder: folders[14].path });
      expect(r.matchOf("odd 14")).toMatchObject({ kind: "album", albumId: 2, by: "tags" });
      expect(r.foldersAsked().size).toBe(TAG_FOLDERS_PER_RELEASE);
    });
  });
});

describe("the pieces of the reading", () => {
  it("picks the first, middle and last file by name", () => {
    expect(sampleFiles(["b", "a"])).toEqual(["a", "b"]);
    expect(sampleFiles(["c", "a", "b"])).toEqual(["a", "b", "c"]);
    expect(sampleFiles(["1", "2", "3", "4", "5", "6", "7", "8", "9"])).toEqual(["1", "5", "9"]);
    expect(sampleFiles(["1", "2", "3", "4"])).toEqual(["1", "3", "4"]);
    expect(sampleFiles([])).toEqual([]);
  });

  it("takes the album artist before the track artist, and the year out of a date", () => {
    expect(fileAlbumTagsFrom({ artist: "Queen feat. X", albumArtist: "Queen", author: null, album: "Queen II", title: null, date: "1974-03-08", disc: 1, discTotal: 2 })).toEqual({
      album: "Queen II",
      artist: "Queen",
      year: 1974,
      disc: 1,
      discTotal: 2,
    });
    expect(fileAlbumTagsFrom({ artist: "Queen", albumArtist: null, author: null, album: "Queen II", title: null })).toEqual({ album: "Queen II", artist: "Queen", year: null, disc: null, discTotal: null });
    expect(fileAlbumTagsFrom({ artist: "Queen", albumArtist: null, author: null, album: "Q", title: null, date: "unknown" })?.year).toBeNull();
    expect(fileAlbumTagsFrom(null)).toBeNull();
  });

  it("says why a folder is not an album when nothing was read", () => {
    expect(identifyFolderByTags([], "Queen", ALBUMS)).toMatchObject({ kind: "unmatched" });
  });
});

// ---- the import, with a database -------------------------------------------------------------------------------------------

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let importer: typeof import("../src/services/importer.js");
let scheduler: typeof import("../src/services/scheduler.js");
let downloadsDir: string;
let libraryDir: string;
let rootFolder: { id: number; path: string };

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  importer = await import("../src/services/importer.js");
  scheduler = await import("../src/services/scheduler.js");
  downloadsDir = path.join(config.downloadsDir, "test-discography-tags");
});

/** What the tags of a folder's files are, by the folder's name (the reader is mocked). */
let tagsByFolder: Record<string, FileAlbumTags | null> = {};
/** When set, the reader waits for it: the import is then a long task. */
let readerGate: Promise<void> | null = null;
let openReaderGate: () => void = () => undefined;

beforeEach(async () => {
  for (const t of ["history", "blocklist", "recycle_bin", "queue", "download_clients", "tracks", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  notifyImported.mockReset();
  notifyManualInteractionRequired.mockReset().mockResolvedValue(undefined);
  unpackDownloadedArchives.mockReset().mockResolvedValue({ extracted: [], failed: [] });
  removeQueueItemDownload.mockReset().mockResolvedValue(undefined);
  markDownloadImported.mockReset().mockResolvedValue(undefined);
  getDownloadClientAdapter.mockReset();
  tagsByFolder = {};
  readerGate = null;
  openReaderGate = () => undefined;
  readTags.mockReset().mockImplementation(async (file: string) => {
    if (readerGate) await readerGate;
    return tagsByFolder[path.basename(path.dirname(file))] ?? null;
  });
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-discography-tags-"));
  setSetting("skipFreeSpaceCheck", "1");
  setSetting("removeCompletedDownloads", "0");
  setSetting("writeAudioTagsOnImport", "0");
  setSetting("setPermissionsEnabled", "0");
  setSetting("importStrategy", "move");
  setSetting("recycleBinEnabled", "1");
  setSetting("recycleBinDir", path.join(libraryDir, ".recycle-bin"));
  const p = path.join(libraryDir, "artist");
  fs.mkdirSync(p, { recursive: true });
  rootFolder = { id: Number((await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'artist', 'artist')").run(p)).lastInsertRowid), path: p };
});

afterEach(async () => {
  vi.useRealTimers();
  openReaderGate(); // a test that failed with the gate shut must not leave the lane waiting for ever
  await scheduler.whenImportLaneIdle();
  fs.rmSync(libraryDir, { recursive: true, force: true });
});

const RELEASE = "Queen - Discography (1973-1995) [FLAC]";

function writeTracks(release: string, folder: string, names: string[]): string[] {
  return names.map((name) => {
    const file = path.join(downloadsDir, release, folder, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `audio ${folder} ${name}`);
    return file;
  });
}

async function queen(): Promise<{ artistId: number; albums: Record<string, number> }> {
  // A library that has files recorded in it holds something: an empty root would read as a share that is not mounted.
  fs.writeFileSync(path.join(rootFolder.path, ".library-in-use"), "");
  const artistId = Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Queen', 'queen', ?, 1, 0, 'missing')")
        .run(rootFolder.id)
    ).lastInsertRowid
  );
  const add = async (title: string, date: string) =>
    Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, ?, ?, 1, 0)").run(artistId, title, date)).lastInsertRowid);
  return {
    artistId,
    albums: {
      queen: await add("Queen", "1973-07-13"),
      queen2: await add("Queen II", "1974-03-08"),
      sheer: await add("Sheer Heart Attack", "1974-11-08"),
      opera: await add("A Night at the Opera", "1975-11-21"),
    },
  };
}

async function queueDiscography(artistId: number, targets: number[], extra: { status?: string; downloadId?: string; clientId?: number } = {}): Promise<number> {
  const queueId = Number(
    (
      await db
        .prepare("INSERT INTO queue (media_item_id, title, download_path, quality, status, grab_source, download_client_id, download_id, progress) VALUES (?, ?, ?, NULL, ?, 'auto', ?, ?, ?)")
        .run(artistId, RELEASE, path.join(downloadsDir, RELEASE), extra.status ?? "completed", extra.clientId ?? null, extra.downloadId ?? null, extra.status === "downloading" ? 0.5 : 1)
    ).lastInsertRowid
  );
  for (const id of targets) await db.prepare("INSERT INTO queue_targets (queue_id, sub_item_id) VALUES (?, ?)").run(queueId, id);
  return queueId;
}

const albumRow = async (id: number): Promise<any> => db.prepare("SELECT * FROM sub_items WHERE id = ?").get(id);
const queueRow = async (id: number): Promise<any> => db.prepare("SELECT * FROM queue WHERE id = ?").get(id);
const tags = (album: string, extra: Partial<FileAlbumTags> = {}): FileAlbumTags => ({ album, artist: "Queen", year: null, disc: null, discTotal: null, ...extra });

describe("importing a discography whose folder names say nothing", () => {
  it("files an oddly named folder under the album its files' tags name", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks(RELEASE, "CD1 - misc rips", ["01 - Procession.flac", "02 - Father to Son.flac"]);
    tagsByFolder["CD1 - misc rips"] = tags("Queen II", { year: 1974 });
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    await importer.importQueueItem(queueId);

    expect(await queueRow(queueId)).toBeUndefined();
    for (const key of ["queen", "queen2"] as const) expect((await albumRow(albums[key])).has_file, key).toBe(1);
    expect(fs.readdirSync((await albumRow(albums.queen2)).file_path)).toHaveLength(2);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "CD1 - misc rips", "01 - Procession.flac"))).toBe(false);
    // The folder the name matched was never read.
    expect(readTags.mock.calls.map((c) => path.basename(path.dirname(c[0] as string)))).not.toContain("1973 - Queen");
  });

  it("says in its result how many folders the tags identified", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks(RELEASE, "rips a", ["01 - Procession.flac"]);
    writeTracks(RELEASE, "rips b", ["01 - Now I'm Here.flac"]);
    tagsByFolder["rips a"] = tags("Queen II");
    tagsByFolder["rips b"] = tags("Sheer Heart Attack");

    const done = await importer.placeDiscographyFiles({
      itemId: artistId,
      targetSubItemIds: [albums.queen, albums.queen2, albums.sheer],
      releaseDir: path.join(downloadsDir, RELEASE),
      quality: null,
      releaseTitle: RELEASE,
    });

    expect(done.identifiedByTags).toBe(2);
    expect(done.imported.map((a) => a.subItemId).sort()).toEqual([albums.queen, albums.queen2, albums.sheer].sort());
  });

  it("does not let the tags override a folder name", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
    tagsByFolder["1974 - Queen II"] = tags("Sheer Heart Attack");
    const queueId = await queueDiscography(artistId, [albums.queen2, albums.sheer]);

    await importer.importQueueItem(queueId);

    expect((await albumRow(albums.queen2)).has_file).toBe(1);
    expect((await albumRow(albums.sheer)).has_file).toBe(0);
    expect(readTags).not.toHaveBeenCalled();
  });

  it("files an album's disc folders together when their tags show them to be its discs, each disc's tracks after the last disc's", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1975 - A Night at the Opera CD1", ["01 - Death on Two Legs.flac", "02 - Lazing on a Sunday Afternoon.flac"]);
    writeTracks(RELEASE, "1975 - A Night at the Opera CD2", ["01 - Bohemian Rhapsody.flac"]);
    tagsByFolder["1975 - A Night at the Opera CD1"] = tags("A Night at the Opera", { disc: 1, discTotal: 2 });
    tagsByFolder["1975 - A Night at the Opera CD2"] = tags("A Night at the Opera", { disc: 2, discTotal: 2 });
    for (const [n, title] of [[1, "Death on Two Legs"], [2, "Lazing on a Sunday Afternoon"], [3, "Bohemian Rhapsody"]] as const) {
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, ?, ?)").run(albums.opera, n, title);
    }
    const queueId = await queueDiscography(artistId, [albums.opera]);

    await importer.importQueueItem(queueId);

    const opera = await albumRow(albums.opera);
    expect(opera.has_file).toBe(1);
    expect(fs.readdirSync(opera.file_path)).toHaveLength(3);
    const trackRows = (await db.prepare("SELECT track_number, has_file, file_path FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(albums.opera)) as any[];
    expect(trackRows.map((t) => Number(t.has_file))).toEqual([1, 1, 1]);
    // Disc 2's first file is the album's third track, not a second track 1 over disc 1's.
    expect(fs.readFileSync(trackRows[2].file_path, "utf8")).toContain("Bohemian Rhapsody");
    expect(fs.readFileSync(trackRows[0].file_path, "utf8")).toContain("Death on Two Legs");
    expect(await queueRow(queueId)).toBeUndefined();
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "1975 - A Night at the Opera CD2", "01 - Bohemian Rhapsody.flac"))).toBe(false);
  });

  it("keeps same-named tracks of grouped disc folders apart in a folder per disc", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "A Night at the Opera CD1", ["Intro.flac"]);
    writeTracks(RELEASE, "A Night at the Opera CD2", ["Intro.flac"]);
    tagsByFolder["A Night at the Opera CD1"] = tags("A Night at the Opera", { disc: 1, discTotal: 2 });
    tagsByFolder["A Night at the Opera CD2"] = tags("A Night at the Opera", { disc: 2, discTotal: 2 });
    const queueId = await queueDiscography(artistId, [albums.opera]);

    await importer.importQueueItem(queueId);

    const opera = await albumRow(albums.opera);
    expect(opera.has_file).toBe(1);
    expect(fs.readdirSync(opera.file_path).sort()).toEqual(["A Night at the Opera CD1", "A Night at the Opera CD2"]);
  });

  it("leaves disc folders whose tags do not agree, as before", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1975 - A Night at the Opera (Disc 1)", ["01 - Death on Two Legs.flac"]);
    writeTracks(RELEASE, "1975 - A Night at the Opera (Disc 2)", ["01 - Bohemian Rhapsody.flac"]);
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    tagsByFolder["1975 - A Night at the Opera (Disc 1)"] = tags("A Night at the Opera", { disc: 1, discTotal: 2 });
    tagsByFolder["1975 - A Night at the Opera (Disc 2)"] = tags("A Night at the Opera", { disc: 1, discTotal: 2 });
    const queueId = await queueDiscography(artistId, [albums.queen, albums.opera]);

    await importer.importQueueItem(queueId);

    expect((await albumRow(albums.queen)).has_file).toBe(1);
    expect((await albumRow(albums.opera)).has_file).toBe(0);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "1975 - A Night at the Opera (Disc 2)", "01 - Bohemian Rhapsody.flac"))).toBe(true);
  });

  it("refuses a Various Artists compilation and another artist's album, and leaves their files", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "Now That's What I Call Queen", ["01 - Procession.flac"]);
    writeTracks(RELEASE, "Tribute", ["01 - Father to Son.flac"]);
    tagsByFolder["Now That's What I Call Queen"] = tags("Queen II", { artist: "Various Artists" });
    tagsByFolder["Tribute"] = tags("Queen II", { artist: "Some Cover Band" });
    const queueId = await queueDiscography(artistId, [albums.queen2]);

    const err = await importer.importQueueItem(queueId).catch((e) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toContain("by its tags");
    expect((await albumRow(albums.queen2)).has_file).toBe(0);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "Tribute", "01 - Father to Son.flac"))).toBe(true);
  });

  it("behaves as before when the tags cannot be read (no ffprobe)", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "Some Other Band - Record", ["01 - Song.flac"]);
    readTags.mockReset().mockRejectedValue(new Error("spawn ffprobe ENOENT"));
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    const err = await importer.importQueueItem(queueId).catch((e) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toContain("No album of");
    expect(await queueRow(queueId)).toBeDefined();
  });

  it("identifies the folder of a file the admin picked, and keeps the rest on the queue", async () => {
    const { artistId, albums } = await queen();
    const [picked] = writeTracks(RELEASE, "CD1 - misc rips", ["01 - Procession.flac"]);
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    tagsByFolder["CD1 - misc rips"] = tags("Queen II");
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    await importer.importQueueItem(queueId, picked);

    expect((await albumRow(albums.queen2)).has_file).toBe(1);
    expect((await albumRow(albums.queen)).has_file).toBe(0);
    expect(await queueRow(queueId)).toBeDefined();
    const left = ((await db.prepare("SELECT sub_item_id FROM queue_targets WHERE queue_id = ?").all(queueId)) as any[]).map((r) => Number(r.sub_item_id));
    expect(left).toEqual([albums.queen]);
  });
});

// ---- the queue poller is not held ----------------------------------------------------------------------------------------

describe("the import of a discography and the queue poll", () => {
  async function insertClient(): Promise<number> {
    return Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('qBit', 'qbittorrent', 1)").run()).lastInsertRowid);
  }

  /** A movie download that is still going, to be polled while the discography is imported. */
  async function insertMovieDownload(clientId: number, downloadId: string): Promise<number> {
    const movie = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, status) VALUES ('movie', 'Some Movie', 'some movie', 'missing')").run()).lastInsertRowid);
    return Number(
      (
        await db
          .prepare("INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress) VALUES (?, 'Some.Movie.2020.1080p.WEB-DL-GRP', ?, ?, 'downloading', 0.1)")
          .run(movie, clientId, downloadId)
      ).lastInsertRowid
    );
  }

  it("hands a finished discography to the import lane and polls on while it is imported (tag reading is the slow part here)", async () => {
    const { artistId, albums } = await queen();
    // A discography of oddly named folders: each needs its tags read, which the test holds up.
    const folders = ["rips a", "rips b", "rips c", "rips d"];
    const wanted = [albums.queen2, albums.sheer, albums.opera, albums.queen];
    const titles = ["Queen II", "Sheer Heart Attack", "A Night at the Opera", "Queen"];
    folders.forEach((folder, i) => {
      writeTracks(RELEASE, folder, ["01 - Song.flac", "02 - Song.flac"]);
      tagsByFolder[folder] = tags(titles[i]);
    });
    readerGate = new Promise<void>((resolve) => (openReaderGate = resolve));

    const clientId = await insertClient();
    const discography = await queueDiscography(artistId, wanted, { status: "downloading", downloadId: "dl-discography", clientId });
    const movie = await insertMovieDownload(clientId, "dl-movie");
    let movieProgress = 0.3;
    getDownloadClientAdapter.mockReturnValue({
      getStatus: vi.fn(async (_client: unknown, ids: string[]) =>
        [...new Set(ids)].map((downloadId) =>
          downloadId === "dl-discography" ? { downloadId, progress: 1, status: "completed" } : { downloadId, progress: movieProgress, status: "downloading" }
        )
      ),
    });

    const started = Date.now();
    await scheduler.pollQueue({ background: true }); // returns while the import has not finished
    expect(Date.now() - started).toBeLessThan(5000);

    // The import is under way on the lane: the row is claimed ("importing...") and the tags are being read.
    await vi.waitFor(() => expect(readTags).toHaveBeenCalled());
    expect(scheduler.importLaneBusy()).toBe(true);
    const claimed = await queueRow(discography);
    expect(claimed.status).toBe("completed");
    expect(claimed.import_started_at).not.toBeNull();

    // A second poll, a third: other downloads still move while it lasts, none of them waits for the import.
    for (const progress of [0.5, 0.8]) {
      movieProgress = progress;
      const pollStarted = Date.now();
      await scheduler.pollQueue({ background: true });
      expect(Date.now() - pollStarted).toBeLessThan(5000);
      expect(Number((await queueRow(movie)).progress)).toBeCloseTo(progress);
      expect(scheduler.importLaneBusy()).toBe(true);
      expect((await albumRow(albums.queen2)).has_file).toBe(0);
    }
    // A poll does not hand the same row over twice: the first folder's two files are being read, nothing more.
    expect(readTags).toHaveBeenCalledTimes(2);

    openReaderGate();
    await scheduler.whenImportLaneIdle();

    expect(scheduler.importLaneBusy()).toBe(false);
    expect(await queueRow(discography)).toBeUndefined();
    for (const id of wanted) expect((await albumRow(id)).has_file).toBe(1);
  });

  it("leaves a discography row cut off by a restart recoverable: it is handed back and imported once more on the lane", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
    const clientId = await insertClient();
    const discography = await queueDiscography(artistId, [albums.queen, albums.queen2], { clientId, downloadId: "dl-discography" });
    // What the poll's claim leaves behind when the process dies before the lane gets to the row.
    await db.prepare("UPDATE queue SET import_started_at = ? WHERE id = ?").run("2026-11-05 10:00:00", discography);
    getDownloadClientAdapter.mockReturnValue({ getStatus: vi.fn(async () => []) });

    await scheduler.resumeInterruptedImports();
    const handedBack = await queueRow(discography);
    expect(handedBack.import_started_at).toBeNull();
    expect(Number(handedBack.import_resume_state)).toBe(1);

    await scheduler.pollQueue({ background: true });
    await scheduler.whenImportLaneIdle();

    expect(await queueRow(discography)).toBeUndefined();
    expect((await albumRow(albums.queen)).has_file).toBe(1);
    expect((await albumRow(albums.queen2)).has_file).toBe(1);
  });
});
