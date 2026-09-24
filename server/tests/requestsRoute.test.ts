import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function householdUser(username: string, allowedTypes: string[], autoApprove = false): Promise<{ userId: number; token: string }> {
  const { createSession, hashPassword } = await import("../src/services/auth.js");
  const userId = Number(
    (
      await db
        .prepare(`INSERT INTO users (username, password_hash, role, auto_approve) VALUES (?, ?, 'user', ?)`)
        .run(username, hashPassword("x"), autoApprove ? 1 : 0)
    ).lastInsertRowid
  );
  for (const type of allowedTypes) {
    await db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, ?)").run(userId, type);
  }
  return { userId, token: (await createSession(userId)).token };
}

async function insertRequest(userId: number, title: string, status: "pending" | "approved" | "rejected"): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO requests (user_id, type, title, status) VALUES (?, 'movie', ?, ?)").run(userId, title, status)).lastInsertRowid
  );
}

describe("requests routes", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  describe("POST /api/requests", () => {
    it("403s a request for a library type the household account can't access, without recording it", async () => {
      const { token } = await householdUser("requests-movie-only", ["movie"]);

      const res = await request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "series", title: "Forbidden Show" });

      expect(res.status).toBe(403);
      expect(await db.prepare("SELECT id FROM requests WHERE title = 'Forbidden Show'").get()).toBeUndefined();
    });

    it("never auto-approves a disallowed type into the library, even for an auto-approve account", async () => {
      const { token } = await householdUser("requests-auto-approve", ["movie"], true);

      const res = await request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "series", title: "Auto Approve Show" });

      expect(res.status).toBe(403);
      expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Auto Approve Show'").get()).toBeUndefined();
    });

    it("still accepts a request for an allowed type", async () => {
      const { token } = await householdUser("requests-allowed", ["movie"]);

      const res = await request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "movie", title: "Allowed Movie" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ type: "movie", title: "Allowed Movie", status: "pending" });
    });
  });

  describe("POST /api/requests/:id/reject", () => {
    let requesterId: number;

    beforeAll(async () => {
      ({ userId: requesterId } = await householdUser("requests-rejectee", ["movie"]));
    });

    it("rejects a pending request", async () => {
      const id = await insertRequest(requesterId, "Pending Reject Movie", "pending");

      const res = await request(app).post(`/api/requests/${id}/reject`).set("X-Api-Key", apiKey);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("rejected");
    });

    it("400s for an already-approved request and leaves it approved", async () => {
      const id = await insertRequest(requesterId, "Approved Movie", "approved");
      const before = (await db.prepare("SELECT status, resolved_at FROM requests WHERE id = ?").get(id)) as any;

      const res = await request(app).post(`/api/requests/${id}/reject`).set("X-Api-Key", apiKey);

      expect(res.status).toBe(400);
      expect(await db.prepare("SELECT status, resolved_at FROM requests WHERE id = ?").get(id)).toEqual(before);
      expect(before.status).toBe("approved");
    });

    it("400s for an already-rejected request", async () => {
      const id = await insertRequest(requesterId, "Rejected Movie", "rejected");

      const res = await request(app).post(`/api/requests/${id}/reject`).set("X-Api-Key", apiKey);

      expect(res.status).toBe(400);
    });

    it("404s for a request that doesn't exist", async () => {
      const res = await request(app).post("/api/requests/999999/reject").set("X-Api-Key", apiKey);
      expect(res.status).toBe(404);
    });
  });
});
