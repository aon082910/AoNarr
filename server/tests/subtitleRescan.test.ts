import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const downloadSubtitleForLanguage = vi.fn(async () => true);
vi.mock("../src/services/importer.js", () => ({
  downloadSubtitleForLanguage: (...args: unknown[]) => downloadSubtitleForLanguage(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let rescanMissingSubtitles: (typeof import("../src/services/subtitleRescan.js"))["rescanMissingSubtitles"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ rescanMissingSubtitles } = await import("../src/services/subtitleRescan.js"));
});

afterEach(async () => {
  // rescanMissingSubtitles re-scans the ENTIRE library every call, with no memory of prior runs —
  // any movie/episode left behind by one test would be reprocessed by the next, corrupting a
  // "not called"/exact-call-count assertion. Reset fully between tests rather than relying on
  // unique titles, since the whole point here is testing what the *entire table* looks like.
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM subtitle_providers").run();
  downloadSubtitleForLanguage.mockClear();
});

async function insertProvider(overrides: { type?: string; apiKey?: string | null; languages?: string; enabled?: number } = {}): Promise<void> {
  const { type = "opensubtitles", apiKey = "some-api-key", languages = "eng", enabled = 1 } = overrides;
  await db.prepare("INSERT INTO subtitle_providers (name, type, api_key, languages, enabled) VALUES ('Test Provider', ?, ?, ?, ?)").run(
    type,
    apiKey,
    languages,
    enabled
  );
}

async function insertMovie(title: string, filePath: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('movie', ?, ?, 1, 1, 'unknown', ?)`)
        .run(title, title.toLowerCase(), filePath)
    ).lastInsertRowid
  );
}

describe("rescanMissingSubtitles — gating", () => {
  it("does nothing when no subtitle provider is enabled", async () => {
    await rescanMissingSubtitles();
    expect(downloadSubtitleForLanguage).not.toHaveBeenCalled();
  });

  it("does nothing when a non-custom provider has no api key", async () => {
    await insertProvider({ type: "opensubtitles", apiKey: null });

    await rescanMissingSubtitles();

    expect(downloadSubtitleForLanguage).not.toHaveBeenCalled();
  });

  it("does nothing when the configured languages string is empty", async () => {
    await insertProvider({ languages: "   ,  ," });

    await rescanMissingSubtitles();

    expect(downloadSubtitleForLanguage).not.toHaveBeenCalled();
  });
});

describe("rescanMissingSubtitles — matching files", () => {
  it("downloads a subtitle for a single-shape item with a video file", async () => {
    await insertProvider({ languages: "eng" });
    const id = await insertMovie("Rescan Movie", "/media/movies/Rescan Movie/movie.mkv");

    await rescanMissingSubtitles();

    expect(downloadSubtitleForLanguage).toHaveBeenCalledWith("/media/movies/Rescan Movie/movie.mkv", id, "eng", expect.anything(), true);
  });

  it("skips a file whose extension isn't a recognized video format", async () => {
    await insertProvider({ languages: "eng" });
    await insertMovie("Non Video Movie", "/media/movies/Non Video Movie/movie.iso");

    await rescanMissingSubtitles();

    expect(downloadSubtitleForLanguage).not.toHaveBeenCalled();
  });

  it("skips a non-single-shape type even if it has a path set", async () => {
    await insertProvider({ languages: "eng" });
    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('audiobook', 'Collection Shape Item', 'x', 1, 1, 'unknown', '/media/audiobooks/x/book.mkv')`
      )
      .run();

    await rescanMissingSubtitles();

    expect(downloadSubtitleForLanguage).not.toHaveBeenCalled();
  });

  it("downloads a subtitle for each configured language", async () => {
    await insertProvider({ languages: "eng, spa" });
    await insertMovie("Multi Language Movie", "/media/movies/Multi Language Movie/movie.mkv");

    await rescanMissingSubtitles();

    expect(downloadSubtitleForLanguage).toHaveBeenCalledTimes(2);
    const languages = downloadSubtitleForLanguage.mock.calls.map((c) => c[2]);
    expect(languages.sort()).toEqual(["eng", "spa"]);
  });

  it("downloads a subtitle for an episode with a video file", async () => {
    await insertProvider({ languages: "eng" });
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Rescan Show', 'rescan show', 1, 1, 'unknown')`).run())
        .lastInsertRowid
    );
    await db
      .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, 1, 1, 1, ?)")
      .run(showId, "/media/tv/Rescan Show/Season 01/episode.mkv");

    await rescanMissingSubtitles();

    expect(downloadSubtitleForLanguage).toHaveBeenCalledWith("/media/tv/Rescan Show/Season 01/episode.mkv", showId, "eng", expect.anything(), true);
  });

  it("continues to the next language/item when a download attempt throws", async () => {
    await insertProvider({ languages: "eng, spa" });
    await insertMovie("Throwing Movie", "/media/movies/Throwing Movie/movie.mkv");
    downloadSubtitleForLanguage.mockImplementationOnce(async () => {
      throw new Error("provider unreachable");
    });

    await expect(rescanMissingSubtitles()).resolves.not.toThrow();

    expect(downloadSubtitleForLanguage).toHaveBeenCalledTimes(2); // both languages still attempted
  });
});
