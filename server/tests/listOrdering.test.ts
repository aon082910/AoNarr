import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

// Every row below shares one created_at, later than anything the app writes during the test, so
// they fill the first pages and only the id tiebreaker decides their order across pages.
const SAME_SECOND = "2099-01-01 00:00:00";
const ROWS = 30;
const PAGE = 7;

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function collectPages(fetchPage: (offset: number) => Promise<number[]>): Promise<number[]> {
  const ids: number[] = [];
  for (let offset = 0; offset < ROWS; offset += PAGE) ids.push(...(await fetchPage(offset)));
  return ids.slice(0, ROWS);
}

function newestFirst(ids: number[]): number[] {
  return [...ids].sort((a, b) => b - a);
}

describe("paginated lists with same-timestamp rows", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("GET /api/import-review pages through every tied row exactly once, newest id first", async () => {
    const inserted: number[] = [];
    for (let n = 0; n < ROWS; n++) {
      inserted.push(
        Number(
          (
            await db
              .prepare("INSERT INTO import_review_items (source, type, title, created_at) VALUES ('watchlist', 'movie', ?, ?)")
              .run(`Review ${n}`, SAME_SECOND)
          ).lastInsertRowid
        )
      );
    }

    const ids = await collectPages(async (offset) => {
      const res = await request(app).get("/api/import-review").query({ limit: PAGE, offset }).set("X-Api-Key", apiKey);
      expect(res.status).toBe(200);
      return res.body.items.map((i: any) => i.id);
    });

    expect(ids).toEqual(newestFirst(inserted));
  });

  it("GET /api/blocklist pages through every tied row exactly once, newest id first", async () => {
    const mediaItemId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title) VALUES ('movie', 'Blocked Movie', 'blocked movie')").run())
        .lastInsertRowid
    );
    const inserted: number[] = [];
    for (let n = 0; n < ROWS; n++) {
      inserted.push(
        Number(
          (
            await db
              .prepare("INSERT INTO blocklist (media_item_id, release_title, created_at) VALUES (?, ?, ?)")
              .run(mediaItemId, `Blocked.Release.${n}`, SAME_SECOND)
          ).lastInsertRowid
        )
      );
    }

    const ids = await collectPages(async (offset) => {
      const res = await request(app).get("/api/blocklist").query({ limit: PAGE, offset }).set("X-Api-Key", apiKey);
      expect(res.status).toBe(200);
      return res.body.items.map((i: any) => Number(i.id));
    });

    expect(ids).toEqual(newestFirst(inserted));
  });

  it("GET /api/audit-log pages through every tied row exactly once, newest id first", async () => {
    const inserted: number[] = [];
    for (let n = 0; n < ROWS; n++) {
      inserted.push(
        Number(
          (
            await db
              .prepare("INSERT INTO audit_log (username, event_type, detail, created_at) VALUES ('admin', 'ordering_test', ?, ?)")
              .run(`event ${n}`, SAME_SECOND)
          ).lastInsertRowid
        )
      );
    }

    const ids: number[] = [];
    for (let page = 1; ids.length < ROWS; page++) {
      const res = await request(app).get("/api/audit-log").query({ page, pageSize: PAGE }).set("X-Api-Key", apiKey);
      expect(res.status).toBe(200);
      ids.push(...res.body.rows.map((r: any) => Number(r.id)));
    }

    expect(ids.slice(0, ROWS)).toEqual(newestFirst(inserted));
  });

  it("GET /api/requests pages through every tied row exactly once, newest id first", async () => {
    const { hashPassword } = await import("../src/services/auth.js");
    const userId = Number(
      (await db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('ordering-requester', ?, 'user')").run(hashPassword("x")))
        .lastInsertRowid
    );
    const inserted: number[] = [];
    for (let n = 0; n < ROWS; n++) {
      inserted.push(
        Number(
          (
            await db
              .prepare("INSERT INTO requests (user_id, type, title, created_at) VALUES (?, 'movie', ?, ?)")
              .run(userId, `Requested ${n}`, SAME_SECOND)
          ).lastInsertRowid
        )
      );
    }

    const ids = await collectPages(async (offset) => {
      const res = await request(app).get("/api/requests").query({ limit: PAGE, offset }).set("X-Api-Key", apiKey);
      expect(res.status).toBe(200);
      return res.body.items.map((i: any) => i.id);
    });

    expect(ids).toEqual(newestFirst(inserted));
  });
});
