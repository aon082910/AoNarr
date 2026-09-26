import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

const probeMediaInfo = vi.fn();
vi.mock("../src/services/ffprobe.js", () => ({
  probeMediaInfo: (...args: unknown[]) => probeMediaInfo(...args),
  probeAudioTags: async () => null,
}));

const searchMetadata = vi.fn();
const fetchByExternalId = vi.fn();
const fetchSeriesEpisodesFor = vi.fn();
const fetchSeriesEpisodesForProvider = vi.fn();
const fetchSeriesSeasonsFor = vi.fn();
const fetchArtistAlbumsFor = vi.fn();
const fetchCollectionChildrenFor = vi.fn();
const fetchMovieByTmdbId = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    isEpisodeMonitoredByDefault: actual.isEpisodeMonitoredByDefault,
    upcomingEpisodes: actual.upcomingEpisodes,
    proxyScreenscraperArtwork: actual.proxyScreenscraperArtwork,
    searchMetadata: (...args: unknown[]) => searchMetadata(...args),
    fetchByExternalId: (...args: unknown[]) => fetchByExternalId(...args),
    fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
    fetchSeriesEpisodesForProvider: (...args: unknown[]) => fetchSeriesEpisodesForProvider(...args),
    fetchSeriesSeasonsFor: (...args: unknown[]) => fetchSeriesSeasonsFor(...args),
    fetchArtistAlbumsFor: (...args: unknown[]) => fetchArtistAlbumsFor(...args),
    fetchCollectionChildrenFor: (...args: unknown[]) => fetchCollectionChildrenFor(...args),
    fetchMovieByTmdbId: (...args: unknown[]) => fetchMovieByTmdbId(...args),
  };
});

type LibraryScan = typeof import("../src/services/libraryScan.js");
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let scanAndImportLibrary: LibraryScan["scanAndImportLibrary"];
let refreshLibraryMetadata: LibraryScan["refreshLibraryMetadata"];
let refreshOneMediaItem: LibraryScan["refreshOneMediaItem"];
let matchAdditionalProviders: LibraryScan["matchAdditionalProviders"];
let childListProviderIds: LibraryScan["childListProviderIds"];
let mergedProviderIds: LibraryScan["mergedProviderIds"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ scanAndImportLibrary, refreshLibraryMetadata, refreshOneMediaItem, matchAdditionalProviders, childListProviderIds, mergedProviderIds } = await import(
    "../src/services/libraryScan.js"
  ));
});

let tmpRoot: string;

beforeEach(async () => {
  await db.prepare("DELETE FROM tracks").run();
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM seasons").run();
  await db.prepare("DELETE FROM sub_items").run();
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM root_folders").run();

  probeMediaInfo.mockReset().mockResolvedValue(null);
  searchMetadata.mockReset().mockResolvedValue([]);
  fetchByExternalId.mockReset().mockRejectedValue(new Error("not mocked"));
  fetchSeriesEpisodesFor.mockReset().mockResolvedValue([]);
  fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);
  fetchSeriesSeasonsFor.mockReset().mockResolvedValue([]);
  fetchArtistAlbumsFor.mockReset().mockResolvedValue(null);
  fetchCollectionChildrenFor.mockReset().mockResolvedValue({ provider: null, children: [] });
  fetchMovieByTmdbId.mockReset().mockResolvedValue({});

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-refresh-identity-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function insertRootFolder(mediaType: string): Promise<{ id: number; path: string }> {
  const p = path.join(tmpRoot, mediaType);
  fs.mkdirSync(p, { recursive: true });
  const result = await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, ?, ?)").run(p, mediaType, mediaType);
  return { id: Number(result.lastInsertRowid), path: p };
}

function writeFile(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "fake bytes");
  return p;
}

async function insertItem(type: string, title: string, externalIds: Record<string, string>, extraMetadata: Record<string, unknown> | null): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, extra_metadata, status) VALUES (?, ?, ?, 1, 0, ?, ?, 'continuing')`
    )
    .run(type, title, title.toLowerCase(), JSON.stringify(externalIds), extraMetadata ? JSON.stringify(extraMetadata) : null);
  return Number(result.lastInsertRowid);
}

async function insertEpisode(showId: number, episode: number, title: string, airDate: string | null): Promise<void> {
  await db
    .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored) VALUES (?, 1, ?, ?, ?, 1)`)
    .run(showId, episode, title, airDate);
}

async function airDates(showId: number): Promise<Record<number, string | null>> {
  const rows = (await db.prepare("SELECT episode_number, air_date FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
  return Object.fromEntries(rows.map((r) => [Number(r.episode_number), r.air_date]));
}

describe("Refresh of an item whose other-provider ids were merged in before they were recorded", () => {
  // What matchAdditionalProviders and "Fetch from X" stored before extra_metadata.additionalProviderIds
  // existed: the other provider's own result, staged under its key, and its id in external_ids.
  const legacyTmdbMerge = { tmdb: { title: "Legacy Show", externalIds: { tmdb: "1396" } } };

  it("keeps a TVDB-added show on TVDB's episodes and air dates", async () => {
    const showId = await insertItem("series", "Legacy Show", { tvdb: "81189", tmdb: "1396" }, legacyTmdbMerge);
    await insertEpisode(showId, 1, "Pilot", "2020-01-01");
    await insertEpisode(showId, 2, "Second", "2020-01-08");
    fetchByExternalId.mockImplementation(async (_type: string, provider: string, id: string) => {
      if (provider === "tvdb" && id === "81189") return { title: "Legacy Show", year: 2020, overview: "From TVDB", posterUrl: null, externalIds: { tvdb: "81189" } };
      throw new Error(`unexpected lookup ${provider}:${id}`);
    });
    fetchSeriesEpisodesFor.mockImplementation(async (ids: Record<string, string>) =>
      ids.tmdb
        ? [
            { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2020-01-25", overview: null },
            { seasonNumber: 1, episodeNumber: 2, title: "Second", airDate: "2020-02-01", overview: null },
          ]
        : [
            { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2020-01-01", overview: null },
            { seasonNumber: 1, episodeNumber: 2, title: "Second", airDate: "2020-01-08", overview: null },
            { seasonNumber: 1, episodeNumber: 3, title: "Third", airDate: "2020-01-15", overview: null },
          ]
    );

    expect((await refreshOneMediaItem(showId)).ok).toBe(true);

    expect(fetchSeriesEpisodesFor).toHaveBeenCalledTimes(1);
    expect(fetchSeriesEpisodesFor).toHaveBeenCalledWith({ tvdb: "81189" });
    expect(fetchSeriesSeasonsFor).toHaveBeenCalledWith({ tvdb: "81189" });
    expect(fetchByExternalId).not.toHaveBeenCalledWith("series", "tmdb", expect.anything());
    expect(await airDates(showId)).toEqual({ 1: "2020-01-01", 2: "2020-01-08", 3: "2020-01-15" });
    const row = (await db.prepare("SELECT overview, external_ids FROM media_items WHERE id = ?").get(showId)) as any;
    expect(row.overview).toBe("From TVDB");
    expect(JSON.parse(row.external_ids)).toEqual({ tvdb: "81189", tmdb: "1396" }); // kept for duplicate detection
  });

  it("keeps a Deezer-added artist on Deezer's albums", async () => {
    const artistId = await insertItem("artist", "The Beatles", { deezer: "1", musicbrainz: "b10bbbfc" }, {
      musicbrainz: { title: "The Beatles", externalIds: { musicbrainz: "b10bbbfc" } },
    });

    await refreshOneMediaItem(artistId);

    expect(fetchArtistAlbumsFor).toHaveBeenCalledWith({ deezer: "1" });
    expect(fetchArtistAlbumsFor).not.toHaveBeenCalledWith(expect.objectContaining({ musicbrainz: "b10bbbfc" }));
  });

  it("only counts an id as merged by the staged result's own provider key, not another id that result carries", () => {
    // TVMaze's result carries the show's tvdb id too; the tvdb id is still the show's own.
    const item = {
      type: "series",
      external_ids: JSON.stringify({ tvdb: "81189", tvmaze: "5" }),
      extra_metadata: JSON.stringify({ tvmaze: { title: "Legacy Show", externalIds: { tvmaze: "5", tvdb: "81189" } } }),
    };
    expect(childListProviderIds(item)).toEqual({ tvdb: "81189" });
    // A staged result for a different id of the same provider isn't this item's merge.
    expect(
      childListProviderIds({
        type: "series",
        external_ids: JSON.stringify({ tvdb: "81189", tmdb: "1396" }),
        extra_metadata: JSON.stringify({ tmdb: { title: "Other", externalIds: { tmdb: "999" } } }),
      })
    ).toEqual({ tvdb: "81189", tmdb: "1396" });
  });

  it("keeps a show on its first stored id when a fetch from its own provider staged that id too", async () => {
    // "Fetch from TVDB" staged the show's own TVDB result beside the merged TMDB one.
    const showId = await insertItem("series", "Legacy Show", { tvdb: "81189", tmdb: "1396" }, {
      ...legacyTmdbMerge,
      tvdb: { title: "Legacy Show", externalIds: { tvdb: "81189" } },
    });
    await insertEpisode(showId, 1, "Pilot", "2020-01-01");
    await insertEpisode(showId, 2, "Second", "2020-01-08");
    fetchByExternalId.mockImplementation(async (_type: string, provider: string, id: string) => {
      if (provider === "tvdb" && id === "81189") return { title: "Legacy Show", year: 2020, overview: "From TVDB", posterUrl: null, externalIds: { tvdb: "81189" } };
      throw new Error(`unexpected lookup ${provider}:${id}`);
    });
    fetchSeriesEpisodesFor.mockImplementation(async (ids: Record<string, string>) =>
      ids.tmdb
        ? [
            { seasonNumber: 1, episodeNumber: 2, title: "Second", airDate: "2020-02-01", overview: null },
            { seasonNumber: 2, episodeNumber: 1, title: "TMDB Only", airDate: "2021-01-01", overview: null },
          ]
        : [
            { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2020-01-01", overview: null },
            { seasonNumber: 1, episodeNumber: 2, title: "Second", airDate: "2020-01-09", overview: null },
          ]
    );

    expect((await refreshOneMediaItem(showId)).ok).toBe(true);

    expect(fetchSeriesEpisodesFor).toHaveBeenCalledTimes(1);
    expect(fetchSeriesEpisodesFor).toHaveBeenCalledWith({ tvdb: "81189" });
    expect(fetchByExternalId).not.toHaveBeenCalledWith("series", "tmdb", expect.anything());
    // TVDB is the show's own provider, so its corrected air date replaces the stored one.
    expect(await airDates(showId)).toEqual({ 1: "2020-01-01", 2: "2020-01-09" });
    const seasons = (await db.prepare("SELECT DISTINCT season_number FROM episodes WHERE media_item_id = ?").all(showId)) as any[];
    expect(seasons.map((s) => Number(s.season_number))).toEqual([1]);
  });

  it("infers the first stored id as the item's own even when the only other own id has no episode list", () => {
    // A Trakt result carries an imdb id; "Fetch from TVDB" staged the show's own TVDB result.
    const externalIds = { tvdb: "81189", tmdb: "1396", trakt: "7", imdb: "tt1" };
    const extraMetadata = {
      ...legacyTmdbMerge,
      tvdb: { title: "Legacy Show", externalIds: { tvdb: "81189" } },
      trakt: { title: "Legacy Show", externalIds: { trakt: "7", imdb: "tt1" } },
    };
    expect(mergedProviderIds(externalIds, extraMetadata)).toEqual({ tmdb: "1396", trakt: "7" });
    expect(childListProviderIds({ type: "series", external_ids: JSON.stringify(externalIds), extra_metadata: JSON.stringify(extraMetadata) })).toEqual({
      tvdb: "81189",
      imdb: "tt1",
    });
  });

  it("uses every id when all of them were merged in, and then only fills missing air dates", async () => {
    // An item matched to no provider of its own: every id it has came from a later provider match.
    const showId = await insertItem("series", "Legacy Show", { tvdb: "81189", tmdb: "1396" }, {
      additionalProviderIds: { tvdb: "81189", tmdb: "1396" },
    });
    await insertEpisode(showId, 1, "Pilot", "2020-01-01");
    await insertEpisode(showId, 2, "Second", null);
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2020-01-25", overview: null },
      { seasonNumber: 1, episodeNumber: 2, title: "Second", airDate: "2020-02-01", overview: null },
    ]);

    await refreshOneMediaItem(showId);

    expect(fetchSeriesEpisodesFor).toHaveBeenCalledWith({ tvdb: "81189", tmdb: "1396" });
    expect(await airDates(showId)).toEqual({ 1: "2020-01-01", 2: "2020-02-01" });
  });

  it("uses every id of an item whose ids all came from one provider match, so its air dates only fill gaps", async () => {
    // An anime with no id of its own when every other provider was matched in (AniList found
    // nothing; TVDB, then TMDB, did): its ids and their staged results were appended in that order.
    const staged = {
      tvdb: { title: "Legacy Anime", externalIds: { tvdb: "1" } },
      tmdb: { title: "Legacy Anime", externalIds: { tmdb: "2" } },
    };
    const showId = await insertItem("anime", "Legacy Anime", { tvdb: "1", tmdb: "2" }, staged);
    await insertEpisode(showId, 1, "Pilot", "2020-01-01"); // created from TMDB's list
    fetchSeriesEpisodesFor.mockImplementation(async (ids: Record<string, string>) =>
      ids.tmdb
        ? [{ seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2020-01-02", overview: null }]
        : [
            { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2019-05-05", overview: null },
            { seasonNumber: 1, episodeNumber: 2, title: "TVDB Numbering", airDate: "2019-05-12", overview: null },
          ]
    );

    expect(mergedProviderIds({ tvdb: "1", tmdb: "2" }, staged)).toEqual({ tvdb: "1", tmdb: "2" });
    expect((await refreshOneMediaItem(showId)).ok).toBe(true);

    expect(fetchSeriesEpisodesFor).toHaveBeenCalledTimes(1);
    expect(fetchSeriesEpisodesFor).toHaveBeenCalledWith({ tvdb: "1", tmdb: "2" });
    expect(await airDates(showId)).toEqual({ 1: "2020-01-01" });
  });

  it("a recorded (even empty) merge list is taken as is", () => {
    const externalIds = { tvdb: "81189", tmdb: "1396" };
    expect(mergedProviderIds(externalIds, legacyTmdbMerge)).toEqual({ tmdb: "1396" });
    // A Different Match makes every id the item's own, whatever an older match staged.
    expect(mergedProviderIds(externalIds, { ...legacyTmdbMerge, additionalProviderIds: {} })).toEqual({});
    expect(
      childListProviderIds({ type: "series", external_ids: JSON.stringify(externalIds), extra_metadata: JSON.stringify({ ...legacyTmdbMerge, additionalProviderIds: {} }) })
    ).toEqual(externalIds);
  });

  it("matching another provider later keeps the older merge recorded", async () => {
    const showId = await insertItem("series", "Legacy Show", { tvdb: "81189", tmdb: "1396" }, legacyTmdbMerge);
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider?: string) =>
      provider === "tvmaze" ? [{ title: "Legacy Show", year: null, overview: null, posterUrl: null, externalIds: { tvmaze: "5" } }] : []
    );

    expect(await matchAdditionalProviders(showId)).toEqual([{ provider: "tvmaze", episodesAdded: 0 }]);

    const row = (await db.prepare("SELECT external_ids, extra_metadata FROM media_items WHERE id = ?").get(showId)) as any;
    expect(JSON.parse(row.extra_metadata).additionalProviderIds).toEqual({ tmdb: "1396", tvmaze: "5" });
    expect(childListProviderIds({ type: "series", external_ids: row.external_ids, extra_metadata: row.extra_metadata })).toEqual({ tvdb: "81189" });
  });
});

describe("scan → Refresh → scan of a collection parent", () => {
  it("an author Refresh matches to a differently named hit keeps its folder title, so the next book joins it", async () => {
    const folder = await insertRootFolder("author");
    const authorDir = path.join(folder.path, "Tolkien");
    writeFile(authorDir, "The Hobbit.epub");

    await scanAndImportLibrary("author");
    const [created] = (await db.prepare("SELECT * FROM media_items WHERE type = 'author'").all()) as any[];
    expect(created.title).toBe("Tolkien");

    searchMetadata.mockResolvedValue([{ title: "J.R.R. Tolkien", year: 1892, overview: "Author of The Hobbit.", posterUrl: null, externalIds: { openlibrary: "OL26320A" } }]);
    await refreshLibraryMetadata("author");
    const refreshed = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(created.id)) as any;
    expect(refreshed).toMatchObject({ title: "Tolkien", sort_title: "tolkien", overview: "Author of The Hobbit." });
    expect(JSON.parse(refreshed.external_ids)).toEqual({ openlibrary: "OL26320A" });

    writeFile(authorDir, "The Silmarillion.epub");
    await scanAndImportLibrary("author");

    const authors = (await db.prepare("SELECT * FROM media_items WHERE type = 'author'").all()) as any[];
    expect(authors).toHaveLength(1);
    const books = (await db.prepare("SELECT title FROM sub_items WHERE media_item_id = ? ORDER BY title").all(created.id)) as any[];
    expect(books.map((b) => b.title)).toEqual(["The Hobbit", "The Silmarillion"]);
  });

  it("still takes a hit's title that only changes how the folder title is written", async () => {
    const folder = await insertRootFolder("author");
    const authorDir = path.join(folder.path, "stephen king");
    writeFile(authorDir, "Carrie.epub");

    await scanAndImportLibrary("author");
    searchMetadata.mockResolvedValue([{ title: "Stephen King", year: null, overview: "Horror.", posterUrl: null, externalIds: { openlibrary: "OL2162284A" } }]);
    await refreshLibraryMetadata("author");

    const [author] = (await db.prepare("SELECT * FROM media_items WHERE type = 'author'").all()) as any[];
    expect(author).toMatchObject({ title: "Stephen King", sort_title: "stephen king" });

    writeFile(authorDir, "It.epub");
    await scanAndImportLibrary("author");
    expect((await db.prepare("SELECT * FROM media_items WHERE type = 'author'").all()) as any[]).toHaveLength(1);
  });

  it("an artist Refresh matches to a differently named hit keeps its folder title, so the next album joins it", async () => {
    const folder = await insertRootFolder("artist");
    writeFile(path.join(folder.path, "Beatles", "Abbey Road"), "01 - Come Together.mp3");

    await scanAndImportLibrary("artist");
    searchMetadata.mockResolvedValue([{ title: "The Beatles", year: 1960, overview: "Liverpool.", posterUrl: null, externalIds: { musicbrainz: "b10bbbfc" } }]);
    await refreshLibraryMetadata("artist");

    const [artist] = (await db.prepare("SELECT * FROM media_items WHERE type = 'artist'").all()) as any[];
    expect(artist).toMatchObject({ title: "Beatles", overview: "Liverpool." });
    expect(JSON.parse(artist.external_ids)).toEqual({ musicbrainz: "b10bbbfc" });

    writeFile(path.join(folder.path, "Beatles", "Let It Be"), "01 - Two of Us.mp3");
    await scanAndImportLibrary("artist");

    expect((await db.prepare("SELECT * FROM media_items WHERE type = 'artist'").all()) as any[]).toHaveLength(1);
    const albums = (await db.prepare("SELECT title FROM sub_items WHERE media_item_id = ? ORDER BY title").all(artist.id)) as any[];
    expect(albums.map((a) => a.title)).toEqual(["Abbey Road", "Let It Be"]);
  });

  it("a folder carrying a native-script alias joins the artist added under the ASCII name", async () => {
    const folder = await insertRootFolder("artist");
    const artistId = await insertItem("artist", "BTS", { deezer: "6982223" }, null);
    writeFile(path.join(folder.path, "BTS (방탄소년단)", "Map of the Soul 7"), "01 - Intro.mp3");

    await scanAndImportLibrary("artist");

    const artists = (await db.prepare("SELECT id FROM media_items WHERE type = 'artist'").all()) as any[];
    expect(artists.map((a) => Number(a.id))).toEqual([artistId]);
    const albums = (await db.prepare("SELECT title FROM sub_items WHERE media_item_id = ?").all(artistId)) as any[];
    expect(albums.map((a) => a.title)).toEqual(["Map of the Soul 7"]);
  });
});
