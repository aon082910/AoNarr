import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

vi.mock("../src/services/notifications.js", () => ({
  notifyImported: vi.fn().mockResolvedValue(undefined),
  notifyUpgraded: vi.fn().mockResolvedValue(undefined),
  notifyManualInteractionRequired: vi.fn().mockResolvedValue(undefined),
  notifyRenamed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/services/ffprobe.js", () => ({ probeMediaInfo: vi.fn().mockResolvedValue(null) }));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let placeFile: (typeof import("../src/services/importer.js"))["placeFile"];
let placeAlbumFiles: (typeof import("../src/services/importer.js"))["placeAlbumFiles"];
let placeSeasonPackFiles: (typeof import("../src/services/importer.js"))["placeSeasonPackFiles"];
let downloadsDir: string;
let libraryDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ placeFile, placeAlbumFiles, placeSeasonPackFiles } = await import("../src/services/importer.js"));
  ({ config } = await import("../src/config.js"));
  await (await import("../src/services/quality.js")).loadQualityCaches();
  downloadsDir = path.join(config.downloadsDir, "test-fixtures-metadata");
  fs.mkdirSync(downloadsDir, { recursive: true });
});

const jpegFor = (url: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(url)]);
let fetched: string[] = [];

beforeEach(async () => {
  for (const table of ["history", "recycle_bin", "queue", "tracks", "episodes", "seasons", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-metafiles-library-"));
  for (const [key, value] of Object.entries({
    skipFreeSpaceCheck: "1",
    removeCompletedDownloads: "0",
    writeNfoOnImport: "0",
    writeAudioTagsOnImport: "0",
    setPermissionsEnabled: "0",
    subtitleSyncEnabled: "0",
    importStrategy: "move",
    recycleBinEnabled: "1",
    recycleBinDir: path.join(libraryDir, ".recycle-bin"),
    // a clean slate for the metadata file switches: everything unset, as on a fresh install
    nfoTvEnabled: "",
    nfoMusicEnabled: "",
    writeImagesOnImport: "",
    imagesPosterFanart: "",
    imagesSeasonPosters: "",
    imagesEpisodeThumbs: "",
    imagesMusicCover: "",
    overwriteMetadataFiles: "",
  })) {
    setSetting(key, value);
  }
  fetched = [];
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

async function insertRootFolder(mediaType: string): Promise<{ id: number; path: string }> {
  const p = path.join(libraryDir, mediaType);
  fs.mkdirSync(p, { recursive: true });
  const result = await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, ?, ?)").run(p, mediaType, mediaType);
  return { id: Number(result.lastInsertRowid), path: p };
}

function download(name: string, content = "fake bytes"): string {
  const p = path.join(downloadsDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

async function insertMovie(folderId: number) {
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, monitored, status, poster_url, backdrop_url, overview, external_ids)
       VALUES ('movie', 'Heat', 'heat', 1995, ?, 0, 1, 'missing', 'https://img.example.com/heat-poster.jpg', 'https://img.example.com/heat-fanart.jpg', 'Robbers.', ?)`
    )
    .run(folderId, JSON.stringify({ tmdb: "949" }));
  return Number(result.lastInsertRowid);
}

async function insertShow(folderId: number, episodeNumbers: number[]) {
  const showId = Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, root_folder_id, has_file, monitored, status, poster_url, backdrop_url, overview, external_ids)
           VALUES ('series', 'Show', 'show', ?, 0, 1, 'missing', 'https://img.example.com/show-poster.jpg', 'https://img.example.com/show-fanart.jpg', 'A show.', ?)`
        )
        .run(folderId, JSON.stringify({ tvdb: "81189" }))
    ).lastInsertRowid
  );
  await db.prepare("INSERT INTO seasons (media_item_id, season_number, poster_url) VALUES (?, 1, 'https://img.example.com/show-s1.jpg')").run(showId);
  const episodeIds: number[] = [];
  for (const n of episodeNumbers) {
    const result = await db
      .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file, thumb_url) VALUES (?, 1, ?, ?, '2020-01-0' || ?, 1, 0, ?)")
      .run(showId, n, `Episode ${n}`, n, `https://img.example.com/show-e${n}.jpg`);
    episodeIds.push(Number(result.lastInsertRowid));
  }
  return { showId, episodeIds };
}

const placeMovie = async (id: number) => placeFile({ itemId: id, episodeId: null, subItemId: null, sourceFile: download("Heat.1995.mkv"), quality: null });

describe("movies at import", () => {
  it("writes poster and fanart only once pictures are switched on", async () => {
    const folder = await insertRootFolder("movie");
    const first = await placeMovie(await insertMovie(folder.id));
    expect(fs.readdirSync(path.dirname(first.destPath))).toEqual([path.basename(first.destPath)]);
    expect(fetched).toEqual([]);

    await db.prepare("DELETE FROM media_items").run();
    setSetting("writeImagesOnImport", "1");
    const second = await placeMovie(await insertMovie(folder.id));

    const dir = path.dirname(second.destPath);
    expect(fs.readFileSync(path.join(dir, "poster.jpg")).equals(jpegFor("https://img.example.com/heat-poster.jpg"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "fanart.jpg")).equals(jpegFor("https://img.example.com/heat-fanart.jpg"))).toBe(true);
  });

  it("writes only the kinds left switched on", async () => {
    const folder = await insertRootFolder("movie");
    setSetting("writeImagesOnImport", "1");
    setSetting("imagesPosterFanart", "0");

    const placed = await placeMovie(await insertMovie(folder.id));

    expect(fs.readdirSync(path.dirname(placed.destPath))).toEqual([path.basename(placed.destPath)]);
  });

  it("does not let a failing picture fail the import", async () => {
    const folder = await insertRootFolder("movie");
    setSetting("writeImagesOnImport", "1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const id = await insertMovie(folder.id);

    const placed = await placeMovie(id);

    expect(fs.existsSync(placed.destPath)).toBe(true);
    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(id)) as any).has_file).toBe(1);
    expect(fs.readdirSync(path.dirname(placed.destPath))).toEqual([path.basename(placed.destPath)]);
  });

  it("names the pictures after the file when the folder holds another title's file", async () => {
    const folder = await insertRootFolder("movie");
    setSetting("writeImagesOnImport", "1");
    const id = await insertMovie(folder.id);
    // A second title's file already sits in the folder the naming puts this movie in.
    const other = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, monitored, status, path) VALUES ('movie','Other','other',1995,?,1,1,'downloaded',?)").run(folder.id, path.join(folder.path, "Heat (1995)", "Other.mkv")))
        .lastInsertRowid
    );
    fs.mkdirSync(path.join(folder.path, "Heat (1995)"), { recursive: true });
    fs.writeFileSync(path.join(folder.path, "Heat (1995)", "Other.mkv"), "x");
    expect(other).toBeGreaterThan(0);

    const placed = await placeMovie(id);

    const dir = path.dirname(placed.destPath);
    const base = path.basename(placed.destPath, path.extname(placed.destPath));
    expect(fs.existsSync(path.join(dir, "poster.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${base}-poster.jpg`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${base}-fanart.jpg`))).toBe(true);
  });
});

describe("shows at import", () => {
  it("writes the show's pictures once, the season poster and the episode's still beside the file", async () => {
    const folder = await insertRootFolder("series");
    const { showId, episodeIds } = await insertShow(folder.id, [1]);
    setSetting("writeImagesOnImport", "1");

    const placed = await placeFile({ itemId: showId, episodeId: episodeIds[0], subItemId: null, sourceFile: download("Show.S01E01.mkv"), quality: null });

    const showDir = path.join(folder.path, "Show");
    expect(fs.readdirSync(showDir).sort()).toEqual(["Season 01", "fanart.jpg", "poster.jpg", "season01-poster.jpg"]);
    const base = path.basename(placed.destPath, path.extname(placed.destPath));
    expect(fs.readdirSync(path.dirname(placed.destPath)).sort()).toEqual([path.basename(placed.destPath), `${base}-thumb.jpg`].sort());
  });

  it("leaves a second episode's import with only its own still to fetch", async () => {
    const folder = await insertRootFolder("series");
    const { showId, episodeIds } = await insertShow(folder.id, [1, 2]);
    setSetting("writeImagesOnImport", "1");

    await placeFile({ itemId: showId, episodeId: episodeIds[0], subItemId: null, sourceFile: download("Show.S01E01.mkv"), quality: null });
    fetched = [];
    await placeFile({ itemId: showId, episodeId: episodeIds[1], subItemId: null, sourceFile: download("Show.S01E02.mkv"), quality: null });

    expect(fetched).toEqual(["https://img.example.com/show-e2.jpg"]);
  });

  it("follows Write NFO on Import for the episode NFO and tvshow.nfo, as before", async () => {
    const folder = await insertRootFolder("series");
    const { showId, episodeIds } = await insertShow(folder.id, [1]);
    setSetting("writeNfoOnImport", "1");

    const placed = await placeFile({ itemId: showId, episodeId: episodeIds[0], subItemId: null, sourceFile: download("Show.S01E01.mkv"), quality: null });

    expect(fs.existsSync(path.join(path.dirname(placed.destPath), `${path.basename(placed.destPath, path.extname(placed.destPath))}.nfo`))).toBe(true);
    expect(fs.existsSync(path.join(folder.path, "Show", "tvshow.nfo"))).toBe(true);
    expect(fetched).toEqual([]); // no pictures: they are a separate switch
  });

  it("lets nfoTvEnabled override it either way", async () => {
    const folder = await insertRootFolder("series");
    const { showId, episodeIds } = await insertShow(folder.id, [1, 2]);

    setSetting("writeNfoOnImport", "1");
    setSetting("nfoTvEnabled", "0");
    const off = await placeFile({ itemId: showId, episodeId: episodeIds[0], subItemId: null, sourceFile: download("Show.S01E01.mkv"), quality: null });
    expect(fs.readdirSync(path.dirname(off.destPath)).filter((n) => n.endsWith(".nfo"))).toEqual([]);
    expect(fs.existsSync(path.join(folder.path, "Show", "tvshow.nfo"))).toBe(false);

    setSetting("writeNfoOnImport", "0");
    setSetting("nfoTvEnabled", "1");
    const on = await placeFile({ itemId: showId, episodeId: episodeIds[1], subItemId: null, sourceFile: download("Show.S01E02.mkv"), quality: null });
    expect(fs.readdirSync(path.dirname(on.destPath)).filter((n) => n.endsWith(".nfo"))).toHaveLength(1);
    expect(fs.existsSync(path.join(folder.path, "Show", "tvshow.nfo"))).toBe(true);
  });

  it("writes NFO files and pictures for a season pack, which never wrote any", async () => {
    const folder = await insertRootFolder("series");
    const { showId } = await insertShow(folder.id, [1, 2]);
    setSetting("nfoTvEnabled", "1");
    setSetting("writeImagesOnImport", "1");
    const anchor = download(path.join("Show.S01.PACK", "Show.S01E01.mkv"));
    download(path.join("Show.S01.PACK", "Show.S01E02.mkv"));

    const result = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null });

    expect(result.episodeCount).toBe(2);
    const season = path.join(folder.path, "Show", "Season 01");
    expect(fs.readdirSync(season).filter((n) => n.endsWith(".nfo"))).toHaveLength(2);
    expect(fs.readdirSync(season).filter((n) => n.endsWith("-thumb.jpg"))).toHaveLength(2);
    expect(fs.readdirSync(path.join(folder.path, "Show")).sort()).toEqual(["Season 01", "fanart.jpg", "poster.jpg", "season01-poster.jpg", "tvshow.nfo"]);
    // each picture once, though two episodes were imported
    expect(fetched.filter((u) => u.endsWith("show-poster.jpg"))).toHaveLength(1);
  });

  it("writes nothing for a season pack while the switches are off", async () => {
    const folder = await insertRootFolder("series");
    const { showId } = await insertShow(folder.id, [1]);
    const anchor = download(path.join("Show.S01.PACK", "Show.S01E01.mkv"));

    await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null });

    expect(fs.readdirSync(path.join(folder.path, "Show"))).toEqual(["Season 01"]);
    expect(fs.readdirSync(path.join(folder.path, "Show", "Season 01")).filter((n) => !n.endsWith(".mkv"))).toEqual([]);
    expect(fetched).toEqual([]);
  });
});

describe("albums at import", () => {
  async function insertArtistAlbum(folderId: number, type = "artist") {
    const artistId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status, poster_url, backdrop_url, overview, external_ids, genres)
             VALUES (?, 'Daft Punk', 'daft punk', ?, 1, 0, 'missing', 'https://img.example.com/artist.jpg', 'https://img.example.com/artist-fanart.jpg', 'French duo.', ?, ?)`
          )
          .run(type, folderId, JSON.stringify({ musicbrainz: "056e4f3e" }), JSON.stringify(["Electronic"]))
      ).lastInsertRowid
    );
    const albumId = Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, poster_url, monitored, has_file) VALUES (?, 'Discovery', '2001-03-12', 'rg-1', 'musicbrainz', 'https://img.example.com/discovery.jpg', 1, 0)")
          .run(artistId)
      ).lastInsertRowid
    );
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, duration_seconds) VALUES (?, 1, 'One More Time', 320)").run(albumId);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 2, 'Aerodynamic')").run(albumId);
    return { artistId, albumId };
  }

  it("writes nothing for music while its switches are off, though Write NFO on Import is on (new kinds are opt-in)", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    setSetting("writeNfoOnImport", "1");
    const anchor = download(path.join("Discovery.2001", "01 - One More Time.mp3"));
    download(path.join("Discovery.2001", "02 - Aerodynamic.mp3"));

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

    expect(fs.readdirSync(result.destFolder).filter((n) => !n.endsWith(".mp3"))).toEqual([]);
    expect(fs.readdirSync(path.join(folder.path, "Daft Punk"))).toEqual(["Discovery"]);
  });

  it("writes album.nfo with the track list, folder.jpg, artist.nfo, artist.jpg and fanart.jpg", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    setSetting("nfoMusicEnabled", "1");
    setSetting("writeImagesOnImport", "1");
    const anchor = download(path.join("Discovery.2001", "01 - One More Time.mp3"));
    download(path.join("Discovery.2001", "02 - Aerodynamic.mp3"));

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

    expect(fs.readdirSync(result.destFolder).filter((n) => !n.endsWith(".mp3")).sort()).toEqual(["album.nfo", "folder.jpg"]);
    const albumNfo = fs.readFileSync(path.join(result.destFolder, "album.nfo"), "utf-8");
    expect(albumNfo).toContain("<title>Discovery</title>");
    expect(albumNfo).toContain("<musicBrainzReleaseGroupID>rg-1</musicBrainzReleaseGroupID>");
    expect(albumNfo).toContain("<title>One More Time</title>");
    expect(albumNfo).toContain("<genre>Electronic</genre>");
    const artistDir = path.join(folder.path, "Daft Punk");
    expect(fs.readdirSync(artistDir).sort()).toEqual(["Discovery", "artist.jpg", "artist.nfo", "fanart.jpg"]);
    expect(fs.readFileSync(path.join(artistDir, "artist.nfo"), "utf-8")).toContain("<musicBrainzArtistID>056e4f3e</musicBrainzArtistID>");
  });

  it("does not put an album.nfo in an audiobook's folder, though the same function places it", async () => {
    const folder = await insertRootFolder("audiobook");
    const { artistId, albumId } = await insertArtistAlbum(folder.id, "audiobook");
    setSetting("nfoMusicEnabled", "1");
    setSetting("writeImagesOnImport", "1");
    const anchor = download(path.join("Dune.Audiobook", "Dune.m4b"));

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

    expect(fs.readdirSync(result.destFolder).filter((n) => !n.endsWith(".m4b"))).toEqual([]);
  });
});
