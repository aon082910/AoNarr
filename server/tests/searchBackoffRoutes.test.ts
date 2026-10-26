import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

beforeEach(async () => {
  for (const t of ["queue", "episodes", "media_items", "delay_profiles", "release_profiles", "custom_formats", "indexers"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
});

interface Seeded {
  showA: number;
  showB: number;
  episodeA: number;
  episodeA2: number;
  episodeB: number;
}

/** Two shows, each with episodes and a season, every one of them backed off. */
async function seedBackedOffShows(): Promise<Seeded> {
  const show = async (title: string) =>
    Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, auto_search_misses) VALUES ('series', ?, ?, 1, 0, 'missing', 6)")
          .run(title, title.toLowerCase())
      ).lastInsertRowid
    );
  const episode = async (showId: number, n: number) =>
    Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, auto_search_misses) VALUES (?, 1, ?, 1, 0, 6)")
          .run(showId, n)
      ).lastInsertRowid
    );
  const showA = await show("Show A");
  const showB = await show("Show B");
  const episodeA = await episode(showA, 1);
  const episodeA2 = await episode(showA, 2);
  const episodeB = await episode(showB, 1);
  for (const id of [showA, showB]) {
    await db.prepare("INSERT INTO season_searches (media_item_id, season_number, misses, last_searched_at) VALUES (?, 1, 4, '2026-10-24 12:00:00')").run(id);
  }
  return { showA, showB, episodeA, episodeA2, episodeB };
}

async function state(s: Seeded) {
  const misses = async (table: string, id: number) => Number(((await db.prepare(`SELECT auto_search_misses FROM ${table} WHERE id = ?`).get(id)) as any).auto_search_misses);
  const seasons = async (id: number) => ((await db.prepare("SELECT 1 AS x FROM season_searches WHERE media_item_id = ?").all(id)) as any[]).length;
  return {
    showA: await misses("media_items", s.showA),
    showB: await misses("media_items", s.showB),
    episodeA: await misses("episodes", s.episodeA),
    episodeA2: await misses("episodes", s.episodeA2),
    episodeB: await misses("episodes", s.episodeB),
    seasonsA: await seasons(s.showA),
    seasonsB: await seasons(s.showB),
  };
}

const BACKED_OFF = { showA: 6, showB: 6, episodeA: 6, episodeA2: 6, episodeB: 6, seasonsA: 1, seasonsB: 1 };
const NOTHING_BACKED_OFF = { showA: 0, showB: 0, episodeA: 0, episodeA2: 0, episodeB: 0, seasonsA: 0, seasonsB: 0 };

describe("an edit that can change what a search finds starts the search backoff over", () => {
  it("only for the show and its episodes and seasons, when the show is edited", async () => {
    const s = await seedBackedOffShows();

    const res = await request(app).patch(`/api/media/${s.showA}`).set("X-Api-Key", apiKey).send({ monitored: true });

    expect(res.status).toBe(200);
    expect(await state(s)).toEqual({ ...BACKED_OFF, showA: 0, episodeA: 0, episodeA2: 0, seasonsA: 0 });
  });

  it("leaves it alone when the edit changes nothing", async () => {
    const s = await seedBackedOffShows();

    await request(app).patch(`/api/media/${s.showA}`).set("X-Api-Key", apiKey).send({});

    expect(await state(s)).toEqual(BACKED_OFF);
  });

  it("for one episode when it is edited", async () => {
    const s = await seedBackedOffShows();

    const res = await request(app).patch(`/api/media/${s.showA}/episodes/${s.episodeA}`).set("X-Api-Key", apiKey).send({ monitored: true });

    expect(res.status).toBe(200);
    expect(await state(s)).toEqual({ ...BACKED_OFF, episodeA: 0 });
  });

  it("for a show when one of its seasons is monitored or unmonitored", async () => {
    const s = await seedBackedOffShows();

    const res = await request(app).patch(`/api/media/${s.showA}/season/1/monitor`).set("X-Api-Key", apiKey).send({ monitored: true });

    expect(res.status).toBe(200);
    expect(await state(s)).toEqual({ ...BACKED_OFF, showA: 0, episodeA: 0, episodeA2: 0, seasonsA: 0 });
  });

  describe("for every show, when what can be grabbed changes", () => {
    const profileId = async () =>
      Number(
        (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, '[]', '')").run(`Profile ${Math.random()}`)).lastInsertRowid
      );

    it("edits a quality profile", async () => {
      const s = await seedBackedOffShows();
      const res = await request(app).patch(`/api/quality-profiles/${await profileId()}`).set("X-Api-Key", apiKey).send({ cutoff: "WEBDL-1080p" });
      expect(res.status).toBe(200);
      expect(await state(s)).toEqual(NOTHING_BACKED_OFF);
    });

    it("edits a delay profile", async () => {
      const created = await request(app).post("/api/delay-profiles").set("X-Api-Key", apiKey).send({ torrentDelayMinutes: 60 });
      expect(created.status).toBe(201);
      const s = await seedBackedOffShows();
      const res = await request(app).patch(`/api/delay-profiles/${created.body.id}`).set("X-Api-Key", apiKey).send({ torrentDelayMinutes: 0 });
      expect(res.status).toBe(200);
      expect(await state(s)).toEqual(NOTHING_BACKED_OFF);
    });

    it("edits a release profile", async () => {
      const created = await request(app).post("/api/release-profiles").set("X-Api-Key", apiKey).send({ name: "No cams", mustNotContain: ["cam"] });
      expect(created.status).toBe(201);
      const s = await seedBackedOffShows();
      const res = await request(app).patch(`/api/release-profiles/${created.body.id}`).set("X-Api-Key", apiKey).send({ mustNotContain: [] });
      expect(res.status).toBe(200);
      expect(await state(s)).toEqual(NOTHING_BACKED_OFF);
    });

    it("edits a custom format, or sets its score in a profile", async () => {
      const created = await request(app)
        .post("/api/custom-formats")
        .set("X-Api-Key", apiKey)
        .send({ name: "x265", conditionGroups: [{ type: "title", patterns: ["x265"], negate: false }] });
      expect(created.status).toBe(201);
      const s = await seedBackedOffShows();
      const patched = await request(app).patch(`/api/custom-formats/${created.body.id}`).set("X-Api-Key", apiKey).send({ name: "x265 and x264" });
      expect(patched.status).toBe(200);
      expect(await state(s)).toEqual(NOTHING_BACKED_OFF);

      const again = await seedBackedOffShows();
      const scored = await request(app).put(`/api/custom-formats/scores/${await profileId()}/${created.body.id}`).set("X-Api-Key", apiKey).send({ score: 50 });
      expect(scored.status).toBe(200);
      expect(await state(again)).toEqual(NOTHING_BACKED_OFF);
    });

    it("adds or edits an indexer", async () => {
      const s = await seedBackedOffShows();
      const created = await request(app)
        .post("/api/indexers")
        .set("X-Api-Key", apiKey)
        .send({ name: "New Indexer", protocol: "torznab", url: "https://idx.example.com", mediaTypes: "movie,series" });
      expect(created.status).toBe(201);
      expect(await state(s)).toEqual(NOTHING_BACKED_OFF);

      const again = await seedBackedOffShows();
      const patched = await request(app).patch(`/api/indexers/${created.body.id}`).set("X-Api-Key", apiKey).send({ url: "https://idx2.example.com" });
      expect(patched.status).toBe(200);
      expect(await state(again)).toEqual(NOTHING_BACKED_OFF);
    });
  });
});

describe("more edits that can change what a search finds start the search backoff over (after the Round 10 review)", () => {
  it("for the shows of a bulk monitor or a bulk edit, and no others", async () => {
    const s = await seedBackedOffShows();
    const monitored = await request(app).post("/api/media/bulk/monitor").set("X-Api-Key", apiKey).send({ mediaItemIds: [s.showA], monitored: true });
    expect(monitored.status).toBe(200);
    expect(await state(s)).toEqual({ ...BACKED_OFF, showA: 0, episodeA: 0, episodeA2: 0, seasonsA: 0 });

    const again = await seedBackedOffShows();
    const profile = Number((await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, '[]', '')").run(`Profile ${Math.random()}`)).lastInsertRowid);
    const edited = await request(app).post("/api/media/bulk/edit").set("X-Api-Key", apiKey).send({ mediaItemIds: [again.showB], qualityProfileId: profile });
    expect(edited.status).toBe(200);
    expect(await state(again)).toEqual({ ...BACKED_OFF, showB: 0, episodeB: 0, seasonsB: 0 });
  });

  it("for a show when a name releases use for it is added or taken away", async () => {
    const s = await seedBackedOffShows();
    const added = await request(app).post(`/api/media/${s.showA}/aliases`).set("X-Api-Key", apiKey).send({ title: "Show A Other Name" });
    expect(added.status).toBe(201);
    expect(await state(s)).toEqual({ ...BACKED_OFF, showA: 0, episodeA: 0, episodeA2: 0, seasonsA: 0 });

    // Backed off again, the same show: taking the name away starts the search over once more.
    await db.prepare("UPDATE media_items SET auto_search_misses = 6 WHERE id = ?").run(s.showA);
    await db.prepare("UPDATE episodes SET auto_search_misses = 6 WHERE media_item_id = ?").run(s.showA);
    await db.prepare("INSERT INTO season_searches (media_item_id, season_number, misses, last_searched_at) VALUES (?, 1, 4, '2026-10-24 12:00:00')").run(s.showA);
    const alias = (added.body as any[]).find((a) => a.title === "Show A Other Name");
    const removed = await request(app).delete(`/api/media/${s.showA}/aliases/${alias.id}`).set("X-Api-Key", apiKey);
    expect(removed.status).toBe(204);
    expect(await state(s)).toEqual({ ...BACKED_OFF, showA: 0, episodeA: 0, episodeA2: 0, seasonsA: 0 });
  });

  describe("for every show, when something that held a release back is taken away", () => {
    it("deletes a release profile, a delay profile or a custom format", async () => {
      const release = await request(app).post("/api/release-profiles").set("X-Api-Key", apiKey).send({ name: "No cams", mustNotContain: ["cam"] });
      const s = await seedBackedOffShows();
      expect((await request(app).delete(`/api/release-profiles/${release.body.id}`).set("X-Api-Key", apiKey)).status).toBe(204);
      expect(await state(s)).toEqual(NOTHING_BACKED_OFF);

      const delay = await request(app).post("/api/delay-profiles").set("X-Api-Key", apiKey).send({ torrentDelayMinutes: 60 });
      const again = await seedBackedOffShows();
      expect((await request(app).delete(`/api/delay-profiles/${delay.body.id}`).set("X-Api-Key", apiKey)).status).toBe(204);
      expect(await state(again)).toEqual(NOTHING_BACKED_OFF);

      const format = await request(app)
        .post("/api/custom-formats")
        .set("X-Api-Key", apiKey)
        .send({ name: "x265", conditionGroups: [{ type: "title", patterns: ["x265"], negate: false }] });
      const third = await seedBackedOffShows();
      expect((await request(app).delete(`/api/custom-formats/${format.body.id}`).set("X-Api-Key", apiKey)).status).toBe(204);
      expect(await state(third)).toEqual(NOTHING_BACKED_OFF);
    });

    it("adds a download client", async () => {
      await db.prepare("DELETE FROM download_clients").run();
      const s = await seedBackedOffShows();
      const created = await request(app)
        .post("/api/download-clients")
        .set("X-Api-Key", apiKey)
        .send({ name: "Usenet", type: "sabnzbd", host: "sab.example.com", port: 8080 });
      expect(created.status).toBe(201);
      expect(await state(s)).toEqual(NOTHING_BACKED_OFF);
    });
  });
});
