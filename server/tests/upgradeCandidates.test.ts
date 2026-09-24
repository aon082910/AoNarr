import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

async function insertProfile(name: string, cutoff: string): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, '[]', ?)").run(name, cutoff)).lastInsertRowid
  );
}

describe("findUpgradeCandidates", () => {
  it("flags a movie below its profile's cutoff", async () => {
    const { findUpgradeCandidates } = await import("../src/services/upgradeCandidates.js");
    const profileId = await insertProfile("Below Cutoff Profile", "Remux-2160p");
    const movieId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality, quality_profile_id, status)
             VALUES ('movie', 'Needs Upgrade', 'x', 1, 1, 'WEBDL-1080p', ?, 'unknown')`
          )
          .run(profileId)
      ).lastInsertRowid
    );

    const candidates = await findUpgradeCandidates();
    const found = candidates.find((c) => c.mediaItemId === movieId);
    expect(found).toBeDefined();
    expect(found!.currentQuality).toBe("WEBDL-1080p");
    expect(found!.cutoff).toBe("Remux-2160p");
  });

  it("does not flag a movie already at or above its profile's cutoff", async () => {
    const { findUpgradeCandidates } = await import("../src/services/upgradeCandidates.js");
    const profileId = await insertProfile("At Cutoff Profile", "WEBDL-1080p");
    const movieId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality, quality_profile_id, status)
             VALUES ('movie', 'Already Good', 'x', 1, 1, 'Remux-2160p', ?, 'unknown')`
          )
          .run(profileId)
      ).lastInsertRowid
    );

    const candidates = await findUpgradeCandidates();
    expect(candidates.find((c) => c.mediaItemId === movieId)).toBeUndefined();
  });

  it("flags an episode below cutoff and labels it with season/episode", async () => {
    const { findUpgradeCandidates } = await import("../src/services/upgradeCandidates.js");
    const profileId = await insertProfile("Series Profile", "Bluray-1080p");
    const showId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality_profile_id, status)
             VALUES ('series', 'A Show', 'a show', 1, 1, ?, 'unknown')`
          )
          .run(profileId)
      ).lastInsertRowid
    );
    const episodeId = Number(
      (
        await db
          .prepare(
            "INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, quality) VALUES (?, 2, 7, 1, 1, 'SD')"
          )
          .run(showId)
      ).lastInsertRowid
    );

    const candidates = await findUpgradeCandidates();
    const found = candidates.find((c) => c.episodeId === episodeId);
    expect(found).toBeDefined();
    expect(found!.target).toBe("A Show S02E07");
  });

  it("flags a sub-item (album/book) below cutoff and labels it with the parent + child title", async () => {
    const { findUpgradeCandidates } = await import("../src/services/upgradeCandidates.js");
    const profileId = await insertProfile("Music Profile", "Bluray-1080p");
    const artistId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality_profile_id, status)
             VALUES ('artist', 'An Artist', 'an artist', 1, 1, ?, 'unknown')`
          )
          .run(profileId)
      ).lastInsertRowid
    );
    const subItemId = Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, quality) VALUES (?, 'An Album', 1, 1, 'SD')")
          .run(artistId)
      ).lastInsertRowid
    );

    const candidates = await findUpgradeCandidates();
    const found = candidates.find((c) => c.subItemId === subItemId);
    expect(found).toBeDefined();
    expect(found!.target).toBe("An Artist - An Album");
  });

  it("skips an item with no quality profile assigned rather than throwing", async () => {
    const { findUpgradeCandidates } = await import("../src/services/upgradeCandidates.js");
    const movieId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality, status)
             VALUES ('movie', 'No Profile', 'x', 1, 1, 'SD', 'unknown')`
          )
          .run()
      ).lastInsertRowid
    );

    await expect(findUpgradeCandidates()).resolves.not.toThrow();
    const candidates = await findUpgradeCandidates();
    expect(candidates.find((c) => c.mediaItemId === movieId)).toBeUndefined();
  });
});

describe("findUpgradeCandidates — unranked qualities and unmonitored rows", () => {
  async function insertParent(type: "movie" | "series" | "artist", title: string, profileId: number, monitored: number, quality: string | null = null): Promise<number> {
    return Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality, quality_profile_id, status)
             VALUES (?, ?, ?, ?, 1, ?, ?, 'unknown')`
          )
          .run(type, title, title.toLowerCase(), monitored, quality, profileId)
      ).lastInsertRowid
    );
  }

  async function insertEpisode(showId: number, episodeNumber: number, monitored: number, quality: string): Promise<number> {
    return Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, quality) VALUES (?, 1, ?, ?, 1, ?)")
          .run(showId, episodeNumber, monitored, quality)
      ).lastInsertRowid
    );
  }

  async function insertSubItem(artistId: number, title: string, monitored: number, quality: string): Promise<number> {
    return Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, quality) VALUES (?, ?, ?, 1, ?)")
          .run(artistId, title, monitored, quality)
      ).lastInsertRowid
    );
  }

  it("never flags a file whose quality isn't ranked here (a deleted tier, '' or 'Unknown') — only a ranked one below cutoff", async () => {
    const { findUpgradeCandidates } = await import("../src/services/upgradeCandidates.js");
    const profileId = await insertProfile("Unranked Qualities Profile", "Remux-2160p");
    const deletedTier = await insertParent("movie", "Deleted Tier Movie", profileId, 1, "Remux-1080p-Deleted");
    const emptyQuality = await insertParent("movie", "Empty Quality Movie", profileId, 1, "");
    const unknownQuality = await insertParent("movie", "Unknown Quality Movie", profileId, 1, "Unknown");
    const showId = await insertParent("series", "Unranked Show", profileId, 1);
    const unknownEpisode = await insertEpisode(showId, 1, 1, "Unknown");
    const artistId = await insertParent("artist", "Unranked Artist", profileId, 1);
    const emptySubItem = await insertSubItem(artistId, "Unranked Album", 1, "");
    const rankedBelow = await insertParent("movie", "Ranked Below Cutoff Movie", profileId, 1, "SD");

    const candidates = await findUpgradeCandidates();

    for (const id of [deletedTier, emptyQuality, unknownQuality]) expect(candidates.find((c) => c.mediaItemId === id)).toBeUndefined();
    expect(candidates.find((c) => c.episodeId === unknownEpisode)).toBeUndefined();
    expect(candidates.find((c) => c.subItemId === emptySubItem)).toBeUndefined();
    expect(candidates.find((c) => c.mediaItemId === rankedBelow)).toBeDefined();
  });

  it("skips an unmonitored movie that's below cutoff", async () => {
    const { findUpgradeCandidates } = await import("../src/services/upgradeCandidates.js");
    const profileId = await insertProfile("Unmonitored Movie Profile", "Remux-2160p");
    const unmonitored = await insertParent("movie", "Unmonitored Low Movie", profileId, 0, "SD");
    const monitored = await insertParent("movie", "Monitored Low Movie", profileId, 1, "SD");

    const candidates = await findUpgradeCandidates();

    expect(candidates.find((c) => c.mediaItemId === unmonitored)).toBeUndefined();
    expect(candidates.find((c) => c.mediaItemId === monitored)).toBeDefined();
  });

  it("counts an episode only when both it and its series are monitored", async () => {
    const { findUpgradeCandidates } = await import("../src/services/upgradeCandidates.js");
    const profileId = await insertProfile("Episode Monitoring Profile", "Bluray-1080p");
    const monitoredShow = await insertParent("series", "Monitored Show", profileId, 1);
    const bothMonitored = await insertEpisode(monitoredShow, 1, 1, "SD");
    const episodeUnmonitored = await insertEpisode(monitoredShow, 2, 0, "SD");
    const unmonitoredShow = await insertParent("series", "Unmonitored Show", profileId, 0);
    const parentUnmonitored = await insertEpisode(unmonitoredShow, 1, 1, "SD");

    const candidates = await findUpgradeCandidates();

    expect(candidates.find((c) => c.episodeId === bothMonitored)).toBeDefined();
    expect(candidates.find((c) => c.episodeId === episodeUnmonitored)).toBeUndefined();
    expect(candidates.find((c) => c.episodeId === parentUnmonitored)).toBeUndefined();
  });

  it("counts a sub-item only when both it and its parent are monitored", async () => {
    const { findUpgradeCandidates } = await import("../src/services/upgradeCandidates.js");
    const profileId = await insertProfile("Sub-Item Monitoring Profile", "Bluray-1080p");
    const monitoredArtist = await insertParent("artist", "Monitored Artist", profileId, 1);
    const bothMonitored = await insertSubItem(monitoredArtist, "Monitored Album", 1, "SD");
    const subItemUnmonitored = await insertSubItem(monitoredArtist, "Unmonitored Album", 0, "SD");
    const unmonitoredArtist = await insertParent("artist", "Unmonitored Artist", profileId, 0);
    const parentUnmonitored = await insertSubItem(unmonitoredArtist, "Orphaned Album", 1, "SD");

    const candidates = await findUpgradeCandidates();

    expect(candidates.find((c) => c.subItemId === bothMonitored)).toBeDefined();
    expect(candidates.find((c) => c.subItemId === subItemUnmonitored)).toBeUndefined();
    expect(candidates.find((c) => c.subItemId === parentUnmonitored)).toBeUndefined();
  });
});
