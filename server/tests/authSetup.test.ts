import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

const GATING_TABLES = ["users", "root_folders", "media_items", "indexers", "download_clients"];

/** One row in `table`, the only thing marking this otherwise-empty instance as in use. */
const IN_USE_ROWS: Record<string, () => Promise<unknown>> = {
  root_folders: () => db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run("/data/movies", "movie"),
  media_items: () => db.prepare("INSERT INTO media_items (type, title, sort_title) VALUES (?, ?, ?)").run("movie", "Arrival", "arrival"),
  indexers: () => db.prepare("INSERT INTO indexers (name, protocol, url) VALUES (?, ?, ?)").run("Idx", "torznab", "https://idx.example"),
  download_clients: () => db.prepare("INSERT INTO download_clients (name, type) VALUES (?, ?)").run("qbit", "qbittorrent"),
};

const newAdmin = { username: "first-admin", password: "long-enough-password" };

describe("first-run setup on an instance already in use without any user accounts", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  beforeEach(async () => {
    for (const table of GATING_TABLES) await db.prepare(`DELETE FROM ${table}`).run();
  });

  for (const table of Object.keys(IN_USE_ROWS)) {
    it(`treats an instance with ${table} rows as in use: no setup form, and setup needs the API key`, async () => {
      await IN_USE_ROWS[table]();

      expect((await request(app).get("/api/auth/setup-status")).body).toEqual({ needsSetup: false });

      const anonymous = await request(app).post("/api/auth/setup").send(newAdmin);
      expect(anonymous.status).toBe(403);
      expect((await request(app).post("/api/auth/setup").set("X-Api-Key", "wrong-key").send(newAdmin)).status).toBe(403);
      expect(await db.prepare("SELECT id FROM users").get()).toBeUndefined();
    });
  }

  it("creates the first admin account when the API key is supplied", async () => {
    await IN_USE_ROWS.root_folders();

    const res = await request(app).post("/api/auth/setup").set("X-Api-Key", apiKey).send(newAdmin);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ username: "first-admin", role: "admin" });
    expect(typeof res.body.token).toBe("string");
    const me = await request(app).get("/api/auth/me").set("X-Session-Token", res.body.token);
    expect(me.body).toMatchObject({ isAdmin: true, user: { username: "first-admin" } });
  });

  it("still offers setup to, and accepts it without a credential on, a completely empty install", async () => {
    expect((await request(app).get("/api/auth/setup-status")).body).toEqual({ needsSetup: true });

    const res = await request(app).post("/api/auth/setup").send(newAdmin);

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("admin");
  });
});
