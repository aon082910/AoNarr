import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

// A JSON true/false (what scripts and MCP tools send) reached the SQLite driver unconverted by four
// insert routes, which it refuses to bind: a 500 instead of a row.

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

const post = (path: string, body: Record<string, unknown>) => request(app).post(path).set("X-Api-Key", apiKey).send(body);

async function insertItem(type: string, title: string): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES (?, ?, ?, 1, 0, 'unknown')").run(type, title, title.toLowerCase()))
      .lastInsertRowid
  );
}

describe("insert routes accept a JSON boolean for monitored / enabled", () => {
  it("POST /api/media/:id/episodes", async () => {
    const showId = await insertItem("series", "Boolean Show");
    const flags: [unknown, number][] = [[true, 1], [false, 0], [undefined, 1]];
    for (const [i, [sent, stored]] of flags.entries()) {
      const res = await post(`/api/media/${showId}/episodes`, { seasonNumber: 1, episodeNumber: i + 1, ...(sent === undefined ? {} : { monitored: sent }) });
      expect(res.status, `monitored: ${String(sent)}`).toBe(201);
      const row = (await db.prepare("SELECT monitored FROM episodes WHERE id = ?").get(res.body.id)) as { monitored: number };
      expect(Number(row.monitored)).toBe(stored);
    }
  });

  it("POST /api/media/:id/subitems", async () => {
    const artistId = await insertItem("artist", "Boolean Artist");
    const flags: [unknown, number][] = [[true, 1], [false, 0], [undefined, 1]];
    for (const [i, [sent, stored]] of flags.entries()) {
      const res = await post(`/api/media/${artistId}/subitems`, { title: `Album ${i}`, ...(sent === undefined ? {} : { monitored: sent }) });
      expect(res.status, `monitored: ${String(sent)}`).toBe(201);
      const row = (await db.prepare("SELECT monitored FROM sub_items WHERE id = ?").get(res.body.id)) as { monitored: number };
      expect(Number(row.monitored)).toBe(stored);
    }
  });

  it("POST /api/ai-providers", async () => {
    const flags: [unknown, number][] = [[true, 1], [false, 0], [undefined, 1]];
    for (const [i, [sent, stored]] of flags.entries()) {
      const res = await post("/api/ai-providers", { name: `Local ${i}`, type: "local", baseUrl: "http://localhost:11434/", model: "m", ...(sent === undefined ? {} : { enabled: sent }) });
      expect(res.status, `enabled: ${String(sent)}`).toBe(201);
      const row = (await db.prepare("SELECT enabled FROM ai_providers WHERE id = ?").get(res.body.id)) as { enabled: number };
      expect(Number(row.enabled)).toBe(stored);
    }
  });

  it("POST /api/subtitles/providers", async () => {
    const flags: [unknown, number][] = [[true, 1], [false, 0], [undefined, 1]];
    for (const [i, [sent, stored]] of flags.entries()) {
      const res = await post("/api/subtitles/providers", {
        name: `Custom ${i}`,
        type: "custom",
        config: { searchUrlTemplate: "http://subs.example.com/?q={query}" },
        ...(sent === undefined ? {} : { enabled: sent }),
      });
      expect(res.status, `enabled: ${String(sent)}`).toBe(201);
      const row = (await db.prepare("SELECT enabled FROM subtitle_providers WHERE id = ?").get(res.body.id)) as { enabled: number };
      expect(Number(row.enabled)).toBe(stored);
    }
  });
});
