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

async function createUser(username: string): Promise<number> {
  const res = await request(app).post("/api/users").set("X-Api-Key", apiKey).send({ username, password: "pw-123456" });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function usernameOf(id: number): Promise<string> {
  return ((await db.prepare("SELECT username FROM users WHERE id = ?").get(id)) as { username: string }).username;
}

// The Edit User form sends `username` on every save; the handler used to ignore it and still
// answer 200, so a rename silently didn't happen.
describe("PATCH /api/users/:id — username", () => {
  it("renames the user, trimming surrounding whitespace", async () => {
    const id = await createUser("jon");
    const res = await request(app).patch(`/api/users/${id}`).set("X-Api-Key", apiKey).send({ username: "  jonathan  " });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("jonathan");
    expect(await usernameOf(id)).toBe("jonathan");
  });

  it("accepts the user's own unchanged username alongside other edits", async () => {
    const id = await createUser("steady");
    const res = await request(app)
      .patch(`/api/users/${id}`)
      .set("X-Api-Key", apiKey)
      .send({ username: "steady", autoApprove: true });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("steady");
    expect(res.body.autoApprove).toBe(1);
  });

  it("returns 409 for a username another account already has, without applying the rest of the edit", async () => {
    await createUser("taken-name");
    const id = await createUser("wants-rename");
    const before = (await db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id)) as { password_hash: string };

    const res = await request(app)
      .patch(`/api/users/${id}`)
      .set("X-Api-Key", apiKey)
      .send({ username: "taken-name", password: "brand-new-password" });
    expect(res.status).toBe(409);
    expect(await usernameOf(id)).toBe("wants-rename");
    const after = (await db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id)) as { password_hash: string };
    expect(after.password_hash).toBe(before.password_hash);
  });

  it("rejects a blank username", async () => {
    const id = await createUser("not-blank");
    const res = await request(app).patch(`/api/users/${id}`).set("X-Api-Key", apiKey).send({ username: "   " });
    expect(res.status).toBe(400);
    expect(await usernameOf(id)).toBe("not-blank");
  });

  it("leaves the username alone when the body doesn't include one", async () => {
    const id = await createUser("untouched");
    const res = await request(app).patch(`/api/users/${id}`).set("X-Api-Key", apiKey).send({ maxPendingRequests: 3 });
    expect(res.status).toBe(200);
    expect(await usernameOf(id)).toBe("untouched");
  });
});
