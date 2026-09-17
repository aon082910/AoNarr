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
