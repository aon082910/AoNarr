import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let sessionToken: string;
let userId: number;

beforeAll(async () => {
  ({ app, db } = await setupTestDb());
  const { createSession, hashPassword } = await import("../src/services/auth.js");
  userId = Number(
    (await db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('household1', ?, 'user')`).run(hashPassword("x"))).lastInsertRowid
  );
  ({ token: sessionToken } = await createSession(userId));
});

describe("PATCH /api/auth/me", () => {
  it("saves display name, bio, and a filtered list of social links", async () => {
    const res = await request(app)
      .patch("/api/auth/me")
      .set("X-Session-Token", sessionToken)
      .send({
        displayName: "  Household One  ",
        bio: "  Loves movies  ",
        socialLinks: [
          { label: "GitHub", url: "https://github.com/x" },
          { label: "", url: "https://blank-label-dropped.example" },
          { label: "Blank URL", url: "" },
          "not even an object",
        ],
      });

    expect(res.status).toBe(204);
    const row = (await db.prepare("SELECT display_name, bio, social_links FROM users WHERE id = ?").get(userId)) as any;
    expect(row.display_name).toBe("Household One");
    expect(row.bio).toBe("Loves movies");
    expect(JSON.parse(row.social_links)).toEqual([{ label: "GitHub", url: "https://github.com/x" }]);
  });

  it("rejects a request with no session (API-key-only auth has no user row to update)", async () => {
    const res = await request(app).patch("/api/auth/me").send({ displayName: "Nope" });
    expect(res.status).toBe(401);
  });

  it("clears displayName/bio back to null when saved blank", async () => {
    await request(app).patch("/api/auth/me").set("X-Session-Token", sessionToken).send({ displayName: "", bio: "", socialLinks: [] });
    const row = (await db.prepare("SELECT display_name, bio FROM users WHERE id = ?").get(userId)) as any;
    expect(row.display_name).toBeNull();
    expect(row.bio).toBeNull();
  });
});

describe("POST /api/auth/me/avatar + GET /api/auth/me/avatar/:userId", () => {
  it("uploads an avatar, persists its path, and serves it back", async () => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 1]);
    const uploadRes = await request(app)
      .post("/api/auth/me/avatar")
      .set("X-Session-Token", sessionToken)
      .attach("file", fakeJpeg, { filename: "me.jpg", contentType: "image/jpeg" });

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.avatarPath).toBe(`user-${userId}.jpg`);
    const row = (await db.prepare("SELECT avatar_path FROM users WHERE id = ?").get(userId)) as any;
    expect(row.avatar_path).toBe(`user-${userId}.jpg`);

    const getRes = await request(app)
      .get(`/api/auth/me/avatar/${userId}`)
      .set("X-Session-Token", sessionToken)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(getRes.status).toBe(200);
    expect((getRes.body as Buffer).equals(fakeJpeg)).toBe(true);
  });

  it("rejects a non-image upload", async () => {
    const res = await request(app)
      .post("/api/auth/me/avatar")
      .set("X-Session-Token", sessionToken)
      .attach("file", Buffer.from("not an image"), { filename: "me.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
  });

  it("404s for a user with no avatar set", async () => {
    const { hashPassword } = await import("../src/services/auth.js");
    const otherId = Number(
      (await db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('no-avatar-user', ?, 'user')`).run(hashPassword("x"))).lastInsertRowid
    );
    const res = await request(app).get(`/api/auth/me/avatar/${otherId}`).set("X-Session-Token", sessionToken);
    expect(res.status).toBe(404);
  });
});
