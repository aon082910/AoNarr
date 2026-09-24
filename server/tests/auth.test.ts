import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

/** RFC 6238 code for `secretBase32` right now — a reference computation, independent of totp.ts. */
function currentTotpCode(secretBase32: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secretBase32) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) key.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const hmac = crypto.createHmac("sha1", Buffer.from(key)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** 6).padStart(6, "0");
}

async function insertUser(username: string, password: string, role: "user" | "admin" = "user"): Promise<number> {
  const { hashPassword } = await import("../src/services/auth.js");
  return Number(
    (await db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run(username, hashPassword(password), role)).lastInsertRowid
  );
}

describe("auth", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  describe("hashPassword / verifyPassword", () => {
    it("round-trips a password", async () => {
      const { hashPassword, verifyPassword } = await import("../src/services/auth.js");
      const stored = hashPassword("correct horse battery staple");
      expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    });

    it("rejects the wrong password", async () => {
      const { hashPassword, verifyPassword } = await import("../src/services/auth.js");
      const stored = hashPassword("correct horse battery staple");
      expect(verifyPassword("wrong password", stored)).toBe(false);
    });

    it("produces a different salt (and hash) each time for the same password", async () => {
      const { hashPassword } = await import("../src/services/auth.js");
      expect(hashPassword("same-password")).not.toBe(hashPassword("same-password"));
    });

    it("rejects a malformed or foreign-scheme stored hash instead of throwing", async () => {
      const { verifyPassword } = await import("../src/services/auth.js");
      expect(verifyPassword("anything", "not-a-real-hash")).toBe(false);
      expect(verifyPassword("anything", "bcrypt$salt$hash")).toBe(false);
      expect(verifyPassword("anything", "")).toBe(false);
    });
  });

  describe("createPendingLogin / consumePendingLogin", () => {
    it("resolves back to the same user id exactly once", async () => {
      const { createPendingLogin, consumePendingLogin } = await import("../src/services/auth.js");
      const token = createPendingLogin(42);
      expect(consumePendingLogin(token)).toBe(42);
      // One-time use — a second consume (e.g. a replayed request) must not succeed again.
      expect(consumePendingLogin(token)).toBeNull();
    });

    it("rejects an unknown token", async () => {
      const { consumePendingLogin } = await import("../src/services/auth.js");
      expect(consumePendingLogin("never-issued")).toBeNull();
    });
  });

  describe("sessions", () => {
    it("createSession + getSessionUser round-trips the user's access flags", async () => {
      const { createSession, getSessionUser, hashPassword } = await import("../src/services/auth.js");
      const userId = Number(
        (
          await db
            .prepare(
              `INSERT INTO users (username, password_hash, max_content_rating, auto_approve) VALUES (?, ?, 'PG-13', 1)`
            )
            .run("session-user", hashPassword("x"))
        ).lastInsertRowid
      );
      await db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, 'movie')").run(userId);

      const { token } = await createSession(userId, "test-agent");
      const sessionUser = await getSessionUser(token);
      expect(sessionUser?.id).toBe(userId);
      expect(sessionUser?.maxContentRating).toBe("PG-13");
      expect(sessionUser?.autoApprove).toBe(true);
      expect(sessionUser?.allowedTypes).toEqual(["movie"]);
    });

    it("getSessionUser returns null and deletes the row for an already-expired session", async () => {
      const { getSessionUser } = await import("../src/services/auth.js");
      const userId = Number(
        (await db.prepare(`INSERT INTO users (username, password_hash) VALUES ('expired-user', 'x')`).run()).lastInsertRowid
      );
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('expired-token', ?, ?)").run(userId, pastIso);

      expect(await getSessionUser("expired-token")).toBeNull();
      const row = await db.prepare("SELECT token FROM sessions WHERE token = 'expired-token'").get();
      expect(row).toBeUndefined();
    });

    it("destroySession removes the row so it can no longer authenticate", async () => {
      const { createSession, destroySession, getSessionUser } = await import("../src/services/auth.js");
      const userId = Number(
        (await db.prepare(`INSERT INTO users (username, password_hash) VALUES ('logout-user', 'x')`).run()).lastInsertRowid
      );
      const { token } = await createSession(userId);
      await destroySession(token);
      expect(await getSessionUser(token)).toBeNull();
    });

    // Regression test for a real bug: expires_at is stored as an ISO string
    // ("2026-09-17T10:00:00.000Z") while the DB's own "now" is "YYYY-MM-DD HH:MM:SS" — comparing
    // the two as raw TEXT (rather than as dates) made any same-day expiry sort as "later than now"
    // no matter the actual time, because 'T' (0x54) sorts above ' ' (0x20) at the character
    // position where the two formats otherwise agree. That silently listed already-expired
    // same-day sessions as still active in the admin session-management screen.
    it("listActiveSessions correctly excludes a session that expired earlier today (not just on an earlier date)", async () => {
      const { listActiveSessions } = await import("../src/services/auth.js");
      const userId = Number(
        (await db.prepare(`INSERT INTO users (username, password_hash) VALUES ('today-expired-user', 'x')`).run()).lastInsertRowid
      );
      const expiredEarlierTodayIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      await db
        .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('today-expired-token', ?, ?)")
        .run(userId, expiredEarlierTodayIso);

      const active = await listActiveSessions();
      expect(active.find((s) => s.token === "today-expired-token")).toBeUndefined();
    });

    it("listActiveSessions includes a session that hasn't expired yet", async () => {
      const { createSession, listActiveSessions } = await import("../src/services/auth.js");
      const userId = Number(
        (await db.prepare(`INSERT INTO users (username, password_hash) VALUES ('still-active-user', 'x')`).run()).lastInsertRowid
      );
      const { token } = await createSession(userId);

      const active = await listActiveSessions();
      expect(active.find((s) => s.token === token)).toBeDefined();
    });
  });

  // Every rate-limit test below sends its own X-Real-IP (honored because supertest connects over
  // loopback), so the limiter's module-wide per-IP buckets never leak from one test into another.
  describe("requireAuth lockout", () => {
    it("still accepts a valid API key or session token from an IP whose authkey bucket is locked out", async () => {
      const { createSession } = await import("../src/services/auth.js");
      const ip = "203.0.113.10";
      const me = () => request(app).get("/api/auth/me").set("X-Real-IP", ip);

      for (let i = 0; i < 10; i++) expect((await me().set("X-Api-Key", "wrong-key")).status).toBe(401);
      expect((await me().set("X-Api-Key", "wrong-key")).status).toBe(429);

      const withKey = await me().set("X-Api-Key", apiKey);
      expect(withKey.status).toBe(200);
      expect(withKey.body).toEqual({ isAdmin: true });

      const userId = await insertUser("lockout-session-user", "x");
      const { token } = await createSession(userId);
      const withSession = await me().set("X-Session-Token", token);
      expect(withSession.status).toBe(200);
      expect(withSession.body.user.id).toBe(userId);

      // A valid request in between doesn't lift the lockout for the next bad one.
      expect((await me().set("X-Session-Token", "not-a-real-token")).status).toBe(429);
    });
  });

  describe("POST /api/auth/login rate limiting", () => {
    it("keys failures per target username, so a successful login to another account doesn't clear them", async () => {
      const ip = "203.0.113.20";
      await insertUser("login-victim", "victim-password");
      await insertUser("login-own-account", "own-password");
      const login = (username: string, password: string) => request(app).post("/api/auth/login").set("X-Real-IP", ip).send({ username, password });

      for (let i = 0; i < 9; i++) expect((await login("login-victim", "guess")).status).toBe(401);
      expect((await login("login-own-account", "own-password")).status).toBe(200);
      expect((await login("login-victim", "guess")).status).toBe(401); // the 10th failure

      expect((await login("login-victim", "victim-password")).status).toBe(429);
      // The other account at the same address isn't collateral damage of that lockout.
      expect((await login("login-own-account", "own-password")).status).toBe(200);
    });

    it("counts failures against differently-cased spellings of one username in the same bucket", async () => {
      const ip = "203.0.113.21";
      await insertUser("case-victim", "case-password");
      const login = (username: string, password: string) => request(app).post("/api/auth/login").set("X-Real-IP", ip).send({ username, password });

      for (let i = 0; i < 10; i++) expect((await login(i % 2 === 0 ? "Case-Victim" : "case-victim", "guess")).status).toBe(401);

      expect((await login("case-victim", "case-password")).status).toBe(429);
    });
  });

  describe("POST /api/auth/login/totp rate limiting", () => {
    it("a successful TOTP login doesn't clear failures accumulated from the same address", async () => {
      const ip = "203.0.113.30";
      const secret = "JBSWY3DPEHPK3PXP";
      const userId = await insertUser("totp-login-user", "totp-password");
      await db.prepare("UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?").run(secret, userId);
      const totp = (pendingToken: string, code: string) => request(app).post("/api/auth/login/totp").set("X-Real-IP", ip).send({ pendingToken, code });
      const passwordStep = async (): Promise<string> => {
        const res = await request(app).post("/api/auth/login").set("X-Real-IP", ip).send({ username: "totp-login-user", password: "totp-password" });
        expect(res.body.totpRequired).toBe(true);
        return res.body.pendingToken;
      };

      for (let i = 0; i < 9; i++) expect((await totp(`bogus-pending-${i}`, "000000")).status).toBe(401);
      expect((await totp(await passwordStep(), currentTotpCode(secret))).status).toBe(200);
      expect((await totp("bogus-pending-final", "000000")).status).toBe(401); // the 10th failure

      expect((await totp(await passwordStep(), currentTotpCode(secret))).status).toBe(429);
    });
  });

  describe("first-run setup", () => {
    it("reports needsSetup only while the users table is completely empty", async () => {
      await db.prepare("DELETE FROM users").run();
      expect((await request(app).get("/api/auth/setup-status")).body).toEqual({ needsSetup: true });

      // No admin-role account yet, but household accounts mean the instance is already in use.
      await insertUser("setup-household-only", "x");
      expect((await request(app).get("/api/auth/setup-status")).body).toEqual({ needsSetup: false });
    });

    it("refuses POST /auth/setup once any user exists, unless a valid API key is supplied", async () => {
      await db.prepare("DELETE FROM users").run();
      await insertUser("setup-existing-household", "x");
      const body = { username: "would-be-admin", password: "long-enough-password" };

      expect((await request(app).post("/api/auth/setup").send(body)).status).toBe(403);
      expect((await request(app).post("/api/auth/setup").set("X-Api-Key", "wrong-key").send(body)).status).toBe(403);
      expect(await db.prepare("SELECT id FROM users WHERE role = 'admin'").get()).toBeUndefined();

      const res = await request(app).post("/api/auth/setup").set("X-Api-Key", apiKey).send(body);
      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ username: "would-be-admin", role: "admin" });

      // Once an admin exists, not even the API key mints a second one through this route.
      const second = await request(app).post("/api/auth/setup").set("X-Api-Key", apiKey).send({ username: "second-admin", password: "long-enough-password" });
      expect(second.status).toBe(403);
    });

    it("still lets a genuinely fresh install create its first admin with no credential at all", async () => {
      await db.prepare("DELETE FROM users").run();

      const res = await request(app).post("/api/auth/setup").send({ username: "fresh-admin", password: "long-enough-password" });

      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe("admin");
    });
  });
});
