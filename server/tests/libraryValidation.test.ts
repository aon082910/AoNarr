import { describe, it, expect, beforeAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchAllLibraryFiles = vi.fn();
vi.mock("../src/services/mediaServer.js", () => ({
  fetchAllLibraryFiles: (...args: unknown[]) => fetchAllLibraryFiles(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let findLibraryMismatches: (typeof import("../src/services/libraryValidation.js"))["findLibraryMismatches"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ findLibraryMismatches } = await import("../src/services/libraryValidation.js"));
});

async function insertMovie(title: string, path: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('movie', ?, ?, 1, 1, 'unknown', ?)`
        )
        .run(title, title.toLowerCase(), path)
    ).lastInsertRowid
  );
}

async function insertShow(title: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', ?, ?, 1, 1, 'unknown')`)
        .run(title, title.toLowerCase())
    ).lastInsertRowid
  );
}

async function insertEpisode(showId: number, season: number, episode: number, filePath: string): Promise<void> {
  await db
    .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, ?, ?, 1, 1, ?)")
    .run(showId, season, episode, filePath);
}

describe("findLibraryMismatches", () => {
  it("returns no mismatches at all when the media server reports no files", async () => {
    fetchAllLibraryFiles.mockResolvedValueOnce([]);
    await insertMovie("Should Not Be Checked", "/media/movies/Should Not Be Checked/movie.mkv");

    expect(await findLibraryMismatches()).toEqual([]);
  });

  it("does not flag a movie whose path tail matches a server file", async () => {
    fetchAllLibraryFiles.mockResolvedValueOnce([{ path: "/mnt/media/movies/Matching Movie/movie.mkv" }]);
    const id = await insertMovie("Matching Movie", "/data/movies/Matching Movie/movie.mkv");

    const mismatches = await findLibraryMismatches();

    expect(mismatches.some((m) => m.mediaItemId === id)).toBe(false);
  });

  it("flags a movie whose path the media server doesn't have at all", async () => {
    fetchAllLibraryFiles.mockResolvedValueOnce([{ path: "/media/movies/Some Other Movie/movie.mkv" }]);
    const id = await insertMovie("Missing From Server Movie", "/media/movies/Missing From Server Movie/movie.mkv");

    const mismatches = await findLibraryMismatches();

    const found = mismatches.find((m) => m.mediaItemId === id);
    expect(found).toEqual({
      mediaItemId: id,
      type: "movie",
      label: "Missing From Server Movie",
      path: "/media/movies/Missing From Server Movie/movie.mkv",
    });
  });

  it("matches tolerantly across different mount-point prefixes and case", async () => {
    fetchAllLibraryFiles.mockResolvedValueOnce([{ path: "/PLEX/Movies/Case Insensitive Movie/MOVIE.MKV" }]);
    const id = await insertMovie("Case Insensitive Movie", "/mnt/aonarr-media/Movies/case insensitive movie/movie.mkv");

    const mismatches = await findLibraryMismatches();

    expect(mismatches.some((m) => m.mediaItemId === id)).toBe(false);
  });

  it("flags an episode whose path the media server doesn't have, labeled with SxxEyy", async () => {
    fetchAllLibraryFiles.mockResolvedValueOnce([{ path: "/media/tv/Other Show/Season 01/other.mkv" }]);
    const showId = await insertShow("Mismatched Show");
    await insertEpisode(showId, 2, 5, "/media/tv/Mismatched Show/Season 02/episode.mkv");

    const mismatches = await findLibraryMismatches();

    const found = mismatches.find((m) => m.mediaItemId === showId);
    expect(found?.label).toBe("Mismatched Show — S02E05");
  });

  it("does not flag an episode whose path tail matches a server file", async () => {
    fetchAllLibraryFiles.mockResolvedValueOnce([{ path: "/mnt/tv/Matching Show/Season 01/episode.mkv" }]);
    const showId = await insertShow("Matching Episode Show");
    await insertEpisode(showId, 1, 1, "/data/tv/Matching Show/Season 01/episode.mkv");

    const mismatches = await findLibraryMismatches();

    expect(mismatches.some((m) => m.mediaItemId === showId)).toBe(false);
  });

  it("checks a non-movie/series single-shape type (e.g. ppv) too", async () => {
    fetchAllLibraryFiles.mockResolvedValueOnce([{ path: "/media/other/file.mkv" }]);
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('ppv', 'PPV Event', 'ppv event', 1, 1, 'unknown', '/media/ppv/PPV Event/event.mkv')`
          )
          .run()
      ).lastInsertRowid
    );

    const mismatches = await findLibraryMismatches();

    expect(mismatches.some((m) => m.mediaItemId === id)).toBe(true);
  });

  it("never flags a shape the media server has no concept of (e.g. authors/books), even with a mismatched path", async () => {
    fetchAllLibraryFiles.mockResolvedValueOnce([{ path: "/media/other/file.mkv" }]);
    // "author" is a "collection"-shaped type (its real files live on sub_items, not its own path) —
    // this row is deliberately unrealistic, just to prove the type filter itself excludes it
    // regardless of what has_file/path happen to hold.
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('author', 'An Author', 'an author', 1, 1, 'unknown', '/media/books/An Author/book.epub')`
          )
          .run()
      ).lastInsertRowid
    );

    const mismatches = await findLibraryMismatches();

    expect(mismatches.some((m) => m.mediaItemId === id)).toBe(false);
  });
});
