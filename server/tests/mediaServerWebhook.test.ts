import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const fetchWatchedFiles = vi.fn();
const resolvePlexFilePath = vi.fn();
const resolveJellyfinLikeFilePath = vi.fn();
vi.mock("../src/services/mediaServer.js", () => ({
  fetchWatchedFiles: (...args: unknown[]) => fetchWatchedFiles(...args),
  resolvePlexFilePath: (...args: unknown[]) => resolvePlexFilePath(...args),
  resolveJellyfinLikeFilePath: (...args: unknown[]) => resolveJellyfinLikeFilePath(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let parsePlexPayload: (typeof import("../src/services/mediaServerWebhook.js"))["parsePlexPayload"];
let parseJellyfinEmbyPayload: (typeof import("../src/services/mediaServerWebhook.js"))["parseJellyfinEmbyPayload"];
let recordWatchEvent: (typeof import("../src/services/mediaServerWebhook.js"))["recordWatchEvent"];
let syncWatchStatusFromMediaServer: (typeof import("../src/services/mediaServerWebhook.js"))["syncWatchStatusFromMediaServer"];
let setSetting: (key: string, value: string) => void;

beforeAll(async () => {
  ({ app, db } = await setupTestDb());
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
  // Must stay the first test in this file to parse a stop event with no completion field — the
  // hint is logged once per process.
  it("logs a template hint once when a stop event carries no PlayedToCompletion field at all", async () => {
    const { log } = await import("../src/services/logger.js");
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: "False", Path: "/media/x.mkv" });
      parseJellyfinEmbyPayload({ NotificationType: "PlaybackProgress", Path: "/media/x.mkv" });
      expect(info).not.toHaveBeenCalled(); // a present-but-false flag or a non-stop event isn't a template problem

      expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", Path: "/media/x.mkv" })).toBeNull();
      parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", Path: "/media/x.mkv" });
      expect(info).toHaveBeenCalledTimes(1);
      expect(String(info.mock.calls[0][0])).toContain('"PlayedToCompletion": "{{PlayedToCompletion}}"');
    } finally {
      info.mockRestore();
    }
  });

  it("returns null for a continuous playback-progress notification", () => {
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackProgress", Path: "/media/x.mkv" })).toBeNull();
  });

  it("returns the file path for a playback-stop notification that played to completion", () => {
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: true, Path: "/media/x.mkv" })).toEqual({
      filePath: "/media/x.mkv",
    });
  });

  it("returns null for a playback-stop notification that stopped early", () => {
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: false, Path: "/media/x.mkv" })).toBeNull();
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", Path: "/media/x.mkv" })).toBeNull();
  });

  it("accepts a templated string completion flag, as Jellyfin's plugin renders a .NET bool", () => {
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: "True", Path: "/media/x.mkv" })).toEqual({
      filePath: "/media/x.mkv",
    });
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: "False", Path: "/media/x.mkv" })).toBeNull();
  });

  it("reads Emby's nested PlaybackInfo.PlayedToCompletion and falls back to Item.Path", () => {
    expect(
      parseJellyfinEmbyPayload({ Event: "playback.stop", PlaybackInfo: { PlayedToCompletion: true }, Item: { Path: "/media/y.mkv" } })
    ).toEqual({ filePath: "/media/y.mkv" });
    expect(
      parseJellyfinEmbyPayload({ Event: "playback.stop", PlaybackInfo: { PlayedToCompletion: false }, Item: { Path: "/media/y.mkv" } })
    ).toBeNull();
  });

  it("treats Emby's explicit item.markplayed event as watched, but not item.markunplayed", () => {
    expect(parseJellyfinEmbyPayload({ Event: "item.markplayed", Item: { Path: "/media/m.mkv" } })).toEqual({ filePath: "/media/m.mkv" });
    expect(parseJellyfinEmbyPayload({ Event: "item.markunplayed", Item: { Path: "/media/m.mkv" } })).toBeNull();
  });

  it("with no notification type field, still requires the completion flag", () => {
    expect(parseJellyfinEmbyPayload({ Path: "/media/z.mkv", PlayedToCompletion: true })).toEqual({ filePath: "/media/z.mkv" });
    expect(parseJellyfinEmbyPayload({ Path: "/media/z.mkv" })).toBeNull();
  });

  // The first payload in this file with neither a path nor an item id — the hint is logged once per process.
  it("returns null, logging a template hint once, when there's neither a path nor an item id anywhere", async () => {
    const { log } = await import("../src/services/logger.js");
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: true })).toBeNull();
      expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: true, Path: "" })).toBeNull();
      expect(info).toHaveBeenCalledTimes(1);
      expect(String(info.mock.calls[0][0])).toContain('"ItemId": "{{ItemId}}"');
    } finally {
      info.mockRestore();
    }
  });

  it("falls back to Jellyfin's ItemId when the payload has no usable path", () => {
    // The Jellyfin plugin has no Path variable, so a "{{Path}}" template renders an empty string.
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: "True", Path: "", ItemId: "a1b2-c3d4" })).toEqual({
      filePath: "",
      itemId: "a1b2-c3d4",
    });
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: "True", ItemId: "abc123" })).toEqual({
      filePath: "",
      itemId: "abc123",
    });
    // A real path still wins over the id.
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: true, Path: "/media/x.mkv", ItemId: "abc123" })).toEqual({
      filePath: "/media/x.mkv",
    });
    // Still gated on completion.
    expect(parseJellyfinEmbyPayload({ NotificationType: "PlaybackStop", PlayedToCompletion: "False", ItemId: "abc123" })).toBeNull();
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

  it("resolves an item-id-only signal through the media server, then matches the resolved path", async () => {
    const id = await insertMovie("Jellyfin Watched Movie", "/media/movies/Jellyfin Watched Movie/movie.mkv");
    resolveJellyfinLikeFilePath.mockResolvedValueOnce("/jf/movies/Jellyfin Watched Movie/movie.mkv");
    const signal = { filePath: "", itemId: "abc123" };

    const result = await recordWatchEvent(signal);

    expect(resolveJellyfinLikeFilePath).toHaveBeenCalledWith("abc123");
    expect(result).toEqual({ mediaItemId: id, episodeId: null, subItemId: null });
    expect(signal.filePath).toBe("/jf/movies/Jellyfin Watched Movie/movie.mkv");
  });

  it("records nothing when an item id can't be resolved, or the lookup fails", async () => {
    const before = (await db.prepare("SELECT COUNT(*) AS c FROM watch_events").get()) as { c: number };

    resolveJellyfinLikeFilePath.mockResolvedValueOnce(null);
    expect(await recordWatchEvent({ filePath: "", itemId: "unknown-id" })).toBeNull();
    resolveJellyfinLikeFilePath.mockRejectedValueOnce(new Error("connection refused"));
    expect(await recordWatchEvent({ filePath: "", itemId: "abc123" })).toBeNull();
    expect(await recordWatchEvent({ filePath: "" })).toBeNull();

    const after = (await db.prepare("SELECT COUNT(*) AS c FROM watch_events").get()) as { c: number };
    expect(Number(after.c)).toBe(Number(before.c));
  });

  it("returns null and records nothing when no library file matches", async () => {
    const before = (await db.prepare("SELECT COUNT(*) AS c FROM watch_events").get()) as { c: number };

    const result = await recordWatchEvent({ filePath: "/completely/unmatched/path.mkv" });

    expect(result).toBeNull();
    const after = (await db.prepare("SELECT COUNT(*) AS c FROM watch_events").get()) as { c: number };
    expect(Number(after.c)).toBe(Number(before.c));
  });
});

describe("POST /api/webhooks/media-server diagnostics", () => {
  const token = "webhook-diagnostics-token";

  async function postJellyfinStop(extra: Record<string, unknown>): Promise<string[]> {
    setSetting("mediaServerWebhookToken", token);
    const { log } = await import("../src/services/logger.js");
    const info = vi.spyOn(log, "info");
    try {
      const res = await request(app)
        .post(`/api/webhooks/media-server?token=${token}`)
        .send({ NotificationType: "PlaybackStop", PlayedToCompletion: true, ...extra });
      expect(res.status).toBe(200);
      return info.mock.calls.map((args) => args.map(String).join(" "));
    } finally {
      info.mockRestore();
    }
  }

  it("logs only the resolve failure, pointing at the media server settings, when an item id doesn't resolve", async () => {
    resolveJellyfinLikeFilePath.mockResolvedValueOnce(null);

    const lines = await postJellyfinStop({ ItemId: "unresolvable-item" });

    const webhookLines = lines.filter((l) => l.includes("[webhook]"));
    expect(webhookLines).toHaveLength(1);
    expect(webhookLines[0]).toContain("media server item unresolvable-item didn't resolve to a file path");
    expect(webhookLines[0]).toContain("Jellyfin/Emby server URL and token");
    expect(webhookLines[0]).toContain("Media Server Sync");
    expect(lines.some((l) => l.includes("didn't match any library file"))).toBe(false);
  });

  it("names the resolved path and the item id when a resolved item matches no library file", async () => {
    resolveJellyfinLikeFilePath.mockResolvedValueOnce("/jf/movies/Nowhere/nowhere.mkv");

    const lines = await postJellyfinStop({ ItemId: "resolved-item" });

    expect(lines).toContain(
      `[webhook] watch event for "/jf/movies/Nowhere/nowhere.mkv" (media server item resolved-item) didn't match any library file`
    );
  });

  it("names the payload's own path when it matches no library file", async () => {
    const lines = await postJellyfinStop({ Path: "/media/movies/Unknown/unknown.mkv" });

    expect(lines).toContain(`[webhook] watch event for "/media/movies/Unknown/unknown.mkv" didn't match any library file`);
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

  it("stores the watch at the media server's play time, not the sync time", async () => {
    const id = await insertMovie("Play Time Movie", "/media/movies/Play Time Movie/movie.mkv");
    fetchWatchedFiles.mockResolvedValueOnce([
      { path: "/mnt/aonarr/movies/Play Time Movie/movie.mkv", lastPlayedAt: new Date("2023-03-04T05:06:07.890Z") },
    ]);

    await syncWatchStatusFromMediaServer();

    const rows = (await db.prepare("SELECT watched_at FROM watch_events WHERE media_item_id = ?").all(id)) as { watched_at: string }[];
    expect(rows.map((r) => r.watched_at)).toEqual(["2023-03-04 05:06:07"]);
  });

  it("doesn't re-insert an already-recorded watch while an older unmatched file keeps the cursor pinned", async () => {
    const { getSetting } = await import("../src/services/settingsStore.js");
    const movieId = await insertMovie("Pinned Cursor Movie", "/media/movies/Pinned Cursor Movie/movie.mkv");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Pinned Show', 'pinned show', 1, 1, 'unknown')`).run())
        .lastInsertRowid
    );
    const episodeId = Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, 1, 1, 1, ?)")
          .run(showId, "/media/tv/Pinned Show/Season 01/ep1.mkv")
      ).lastInsertRowid
    );
    const unmatchedAt = new Date("2025-01-01T00:00:00Z");
    const batch = () => [
      { path: "/home-videos/untracked/clip.mkv", lastPlayedAt: unmatchedAt },
      { path: "/mnt/aonarr/movies/Pinned Cursor Movie/movie.mkv", lastPlayedAt: new Date("2025-02-01T00:00:00Z") },
      { path: "/mnt/aonarr/tv/Pinned Show/Season 01/ep1.mkv", lastPlayedAt: new Date("2025-03-01T00:00:00Z") },
    ];

    fetchWatchedFiles.mockResolvedValueOnce(batch());
    expect(await syncWatchStatusFromMediaServer()).toEqual({ recorded: 2 });
    expect(new Date(getSetting("watchStatusSyncLastRunAt")!).getTime()).toBe(unmatchedAt.getTime() - 1);

    fetchWatchedFiles.mockResolvedValueOnce(batch());
    expect(await syncWatchStatusFromMediaServer()).toEqual({ recorded: 0 });

    const movieRows = (await db.prepare("SELECT COUNT(*) AS c FROM watch_events WHERE media_item_id = ?").get(movieId)) as { c: number };
    const episodeRows = (await db.prepare("SELECT COUNT(*) AS c FROM watch_events WHERE episode_id = ?").get(episodeId)) as { c: number };
    expect(Number(movieRows.c)).toBe(1);
    expect(Number(episodeRows.c)).toBe(1);
  });

  it("records a genuine re-watch of an already-recorded file as a new event", async () => {
    const id = await insertMovie("Rewatched Movie", "/media/movies/Rewatched Movie/movie.mkv");
    fetchWatchedFiles.mockResolvedValueOnce([{ path: "/mnt/aonarr/movies/Rewatched Movie/movie.mkv", lastPlayedAt: new Date("2025-04-01T00:00:00Z") }]);
    await syncWatchStatusFromMediaServer();
    fetchWatchedFiles.mockResolvedValueOnce([{ path: "/mnt/aonarr/movies/Rewatched Movie/movie.mkv", lastPlayedAt: new Date("2025-05-01T00:00:00Z") }]);

    expect(await syncWatchStatusFromMediaServer()).toEqual({ recorded: 1 });
    const rows = (await db.prepare("SELECT COUNT(*) AS c FROM watch_events WHERE media_item_id = ?").get(id)) as { c: number };
    expect(Number(rows.c)).toBe(2);
  });

  it("doesn't reprocess a file whose lastPlayedAt is at or before the stored cursor", async () => {
    setSetting("watchStatusSyncLastRunAt", new Date("2024-09-01T00:00:00Z").toISOString());
    fetchWatchedFiles.mockResolvedValueOnce([{ path: "/media/old/already-seen.mkv", lastPlayedAt: new Date("2024-08-01T00:00:00Z") }]);

    expect(await syncWatchStatusFromMediaServer()).toEqual({ recorded: 0 });
  });
});
