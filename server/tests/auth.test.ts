import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

describe("auth", () => {
  beforeAll(async () => {
    ({ db } = await setupTestDb());
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
});
