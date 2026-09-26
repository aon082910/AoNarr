import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function insertEpisode(showId: number, season: number, episode: number, hasFile = 0): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?, ?, ?, ?, 1, ?)`)
    .run(showId, season, episode, `S${season}E${episode}`, hasFile);
  return Number(result.lastInsertRowid);
}

describe("POST /api/media/:id/split", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("moves the split episodes' queue, watch and playlist rows to the new series with them", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'The Office', 'the office', 1, 1, 'continuing')`)
          .run()
      ).lastInsertRowid
    );
    const keptEpisode = await insertEpisode(showId, 1, 1, 1);
    const movedEpisode = await insertEpisode(showId, 2, 3);
    const downloading = Number(
      (
        await db
          .prepare(`INSERT INTO queue (media_item_id, episode_id, title, status) VALUES (?, ?, 'The.Office.UK.S02E03.720p', 'downloading')`)
          .run(showId, movedEpisode)
      ).lastInsertRowid
    );
    const keptQueueRow = Number(
      (await db.prepare(`INSERT INTO queue (media_item_id, episode_id, title, status) VALUES (?, ?, 'The.Office.S01E01.1080p', 'queued')`).run(showId, keptEpisode))
        .lastInsertRowid
    );
    const seasonPack = Number(
      (
        await db
          .prepare(`INSERT INTO queue (media_item_id, episode_id, season_number, title, status) VALUES (?, NULL, 2, 'The.Office.S02.1080p', 'queued')`)
          .run(showId)
      ).lastInsertRowid
    );
    await db.prepare(`INSERT INTO watch_events (media_item_id, episode_id) VALUES (?, ?)`).run(showId, movedEpisode);
    const playlistId = Number((await db.prepare(`INSERT INTO iptv_playlists (name) VALUES ('Split Test Channel')`).run()).lastInsertRowid);
    await db
      .prepare(`INSERT INTO iptv_playlist_items (playlist_id, position, title, media_item_id, episode_id) VALUES (?, 0, 'S02E03', ?, ?)`)
      .run(playlistId, showId, movedEpisode);

    const res = await request(app)
      .post(`/api/media/${showId}/split`)
      .set("X-Api-Key", apiKey)
      .send({ episodeIds: [movedEpisode], title: "The Office (UK)" });

    expect(res.status).toBe(201);
    const newId = res.body.id;
    expect(newId).not.toBe(showId);
    const queueOwner = async (id: number) => ((await db.prepare("SELECT media_item_id FROM queue WHERE id = ?").get(id)) as any).media_item_id;
    expect(await queueOwner(downloading)).toBe(newId);
    expect(await queueOwner(keptQueueRow)).toBe(showId);
    // A season pack isn't tied to the moved episode, so it stays with the series it was grabbed for.
    expect(await queueOwner(seasonPack)).toBe(showId);
    const watch = (await db.prepare("SELECT media_item_id FROM watch_events WHERE episode_id = ?").get(movedEpisode)) as any;
    expect(watch.media_item_id).toBe(newId);
    const playlistItem = (await db.prepare("SELECT media_item_id FROM iptv_playlist_items WHERE episode_id = ?").get(movedEpisode)) as any;
    expect(playlistItem.media_item_id).toBe(newId);

    const owners = (await db.prepare("SELECT id, media_item_id FROM episodes WHERE id IN (?, ?)").all(keptEpisode, movedEpisode)) as any[];
    expect(Object.fromEntries(owners.map((e) => [e.id, e.media_item_id]))).toEqual({ [keptEpisode]: showId, [movedEpisode]: newId });
    const hasFile = (await db.prepare("SELECT id, has_file FROM media_items WHERE id IN (?, ?)").all(showId, newId)) as any[];
    expect(Object.fromEntries(hasFile.map((m) => [m.id, Number(m.has_file)]))).toEqual({ [showId]: 1, [newId]: 0 });
  });

  it("rejects episodes that belong to another series without creating anything", async () => {
    const insertShow = async (title: string) =>
      Number(
        (
          await db
            .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', ?, ?, 1, 0, 'continuing')`)
            .run(title, title.toLowerCase())
        ).lastInsertRowid
      );
    const showId = await insertShow("Split Owner Show");
    const otherShowId = await insertShow("Split Other Show");
    const foreignEpisode = await insertEpisode(otherShowId, 1, 1);
    const before = Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c);

    const res = await request(app)
      .post(`/api/media/${showId}/split`)
      .set("X-Api-Key", apiKey)
      .send({ episodeIds: [foreignEpisode], title: "Should Not Exist" });

    expect(res.status).toBe(400);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c)).toBe(before);
  });
});
