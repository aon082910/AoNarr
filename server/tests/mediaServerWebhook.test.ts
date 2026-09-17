import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchWatchedFiles = vi.fn();
const resolvePlexFilePath = vi.fn();
vi.mock("../src/services/mediaServer.js", () => ({
  fetchWatchedFiles: (...args: unknown[]) => fetchWatchedFiles(...args),
  resolvePlexFilePath: (...args: unknown[]) => resolvePlexFilePath(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let parsePlexPayload: (typeof import("../src/services/mediaServerWebhook.js"))["parsePlexPayload"];
let parseJellyfinEmbyPayload: (typeof import("../src/services/mediaServerWebhook.js"))["parseJellyfinEmbyPayload"];
let recordWatchEvent: (typeof import("../src/services/mediaServerWebhook.js"))["recordWatchEvent"];
let syncWatchStatusFromMediaServer: (typeof import("../src/services/mediaServerWebhook.js"))["syncWatchStatusFromMediaServer"];
let setSetting: (key: string, value: string) => void;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ parsePlexPayload, parseJellyfinEmbyPayload, recordWatchEvent, syncWatchStatusFromMediaServer } = await import(
    "../src/services/mediaServerWebhook.js"
  ));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  setSetting("watchStatusSyncLastRunAt", "");
});

describe("parsePlexPayload", () => {
  it("returns null for a non-scrobble event, without resolving anything", async () => {
    const result = await parsePlexPayload({ event: "media.play", Metadata: { ratingKey: "1" } });
    expect(result).toBeNull();
    expect(resolvePlexFilePath).not.toHaveBeenCalled();
  });

  it("returns null for a scrobble event with no ratingKey", async () => {
    expect(await parsePlexPayload({ event: "media.scrobble", Metadata: {} })).toBeNull();
  });

  it("returns null when the rating key doesn't resolve to a file", async () => {
    resolvePlexFilePath.mockResolvedValueOnce(null);
    expect(await parsePlexPayload({ event: "media.scrobble", Metadata: { ratingKey: "42" } })).toBeNull();
  });

  it("returns the resolved file path for a genuine scrobble event", async () => {
    resolvePlexFilePath.mockResolvedValueOnce("/media/movies/Some Movie/movie.mkv");
    const result = await parsePlexPayload({ event: "media.scrobble", Metadata: { ratingKey: "42" } });
    expect(result).toEqual({ filePath: "/media/movies/Some Movie/movie.mkv" });
    expect(resolvePlexFilePath).toHaveBeenCalledWith("42");
  });
});

describe("parseJellyfinEmbyPayload", () => {
  it("returns null for a continuous playback-progress notification", () => {
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackProgress", Path: "/media/x.mkv" })).toBeNull();
  });

  it("returns the file path for a playback-stop notification", () => {
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", Path: "/media/x.mkv" })).toEqual({ filePath: "/media/x.mkv" });
  });

  it("falls back to Item.Path when Path is absent", () => {
    expect(parseJellyfinEmbyPayload({ Event: "media.stop", Item: { Path: "/media/y.mkv" } })).toEqual({ filePath: "/media/y.mkv" });
  });

  it("treats a missing notification type field as acceptable, not as a filter failure", () => {
    expect(parseJellyfinEmbyPayload({ Path: "/media/z.mkv" })).toEqual({ filePath: "/media/z.mkv" });
  });

  it("returns null when there's no path anywhere in the payload", () => {
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop" })).toBeNull();
  });
});

describe("recordWatchEvent", () => {
  async function insertMovie(title: string, filePath: string): Promise<number> {
    return Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('movie', ?, ?, 1, 1, 'unknown', ?)`)
          .run(title, title.toLowerCase(), filePath)
      ).lastInsertRowid
    );
  }

  it("records a watch event for a matching media item", async () => {
    const id = await insertMovie("Watched Movie", "/media/movies/Watched Movie/movie.mkv");

    const result = await recordWatchEvent({ filePath: "/mnt/aonarr/movies/Watched Movie/movie.mkv" });

    expect(result).toEqual({ mediaItemId: id, episodeId: null, subItemId: null });
    const row = (await db.prepare("SELECT * FROM watch_events WHERE media_item_id = ?").get(id)) as any;
    expect(row).toBeDefined();
    expect(row.episode_id).toBeNull();
  });

  it("records a watch event for a matching episode", async () => {
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Watched Show', 'watched show', 1, 1, 'unknown')`).run())
        .lastInsertRowid
    );
    const episodeId = Number(
      (
        await db
          .prepare(
            "INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, 1, 1, 1, ?)"
          )
          .run(showId, "/media/tv/Watched Show/Season 01/episode.mkv")
      ).lastInsertRowid
    );

    const result = await recordWatchEvent({ filePath: "/mnt/aonarr/tv/Watched Show/Season 01/episode.mkv" });

    expect(result).toEqual({ mediaItemId: showId, episodeId, subItemId: null });
  });

  it("records a watch event for a matching sub-item", async () => {
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Watched Artist', 'watched artist', 1, 1, 'unknown')`).run())
        .lastInsertRowid
    );
    const subItemId = Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Album', 1, 1, ?)")
          .run(artistId, "/media/music/Watched Artist/Album")
      ).lastInsertRowid
    );

    const result = await recordWatchEvent({ filePath: "/mnt/aonarr/music/Watched Artist/Album" });

    expect(result).toEqual({ mediaItemId: artistId, episodeId: null, subItemId });
  });

  it("returns null and records nothing when no library file matches", async () => {
    const before = (await db.prepare("SELECT COUNT(*) AS c FROM watch_events").get()) as { c: number };

    const result = await recordWatchEvent({ filePath: "/completely/unmatched/path.mkv" });

    expect(result).toBeNull();
    const after = (await db.prepare("SELECT COUNT(*) AS c FROM watch_events").get()) as { c: number };
    expect(Number(after.c)).toBe(Number(before.c));
  });
});

describe("syncWatchStatusFromMediaServer", () => {
  async function insertMovie(title: string, filePath: string): Promise<number> {
    return Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('movie', ?, ?, 1, 1, 'unknown', ?)`)
          .run(title, title.toLowerCase(), filePath)
      ).lastInsertRowid
    );
}

  it("records nothing when the media server reports no watched files", async () => {
    fetchWatchedFiles.mockResolvedValueOnce([]);
    expect(await syncWatchStatusFromMediaServer()).toEqual({ recorded: 0 });
  });

  it("records a new watch event for a matching file and advances the cursor", async () => {
    const { getSetting } = await import("../src/services/settingsStore.js");
    const id = await insertMovie("Sync Watched Movie", "/media/movies/Sync Watched Movie/movie.mkv");
    const playedAt = new Date("2024-06-01T12:00:00Z");
    fetchWatchedFiles.mockResolvedValueOnce([{ path: "/mnt/aonarr/movies/Sync Watched Movie/movie.mkv", lastPlayedAt: playedAt }]);

    const result = await syncWatchStatusFromMediaServer();

    expect(result).toEqual({ recorded: 1 });
    expect(await db.prepare("SELECT id FROM watch_events WHERE media_item_id = ?").get(id)).toBeDefined();
    expect(getSetting("watchStatusSyncLastRunAt")).toBe(playedAt.toISOString());
  });

  it("advances the cursor only past matched files, not unmatched ones with a later timestamp", async () => {
    const { getSetting } = await import("../src/services/settingsStore.js");
    const matchedAt = new Date("2024-07-01T00:00:00Z");
    const unmatchedAt = new Date("2024-08-01T00:00:00Z"); // later, but never matched
    await insertMovie("Cursor Matched Movie", "/media/movies/Cursor Matched Movie/movie.mkv");
    fetchWatchedFiles.mockResolvedValueOnce([
      { path: "/mnt/aonarr/movies/Cursor Matched Movie/movie.mkv", lastPlayedAt: matchedAt },
      { path: "/completely/unmatched/path.mkv", lastPlayedAt: unmatchedAt },
    ]);

    const result = await syncWatchStatusFromMediaServer();

    expect(result).toEqual({ recorded: 1 });
    expect(getSetting("watchStatusSyncLastRunAt")).toBe(matchedAt.toISOString());
  });

  it("doesn't reprocess a file whose lastPlayedAt is at or before the stored cursor", async () => {
    setSetting("watchStatusSyncLastRunAt", new Date("2024-09-01T00:00:00Z").toISOString());
    fetchWatchedFiles.mockResolvedValueOnce([{ path: "/media/old/already-seen.mkv", lastPlayedAt: new Date("2024-08-01T00:00:00Z") }]);

    expect(await syncWatchStatusFromMediaServer()).toEqual({ recorded: 0 });
  });
});
