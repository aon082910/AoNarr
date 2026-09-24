import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
});

async function createUser(username: string, allowedTypes: string[] = []): Promise<number> {
  const res = await request(app).post("/api/users").set("X-Api-Key", apiKey).send({ username, password: "pw-123456", allowedTypes });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function userRow(id: number) {
  return (await db.prepare("SELECT username, password_hash, auto_approve, max_content_rating FROM users WHERE id = ?").get(id)) as {
    username: string;
    password_hash: string;
    auto_approve: number;
    max_content_rating: string | null;
  };
}

async function allowedTypesOf(id: number): Promise<string[]> {
  const rows = (await db.prepare("SELECT media_type FROM user_library_access WHERE user_id = ?").all(id)) as { media_type: string }[];
  return rows.map((r) => r.media_type).sort();
}

// Each field used to be validated only when its own write came up, so a 400 for a later field
// kept every earlier write (a rename, a new password) and skipped the audit entry for them.
describe("PATCH /api/users/:id — a rejected field leaves the whole edit unapplied", () => {
  it("an unknown content rating doesn't keep the rename or the other edits", async () => {
    const id = await createUser("rating-check");
    const before = await userRow(id);

    const res = await request(app)
      .patch(`/api/users/${id}`)
      .set("X-Api-Key", apiKey)
      .send({ username: "rating-renamed", password: "another-password", autoApprove: true, maxContentRating: "NOT-A-RATING" });

    expect(res.status).toBe(400);
    expect(await userRow(id)).toEqual(before);
  });

  it("a fractional or non-numeric maxPendingRequests doesn't keep the rename or the password", async () => {
    const id = await createUser("pending-check");
    const before = await userRow(id);

    for (const maxPendingRequests of [2.5, "abc", -1]) {
      const res = await request(app)
        .patch(`/api/users/${id}`)
        .set("X-Api-Key", apiKey)
        .send({ username: "pending-renamed", password: "another-password", maxPendingRequests });

      expect(res.status).toBe(400);
      expect(await userRow(id)).toEqual(before);
    }
  });

  it("an unknown media type in allowedTypes doesn't keep the rename or change library access", async () => {
    const id = await createUser("types-check", ["movie"]);
    const before = await userRow(id);

    const res = await request(app)
      .patch(`/api/users/${id}`)
      .set("X-Api-Key", apiKey)
      .send({ username: "types-renamed", maxContentRating: "PG", allowedTypes: ["series", "not-a-type"] });

    expect(res.status).toBe(400);
    expect(await userRow(id)).toEqual(before);
    expect(await allowedTypesOf(id)).toEqual(["movie"]);
  });

  it("applies and audits the same edit once every field is valid", async () => {
    const id = await createUser("valid-check", ["movie"]);

    const res = await request(app)
      .patch(`/api/users/${id}`)
      .set("X-Api-Key", apiKey)
      .send({ username: "valid-renamed", maxContentRating: "PG", allowedTypes: ["series"] });

    expect(res.status).toBe(200);
    const after = await userRow(id);
    expect(after.username).toBe("valid-renamed");
    expect(after.max_content_rating).toBe("PG");
    expect(await allowedTypesOf(id)).toEqual(["series"]);
    // logAuditEvent doesn't await its insert.
    let audit: { detail: string }[] = [];
    for (let i = 0; i < 100 && audit.length === 0; i++) {
      audit = (await db
        .prepare("SELECT detail FROM audit_log WHERE event_type = 'user_permissions_changed' AND detail LIKE ?")
        .all("valid-check:%")) as { detail: string }[];
      if (audit.length === 0) await new Promise((r) => setTimeout(r, 10));
    }
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toContain("username → valid-renamed");
  });
});
