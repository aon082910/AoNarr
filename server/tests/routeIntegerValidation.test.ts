import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

describe("PATCH /api/qualities/:id size limits", () => {
  it("stores a fractional size rounded, and clears one with null", async () => {
    const id = Number((await db.prepare("INSERT INTO qualities (name, rank) VALUES ('Int-Check-Quality', 900)").run()).lastInsertRowid);

    const res = await request(app).patch(`/api/qualities/${id}`).set("X-Api-Key", apiKey).send({ minSizeMb: 12.5, maxSizeMb: "40", preferredSizeMb: 20.4 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ minSizeMb: 13, maxSizeMb: 40, preferredSizeMb: 20 });
    const cleared = await request(app).patch(`/api/qualities/${id}`).set("X-Api-Key", apiKey).send({ maxSizeMb: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.maxSizeMb).toBeNull();
  });

  it("rejects a non-numeric or negative size with a 400, changing nothing", async () => {
    const id = Number(
      (await db.prepare("INSERT INTO qualities (name, rank, min_size_mb) VALUES ('Int-Check-Quality-2', 901, 5)").run()).lastInsertRowid
    );

    for (const body of [{ minSizeMb: "abc" }, { maxSizeMb: -1 }, { preferredSizeMb: "" }, { minSizeMb: 7, maxSizeMb: "abc" }]) {
      const res = await request(app).patch(`/api/qualities/${id}`).set("X-Api-Key", apiKey).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toMatch(/must be a number of 0 or more/);
    }
    expect(Number(((await db.prepare("SELECT min_size_mb FROM qualities WHERE id = ?").get(id)) as any).min_size_mb)).toBe(5);
  });
});

describe("/api/delay-profiles delays", () => {
  it("stores fractional delays rounded on create and update", async () => {
    const tagId = Number((await db.prepare("INSERT INTO tags (name) VALUES ('int-check-delay')").run()).lastInsertRowid);

    const created = await request(app)
      .post("/api/delay-profiles")
      .set("X-Api-Key", apiKey)
      .send({ tagId, usenetDelayMinutes: 12.5, torrentDelayMinutes: "30" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ usenetDelayMinutes: 13, torrentDelayMinutes: 30 });

    const updated = await request(app)
      .patch(`/api/delay-profiles/${created.body.id}`)
      .set("X-Api-Key", apiKey)
      .send({ torrentDelayMinutes: 7.4, orderIndex: 2.6 });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ usenetDelayMinutes: 13, torrentDelayMinutes: 7, orderIndex: 3 });
  });

  it("rejects a non-numeric, negative or null delay with a 400", async () => {
    const tagId = Number((await db.prepare("INSERT INTO tags (name) VALUES ('int-check-delay-2')").run()).lastInsertRowid);
    const bad = await request(app).post("/api/delay-profiles").set("X-Api-Key", apiKey).send({ tagId, usenetDelayMinutes: "abc" });
    expect(bad.status).toBe(400);
    expect(await db.prepare("SELECT id FROM delay_profiles WHERE tag_id = ?").get(tagId)).toBeUndefined();

    const created = await request(app).post("/api/delay-profiles").set("X-Api-Key", apiKey).send({ tagId });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ usenetDelayMinutes: 0, torrentDelayMinutes: 0 });
    for (const body of [{ usenetDelayMinutes: "abc" }, { torrentDelayMinutes: -5 }, { orderIndex: null }]) {
      const res = await request(app).patch(`/api/delay-profiles/${created.body.id}`).set("X-Api-Key", apiKey).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("/api/iptv durations", () => {
  it("stores a fractional item duration and playlist interval rounded", async () => {
    const playlist = await request(app).post("/api/iptv/playlists").set("X-Api-Key", apiKey).send({ name: "Int Check", insertAfterMinutes: 12.5 });
    expect(playlist.status).toBe(201);
    expect(playlist.body.insertAfterMinutes).toBe(13);

    const patched = await request(app).patch(`/api/iptv/playlists/${playlist.body.id}`).set("X-Api-Key", apiKey).send({ insertAfterMinutes: "45" });
    expect(patched.status).toBe(200);
    expect(patched.body.insertAfterMinutes).toBe(45);

    const item = await request(app)
      .post(`/api/iptv/playlists/${playlist.body.id}/items`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Clip", externalUrl: "http://example.com/clip.mp4", durationSeconds: 90.6 });
    expect(item.status).toBe(201);
    expect(item.body.durationSeconds).toBe(91);

    const noDuration = await request(app)
      .post(`/api/iptv/playlists/${playlist.body.id}/items`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Clip 2", externalUrl: "http://example.com/clip2.mp4", durationSeconds: null });
    expect(noDuration.status).toBe(201);
    expect(noDuration.body.durationSeconds).toBeNull();
  });

  it("rejects a non-numeric or negative duration/interval with a 400", async () => {
    const playlist = await request(app).post("/api/iptv/playlists").set("X-Api-Key", apiKey).send({ name: "Int Check 2" });
    expect(playlist.status).toBe(201);

    const badItem = await request(app)
      .post(`/api/iptv/playlists/${playlist.body.id}/items`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Clip", externalUrl: "http://example.com/clip.mp4", durationSeconds: "abc" });
    expect(badItem.status).toBe(400);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS n FROM iptv_playlist_items WHERE playlist_id = ?").get(playlist.body.id)) as any).n)).toBe(0);

    expect((await request(app).post("/api/iptv/playlists").set("X-Api-Key", apiKey).send({ name: "Bad", insertAfterMinutes: "abc" })).status).toBe(400);
    expect((await request(app).patch(`/api/iptv/playlists/${playlist.body.id}`).set("X-Api-Key", apiKey).send({ insertAfterMinutes: -1 })).status).toBe(400);
  });
});

describe("/api/iptv enabled flags", () => {
  it("stores a boolean enabled as 0/1 on playlists and filler clips", async () => {
    const playlist = await request(app).post("/api/iptv/playlists").set("X-Api-Key", apiKey).send({ name: "Flag Check", enabled: true });
    expect(playlist.status).toBe(201);
    expect(Number(playlist.body.enabled)).toBe(1);
    const off = await request(app).patch(`/api/iptv/playlists/${playlist.body.id}`).set("X-Api-Key", apiKey).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(Number(off.body.enabled)).toBe(0);
    const zero = await request(app).post("/api/iptv/playlists").set("X-Api-Key", apiKey).send({ name: "Flag Check Off", enabled: 0 });
    expect(Number(zero.body.enabled)).toBe(0);
    const unset = await request(app).post("/api/iptv/playlists").set("X-Api-Key", apiKey).send({ name: "Flag Check Default" });
    expect(Number(unset.body.enabled)).toBe(1);

    const clip = await request(app)
      .post("/api/iptv/filler-clips")
      .set("X-Api-Key", apiKey)
      .send({ name: "Bumper", url: "http://example.com/bumper.mp4", enabled: false });
    expect(clip.status).toBe(201);
    expect(Number(clip.body.enabled)).toBe(0);
    const on = await request(app).patch(`/api/iptv/filler-clips/${clip.body.id}`).set("X-Api-Key", apiKey).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(Number(on.body.enabled)).toBe(1);
  });
});
