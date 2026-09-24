import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { MediaServerLibraryItem, MediaServerShowInfo, MediaServerEpisodeItem } from "../src/services/mediaServer.js";

// Only importMoviesFromMediaServer/importSeriesFromMediaServer (thin wrappers) call these two
// fetchers -- the core importMovieItems/importSeriesData functions take already-fetched items
// directly, so mocking them here is inert for every other test in this file (the rest of
// mediaServer.js, e.g. the artwork-ref helpers, stays real).
const fetchMediaServerMovies = vi.fn();
const fetchMediaServerSeries = vi.fn();
vi.mock("../src/services/mediaServer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/mediaServer.js")>();
  return {
    ...actual,
    fetchMediaServerMovies: (...args: unknown[]) => fetchMediaServerMovies(...args),
    fetchMediaServerSeries: (...args: unknown[]) => fetchMediaServerSeries(...args),
  };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let defaultQualityProfileId: (typeof import("../src/services/mediaServerImport.js"))["defaultQualityProfileId"];
let importMovieItems: (typeof import("../src/services/mediaServerImport.js"))["importMovieItems"];
let importSeriesData: (typeof import("../src/services/mediaServerImport.js"))["importSeriesData"];
let importMoviesFromMediaServer: (typeof import("../src/services/mediaServerImport.js"))["importMoviesFromMediaServer"];
let importSeriesFromMediaServer: (typeof import("../src/services/mediaServerImport.js"))["importSeriesFromMediaServer"];
let migrateCredentialedMediaServerPosters: (typeof import("../src/services/mediaServerImport.js"))["migrateCredentialedMediaServerPosters"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({
    defaultQualityProfileId,
    importMovieItems,
    importSeriesData,
    importMoviesFromMediaServer,
    importSeriesFromMediaServer,
    migrateCredentialedMediaServerPosters,
  } = await import("../src/services/mediaServerImport.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(async () => {
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM media_items").run();
  fetchMediaServerMovies.mockReset();
  fetchMediaServerSeries.mockReset();
});

function movieItem(overrides: Partial<MediaServerLibraryItem> = {}): MediaServerLibraryItem {
  return {
    mediaServerId: "ms-1",
    path: "/movies/Movie.mkv",
    title: "A Movie",
    year: 2020,
    overview: "An overview",
    posterUrl: "http://poster",
    externalIds: { tmdb: "100" },
    ...overrides,
  };
}

function showInfo(overrides: Partial<MediaServerShowInfo> = {}): MediaServerShowInfo {
  return { title: "A Show", year: 2020, overview: "Show overview", posterUrl: "http://show-poster", externalIds: { tvdb: "200" }, ...overrides };
}

function episodeItem(overrides: Partial<MediaServerEpisodeItem> = {}): MediaServerEpisodeItem {
  return { showId: "ms-show-1", path: "/tv/S01E01.mkv", seasonNumber: 1, episodeNumber: 1, title: "Pilot", overview: "Ep overview", ...overrides };
}

describe("titlesMatch", () => {
  it("matches identical titles regardless of case/punctuation", async () => {
    const { titlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(titlesMatch("Dune: Part Two", "dune part two")).toBe(true);
  });

  it("is substring-tolerant in either direction — the fuzziness titleAndYearMatch relies on", async () => {
    const { titlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(titlesMatch("The Office", "The Office (US)")).toBe(true);
    expect(titlesMatch("The Office (US)", "The Office")).toBe(true);
  });

  it("rejects unrelated titles", async () => {
    const { titlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(titlesMatch("Dune", "Totally Unrelated Movie")).toBe(false);
  });

  it("never matches when either side normalizes to empty", async () => {
    const { titlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(titlesMatch("", "Anything")).toBe(false);
    expect(titlesMatch("!!!", "Anything")).toBe(false);
  });
});

// Regression coverage for a real bug: starrImport.ts's artist/author matching used the
// substring-tolerant titlesMatch above with no year to gate it (artists/authors have no year field
// at all) — the exact class of cross-item-merge bug libraryScan.ts's own titlesMatch was made
// exact-only to fix (e.g. "Extraction" swallowing "Extraction 2"), reintroduced here for
// Lidarr/Readarr imports. exactTitlesMatch exists specifically so that call site can't do this.
describe("exactTitlesMatch", () => {
  it("matches identical titles regardless of case/punctuation, same as titlesMatch", async () => {
    const { exactTitlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(exactTitlesMatch("Dune: Part Two", "dune part two")).toBe(true);
  });

  it("does NOT match a title that is merely a substring of the other, unlike titlesMatch", async () => {
    const { exactTitlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(exactTitlesMatch("Extraction", "Extraction 2")).toBe(false);
    expect(exactTitlesMatch("The Office", "The Office UK")).toBe(false);
  });

  it("never matches when either side normalizes to empty", async () => {
    const { exactTitlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(exactTitlesMatch("", "")).toBe(false);
  });
});

describe("titleAndYearMatch", () => {
  it("uses substring-tolerant matching when both years are known and agree", async () => {
    const { titleAndYearMatch } = await import("../src/services/mediaServerImport.js");
    expect(titleAndYearMatch("The Office", 2005, "The Office (US)", 2005)).toBe(true);
  });

  it("never matches when both years are known but disagree, even if titles are identical", async () => {
    const { titleAndYearMatch } = await import("../src/services/mediaServerImport.js");
    expect(titleAndYearMatch("Extraction", 2020, "Extraction", 2023)).toBe(false);
  });

  it("falls back to an EXACT title match (no substring tolerance) when either year is unknown", async () => {
    const { titleAndYearMatch } = await import("../src/services/mediaServerImport.js");
    // Two unknown years must not trivially match each other via substring tolerance — this is the
    // exact scenario titleAndYearMatch's own doc comment warns "Extraction 2" folding into
    // "Extraction" under.
    expect(titleAndYearMatch("Extraction", null, "Extraction 2", null)).toBe(false);
    expect(titleAndYearMatch("Dune", null, "Dune", null)).toBe(true);
    expect(titleAndYearMatch("Dune", 2021, "Dune", null)).toBe(false);
    expect(titleAndYearMatch("Dune", null, "Dune", 2021)).toBe(false);
  });
});

describe("externalIdsOverlap", () => {
  it("matches when any one provider's id agrees", async () => {
    const { externalIdsOverlap } = await import("../src/services/mediaServerImport.js");
    expect(externalIdsOverlap({ tmdb: "123", imdb: "tt999" }, { tmdb: "123" })).toBe(true);
  });

  it("does not match when the same provider has a different id", async () => {
    const { externalIdsOverlap } = await import("../src/services/mediaServerImport.js");
    expect(externalIdsOverlap({ tmdb: "123" }, { tmdb: "456" })).toBe(false);
  });

  it("does not match when there's no shared provider at all", async () => {
    const { externalIdsOverlap } = await import("../src/services/mediaServerImport.js");
    expect(externalIdsOverlap({ imdb: "tt999" }, { tmdb: "123" })).toBe(false);
  });

  it("treats a null/missing existing-ids map as no overlap rather than throwing", async () => {
    const { externalIdsOverlap } = await import("../src/services/mediaServerImport.js");
    expect(externalIdsOverlap(null, { tmdb: "123" })).toBe(false);
  });
});

describe("defaultQualityProfileId", () => {
  it("returns null when no quality profiles exist, and the first row's id otherwise", async () => {
    await db.prepare("DELETE FROM quality_profiles").run();
    expect(await defaultQualityProfileId()).toBeNull();

    const result = await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES ('Test Profile', '[]', 'HD-1080p')").run();
    expect(await defaultQualityProfileId()).toBe(Number(result.lastInsertRowid));

    await db.prepare("DELETE FROM quality_profiles WHERE name = 'Test Profile'").run();
  });
});

describe("importMovieItems", () => {
  it("creates a new row when nothing matches, populating every field, with has_file driven by path presence", async () => {
    const result = await importMovieItems([movieItem()], null);

    expect(result).toEqual({ matched: 0, created: 1, skipped: 0 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE title = 'A Movie'").get()) as any;
    expect(row).toMatchObject({
      type: "movie", sort_title: "a movie", year: 2020, overview: "An overview", poster_url: "http://poster",
      path: "/movies/Movie.mkv", has_file: 1, monitored: 1, status: "unknown",
    });
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "100" });

    await db.prepare("DELETE FROM media_items").run();
    const noPathResult = await importMovieItems([movieItem({ path: null })], null);
    expect(noPathResult).toEqual({ matched: 0, created: 1, skipped: 0 });
    expect(((await db.prepare("SELECT has_file FROM media_items WHERE title = 'A Movie'").get()) as any).has_file).toBe(0);
  });

  it("skips an item with no title", async () => {
    const result = await importMovieItems([movieItem({ title: "" })], null);
    expect(result).toEqual({ matched: 0, created: 0, skipped: 1 });
  });

  it("skips an item whose path-tail is already a known movie path", async () => {
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, path, monitored, status) VALUES ('movie', 'Existing', 'existing', '/movies/Movie.mkv', 1, 'unknown')`).run();

    const result = await importMovieItems([movieItem({ title: "Different Title Same File" })], null);

    expect(result).toEqual({ matched: 0, created: 0, skipped: 1 });
  });

  it("matches an existing item by external id overlap, filling in only null fields via COALESCE without overwriting the title", async () => {
    const existingId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, external_ids, overview, monitored, status) VALUES ('movie','Old Title','old', ?, 'Existing overview', 1, 'unknown')`
          )
          .run(JSON.stringify({ tmdb: "100" }))
      ).lastInsertRowid
    );

    const result = await importMovieItems([movieItem({ title: "New Media Server Title" })], null);

    expect(result).toEqual({ matched: 1, created: 0, skipped: 0 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(existingId)) as any;
    expect(row.title).toBe("Old Title"); // a match never renames the existing row
    expect(row.overview).toBe("Existing overview"); // COALESCE kept the existing value
    expect(row.path).toBe("/movies/Movie.mkv"); // was null, now filled in
    expect(row.has_file).toBe(1);
  });

  it("matches by title+year when there's no external id overlap", async () => {
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, status) VALUES ('movie','A Movie','a movie', 2020, 1, 'unknown')`).run();

    const result = await importMovieItems([movieItem({ externalIds: {} })], null);

    expect(result).toEqual({ matched: 1, created: 0, skipped: 0 });
  });

  it("a match with no item.path (Starr-sourced) only fills metadata and never downgrades an already-downloaded item's has_file/path", async () => {
    const existingId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, external_ids, has_file, path, monitored, status) VALUES ('movie','Old','old', ?, 1, '/existing/path.mkv', 1, 'unknown')`
          )
          .run(JSON.stringify({ tmdb: "100" }))
      ).lastInsertRowid
    );

    const result = await importMovieItems([movieItem({ path: null })], null);

    expect(result).toEqual({ matched: 1, created: 0, skipped: 0 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(existingId)) as any;
    expect(row.has_file).toBe(1); // unchanged
    expect(row.path).toBe("/existing/path.mkv"); // unchanged
  });

  it("matches against ALL movies, not just has_file=0 ones -- a re-scanned already-downloaded movie matches instead of duplicating", async () => {
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, external_ids, has_file, monitored, status) VALUES ('movie','A Movie','a movie', ?, 1, 1, 'unknown')`)
      .run(JSON.stringify({ tmdb: "100" }));

    const result = await importMovieItems([movieItem()], null);

    expect(result).toEqual({ matched: 1, created: 0, skipped: 0 });
  });

  it("two media-server items for the same new movie in one batch: the second matches the first instead of creating a duplicate", async () => {
    const result = await importMovieItems([movieItem(), movieItem({ path: "/movies/Movie2.mkv" })], null);

    expect(result).toEqual({ matched: 1, created: 1, skipped: 0 });
    expect((await db.prepare("SELECT * FROM media_items WHERE title = 'A Movie'").all()) as any[]).toHaveLength(1);
  });

  it("stops processing once the AbortSignal fires mid-loop", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await importMovieItems([movieItem()], null, controller.signal);

    expect(result).toEqual({ matched: 0, created: 0, skipped: 0 });
    expect((await db.prepare("SELECT COUNT(*) as c FROM media_items").get()) as any).toMatchObject({ c: 0 });
  });

  it("tolerates a malformed external_ids JSON on an existing row rather than crashing the match loop", async () => {
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status) VALUES ('movie','Malformed','malformed','{not json',1,'unknown')`).run();

    const result = await importMovieItems([movieItem({ title: "Totally New Title", externalIds: {} })], null);

    expect(result).toEqual({ matched: 0, created: 1, skipped: 0 }); // no crash, falls through to create
  });
});

describe("importSeriesData", () => {
  it("creates a new show and episode when nothing matches, and rolls the show's has_file up from its episode", async () => {
    const shows = new Map([["ms-show-1", showInfo()]]);

    const result = await importSeriesData(shows, [episodeItem()], "series", null);

    expect(result).toEqual({ showsMatched: 0, showsCreated: 1, episodesMatched: 0, episodesCreated: 1, episodesSkipped: 0 });
    const show = (await db.prepare("SELECT * FROM media_items WHERE title = 'A Show'").get()) as any;
    expect(show).toMatchObject({ type: "series", has_file: 1 });
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(show.id)) as any;
    expect(ep).toMatchObject({ season_number: 1, episode_number: 1, title: "Pilot", has_file: 1, file_path: "/tv/S01E01.mkv" });
  });

  it("resolves the same show only once across multiple episodes (memoized)", async () => {
    const shows = new Map([["ms-show-1", showInfo()]]);
    const episodes = [episodeItem({ episodeNumber: 1 }), episodeItem({ episodeNumber: 2, path: "/tv/S01E02.mkv" })];

    const result = await importSeriesData(shows, episodes, "series", null);

    expect(result).toEqual({ showsMatched: 0, showsCreated: 1, episodesMatched: 0, episodesCreated: 2, episodesSkipped: 0 });
    expect((await db.prepare("SELECT COUNT(*) as c FROM media_items WHERE type='series'").get()) as any).toMatchObject({ c: 1 });
  });

  it("skips an episode whose show has no title in the shows map, and one whose show id isn't in the map at all", async () => {
    const noTitleResult = await importSeriesData(new Map([["ms-show-1", showInfo({ title: "" })]]), [episodeItem()], "series", null);
    expect(noTitleResult).toEqual({ showsMatched: 0, showsCreated: 0, episodesMatched: 0, episodesCreated: 0, episodesSkipped: 1 });

    const unknownShowResult = await importSeriesData(new Map(), [episodeItem({ showId: "unknown-show" })], "series", null);
    expect(unknownShowResult.episodesSkipped).toBe(1);
  });

  it("skips an episode whose path-tail is already known", async () => {
    const showId = Number((await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('series','X','x',1,'unknown')`).run()).lastInsertRowid);
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, file_path) VALUES (?, 1, 1, '/tv/S01E01.mkv')").run(showId);

    const shows = new Map([["ms-show-1", showInfo()]]);
    const result = await importSeriesData(shows, [episodeItem()], "series", null);

    expect(result.episodesSkipped).toBe(1);
  });

  it("matches an existing show by title+year, filling metadata via COALESCE without overwriting existing values", async () => {
    const existingId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, overview, monitored, status) VALUES ('series','A Show','a show', 2020, 'Existing overview', 1, 'unknown')`
          )
          .run()
      ).lastInsertRowid
    );

    const shows = new Map([["ms-show-1", showInfo({ externalIds: {} })]]);
    const result = await importSeriesData(shows, [episodeItem()], "series", null);

    expect(result.showsMatched).toBe(1);
    expect(result.showsCreated).toBe(0);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(existingId)) as any;
    expect(row.overview).toBe("Existing overview");
  });

  it("matches an existing episode by season+episode under the resolved show, updating has_file/file_path/title/overview via COALESCE", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status) VALUES ('series','A Show','a show', ?, 1, 'unknown')`)
          .run(JSON.stringify({ tvdb: "200" }))
      ).lastInsertRowid
    );
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title) VALUES (?, 1, 1, 'Old Title')").run(showId);

    const shows = new Map([["ms-show-1", showInfo()]]);
    const result = await importSeriesData(shows, [episodeItem({ title: "New Title From Media Server" })], "series", null);

    expect(result).toEqual({ showsMatched: 1, showsCreated: 0, episodesMatched: 1, episodesCreated: 0, episodesSkipped: 0 });
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(showId)) as any;
    expect(ep.title).toBe("Old Title"); // COALESCE kept the existing title
    expect(ep.has_file).toBe(1);
    expect(ep.file_path).toBe("/tv/S01E01.mkv");
  });

  it("a matched episode with no ep.path (Starr-sourced) only fills title/overview and never downgrades has_file/file_path", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status) VALUES ('series','A Show','a show', ?, 1, 'unknown')`)
          .run(JSON.stringify({ tvdb: "200" }))
      ).lastInsertRowid
    );
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, has_file, file_path) VALUES (?, 1, 1, 1, '/existing/ep.mkv')").run(showId);

    const shows = new Map([["ms-show-1", showInfo()]]);
    const result = await importSeriesData(shows, [episodeItem({ path: null })], "series", null);

    expect(result.episodesMatched).toBe(1);
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(showId)) as any;
    expect(ep.has_file).toBe(1); // unchanged
    expect(ep.file_path).toBe("/existing/ep.mkv"); // unchanged
  });

  it("stops processing once the AbortSignal fires mid-loop", async () => {
    const controller = new AbortController();
    controller.abort();
    const shows = new Map([["ms-show-1", showInfo()]]);

    const result = await importSeriesData(shows, [episodeItem()], "series", null, controller.signal);

    expect(result).toEqual({ showsMatched: 0, showsCreated: 0, episodesMatched: 0, episodesCreated: 0, episodesSkipped: 0 });
  });
});

describe("importSeriesData with synthesized episode numbers (Whisparr)", () => {
  const synthesized = { synthesizedEpisodeNumbers: true };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-msi-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function scene(title: string, filePath: string | null, episodeNumber = 1): MediaServerEpisodeItem {
    return episodeItem({ showId: "studio:s", title, path: filePath, episodeNumber, overview: null });
  }

  async function studioEpisodes(): Promise<{ episode_number: number; title: string; has_file: number; file_path: string | null }[]> {
    return (await db
      .prepare("SELECT e.episode_number, e.title, e.has_file, e.file_path FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE m.title = 'Studio' ORDER BY e.episode_number")
      .all()) as any[];
  }

  it("re-import after a Whisparr upgrade/rename repoints the scene's own row instead of appending a duplicate", async () => {
    const shows = new Map([["studio:s", showInfo({ title: "Studio", externalIds: {} })]]);
    const oldPath = path.join(tmpDir, "Studio", "Scene A WEBDL-1080p.mp4"); // never created: Whisparr deleted it
    const newPath = path.join(tmpDir, "Studio", "Scene A WEBDL-2160p.mp4");

    await importSeriesData(shows, [scene("Scene A", oldPath)], "adult", null, undefined, synthesized);
    const result = await importSeriesData(shows, [scene("Scene A", newPath)], "adult", null, undefined, synthesized);

    expect(result).toMatchObject({ episodesMatched: 1, episodesCreated: 0 });
    expect(await studioEpisodes()).toEqual([{ episode_number: 1, title: "Scene A", has_file: 1, file_path: newPath }]);
  });

  it("repoints a same-titled row already marked missing (has_file = 0) even if a stale path is still recorded", async () => {
    const shows = new Map([["studio:s", showInfo({ title: "Studio", externalIds: {} })]]);
    const stalePath = path.join(tmpDir, "stale.mp4");
    fs.writeFileSync(stalePath, "x");
    await importSeriesData(shows, [scene("Scene A", stalePath)], "adult", null, undefined, synthesized);
    await db.prepare("UPDATE episodes SET has_file = 0").run();

    const newPath = path.join(tmpDir, "fresh.mp4");
    await importSeriesData(shows, [scene("Scene A", newPath)], "adult", null, undefined, synthesized);

    expect(await studioEpisodes()).toEqual([{ episode_number: 1, title: "Scene A", has_file: 1, file_path: newPath }]);
  });

  it("appends a new episode when every same-titled row still holds a different file that exists", async () => {
    const shows = new Map([["studio:s", showInfo({ title: "Studio", externalIds: {} })]]);
    const firstPath = path.join(tmpDir, "first", "Scene A.mp4");
    fs.mkdirSync(path.dirname(firstPath), { recursive: true });
    fs.writeFileSync(firstPath, "x");
    const secondPath = path.join(tmpDir, "second", "Scene A.mp4");

    await importSeriesData(shows, [scene("Scene A", firstPath)], "adult", null, undefined, synthesized);
    const result = await importSeriesData(shows, [scene("Scene A", secondPath)], "adult", null, undefined, synthesized);

    expect(result).toMatchObject({ episodesMatched: 0, episodesCreated: 1 });
    expect((await studioEpisodes()).map((e) => [e.episode_number, e.file_path])).toEqual([
      [1, firstPath],
      [2, secondPath],
    ]);
  });

  it("two same-titled scenes in one run each keep their own row, even when neither file is visible on this machine", async () => {
    const shows = new Map([["studio:s", showInfo({ title: "Studio", externalIds: {} })]]);
    const a = path.join(tmpDir, "a", "Scene A.mp4");
    const b = path.join(tmpDir, "b", "Scene A.mp4");

    const result = await importSeriesData(shows, [scene("Scene A", a, 1), scene("Scene A", b, 2)], "adult", null, undefined, synthesized);

    expect(result).toMatchObject({ episodesMatched: 0, episodesCreated: 2 });
    expect((await studioEpisodes()).map((e) => e.file_path)).toEqual([a, b]);
  });
});

describe("media-server artwork never stores the server's credential in poster_url", () => {
  const PROXIED = /^\/api\/media\/local-artwork\/([0-9a-f]{40})$/;

  it("a new movie with a media-server poster gets the token-gated proxy URL, the server-relative path kept aside", async () => {
    await importMovieItems([movieItem({ posterUrl: "mediaserver:/library/metadata/77/thumb/1700000000" })], null);

    const row = (await db.prepare("SELECT poster_url, local_poster_path, local_poster_token FROM media_items WHERE title = 'A Movie'").get()) as any;
    expect(row.poster_url).toMatch(PROXIED);
    expect(row.poster_url).not.toMatch(/token=|api_key|plex/i);
    expect(row.local_poster_path).toBe("mediaserver:/library/metadata/77/thumb/1700000000");
    expect(row.local_poster_token).toBe(PROXIED.exec(row.poster_url)![1]);
  });

  it("a matched movie with no poster gets the proxied one, while one that already has a poster keeps it", async () => {
    const noPosterId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status) VALUES ('movie','No Poster','no poster', ?, 1, 'unknown')`)
          .run(JSON.stringify({ tmdb: "301" }))
      ).lastInsertRowid
    );
    const hasPosterId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, external_ids, poster_url, monitored, status) VALUES ('movie','Has Poster','has poster', ?, 'https://image.tmdb.org/t/p/w500/kept.jpg', 1, 'unknown')`
          )
          .run(JSON.stringify({ tmdb: "302" }))
      ).lastInsertRowid
    );

    await importMovieItems(
      [
        movieItem({ path: "/movies/NoPoster.mkv", externalIds: { tmdb: "301" }, posterUrl: "mediaserver:/library/metadata/301/thumb/1" }),
        movieItem({ path: "/movies/HasPoster.mkv", externalIds: { tmdb: "302" }, posterUrl: "mediaserver:/library/metadata/302/thumb/1" }),
      ],
      null
    );

    const noPoster = (await db.prepare("SELECT poster_url, local_poster_path FROM media_items WHERE id = ?").get(noPosterId)) as any;
    expect(noPoster.poster_url).toMatch(PROXIED);
    expect(noPoster.local_poster_path).toBe("mediaserver:/library/metadata/301/thumb/1");
    const hasPoster = (await db.prepare("SELECT poster_url, local_poster_path FROM media_items WHERE id = ?").get(hasPosterId)) as any;
    expect(hasPoster.poster_url).toBe("https://image.tmdb.org/t/p/w500/kept.jpg");
    expect(hasPoster.local_poster_path).toBeNull();
  });

  it("a new show with a Jellyfin/Emby poster gets the proxied URL too", async () => {
    const shows = new Map([["ms-show-1", showInfo({ posterUrl: "mediaserver:/emby/Items/abc123/Images/Primary" })]]);

    await importSeriesData(shows, [episodeItem()], "series", null);

    const row = (await db.prepare("SELECT poster_url, local_poster_path FROM media_items WHERE title = 'A Show'").get()) as any;
    expect(row.poster_url).toMatch(PROXIED);
    expect(row.local_poster_path).toBe("mediaserver:/emby/Items/abc123/Images/Primary");
  });

  it("an ordinary public poster URL is stored as-is", async () => {
    await importMovieItems([movieItem({ posterUrl: "https://image.tmdb.org/t/p/w500/public.jpg" })], null);

    const row = (await db.prepare("SELECT poster_url, local_poster_path FROM media_items WHERE title = 'A Movie'").get()) as any;
    expect(row.poster_url).toBe("https://image.tmdb.org/t/p/w500/public.jpg");
    expect(row.local_poster_path).toBeNull();
  });
});

describe("migrateCredentialedMediaServerPosters", () => {
  async function insertWithPoster(title: string, posterUrl: string): Promise<number> {
    return Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, poster_url, monitored, status) VALUES ('movie', ?, ?, ?, 1, 'unknown')`)
          .run(title, title.toLowerCase(), posterUrl)
      ).lastInsertRowid
    );
  }

  function configureMediaServer(type: string, url: string): void {
    setSetting("mediaServerType", type);
    setSetting("mediaServerUrl", url);
    setSetting("mediaServerToken", "owner-token");
  }

  async function posterRow(id: number): Promise<{ poster_url: string; local_poster_path: string | null; local_poster_token: string | null }> {
    return (await db.prepare("SELECT poster_url, local_poster_path, local_poster_token FROM media_items WHERE id = ?").get(id)) as any;
  }

  function unconfigureMediaServer(): void {
    for (const key of ["mediaServerType", "mediaServerUrl", "mediaServerToken"]) setSetting(key, "");
  }

  afterEach(unconfigureMediaServer);

  it("does nothing when no media server is configured", async () => {
    unconfigureMediaServer();
    const posterUrl = "http://plex:32400/library/metadata/1/thumb/2?X-Plex-Token=abc";
    const id = await insertWithPoster("Old Plex Import", posterUrl);

    expect(await migrateCredentialedMediaServerPosters()).toBe(0);
    expect(await posterRow(id)).toEqual({ poster_url: posterUrl, local_poster_path: null, local_poster_token: null });
  });

  it("Plex: moves the configured server's artwork URLs behind the proxy and leaves every other poster alone", async () => {
    configureMediaServer("plex", "http://plex:32400/");
    const plexId = await insertWithPoster("Old Plex Import", "http://plex:32400/library/metadata/1/thumb/2?X-Plex-Token=abc");
    const otherServerId = await insertWithPoster("Other Server", "http://elsewhere:32400/library/metadata/1/thumb/2?X-Plex-Token=abc");
    const nonArtworkUrl = "http://plex:32400/library/sections/all/refresh?X-Plex-Token=x"; // e.g. a household user's request poster
    const nonArtworkId = await insertWithPoster("Not Artwork", nonArtworkUrl);
    const tmdbId = await insertWithPoster("TMDB Poster", "https://image.tmdb.org/t/p/w500/abc.jpg");
    const unrelatedId = await insertWithPoster("Unrelated Api Key", "https://example.com/poster.jpg?api_key=public-cdn-key");

    expect(await migrateCredentialedMediaServerPosters()).toBe(1);

    const plex = await posterRow(plexId);
    expect(plex.poster_url).toMatch(/^\/api\/media\/local-artwork\/[0-9a-f]{40}$/);
    expect(plex.local_poster_path).toBe("mediaserver:/library/metadata/1/thumb/2"); // no query string, so no token
    expect(plex.poster_url).toBe(`/api/media/local-artwork/${plex.local_poster_token}`);

    expect((await posterRow(otherServerId)).poster_url).toBe("http://elsewhere:32400/library/metadata/1/thumb/2?X-Plex-Token=abc");
    expect(await posterRow(nonArtworkId)).toEqual({ poster_url: nonArtworkUrl, local_poster_path: null, local_poster_token: null });
    expect(await posterRow(tmdbId)).toEqual({ poster_url: "https://image.tmdb.org/t/p/w500/abc.jpg", local_poster_path: null, local_poster_token: null });
    expect((await posterRow(unrelatedId)).poster_url).toBe("https://example.com/poster.jpg?api_key=public-cdn-key");

    expect(await migrateCredentialedMediaServerPosters()).toBe(0); // idempotent once converted
  });

  it("Jellyfin behind a Base URL: the ref is relative to the configured URL, so the proxy doesn't double the sub-path", async () => {
    configureMediaServer("jellyfin", "http://jf:8096/jellyfin");
    const id = await insertWithPoster("Sub-path Jellyfin", "http://jf:8096/jellyfin/Items/x/Images/Primary?api_key=k");
    const outsideBaseId = await insertWithPoster("Outside Base", "http://jf:8096/Items/y/Images/Primary?api_key=k");

    expect(await migrateCredentialedMediaServerPosters()).toBe(1);

    expect((await posterRow(id)).local_poster_path).toBe("mediaserver:/Items/x/Images/Primary");
    expect((await posterRow(outsideBaseId)).local_poster_path).toBeNull();
  });

  it("Emby: keeps the /emby prefix every Emby artwork URL was built with", async () => {
    configureMediaServer("emby", "http://emby:8096");
    const id = await insertWithPoster("Old Emby Import", "http://emby:8096/emby/Items/9/Images/Primary?api_key=k");
    const nonArtworkId = await insertWithPoster("Emby Non-Artwork", "http://emby:8096/emby/Users?api_key=k");

    expect(await migrateCredentialedMediaServerPosters()).toBe(1);

    expect((await posterRow(id)).local_poster_path).toBe("mediaserver:/emby/Items/9/Images/Primary");
    expect((await posterRow(nonArtworkId)).poster_url).toBe("http://emby:8096/emby/Users?api_key=k");
  });
});

describe("importMoviesFromMediaServer / importSeriesFromMediaServer (thin wrappers)", () => {
  it("importMoviesFromMediaServer fetches from the configured media server then delegates to importMovieItems", async () => {
    fetchMediaServerMovies.mockResolvedValue([movieItem()]);

    const result = await importMoviesFromMediaServer(null);

    expect(result).toEqual({ matched: 0, created: 1, skipped: 0 });
    expect(fetchMediaServerMovies).toHaveBeenCalledTimes(1);
  });

  it("importSeriesFromMediaServer fetches from the configured media server then delegates to importSeriesData", async () => {
    fetchMediaServerSeries.mockResolvedValue({ shows: new Map([["ms-show-1", showInfo()]]), episodes: [episodeItem()] });

    const result = await importSeriesFromMediaServer("series", null);

    expect(result.showsCreated).toBe(1);
    expect(result.episodesCreated).toBe(1);
    expect(fetchMediaServerSeries).toHaveBeenCalledTimes(1);
  });
});
