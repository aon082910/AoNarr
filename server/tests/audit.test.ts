import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

// logAuditEvent is deliberately fire-and-forget (its own doc comment: "nobody awaited the old
// synchronous better-sqlite3 call either") — give its underlying write a moment to land before
// asserting on it, rather than making the function itself awaitable just for this test.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("logAuditEvent", () => {
  it("records an event with its user id/username/type/detail", async () => {
    const { logAuditEvent } = await import("../src/services/audit.js");
    const userId = Number((await db.prepare("INSERT INTO users (username, password_hash) VALUES ('alice', 'x')").run()).lastInsertRowid);
    logAuditEvent(userId, "alice", "login", "some detail");
    await flush();

    const row = (await db.prepare("SELECT * FROM audit_log WHERE username = 'alice' AND event_type = 'login'").get()) as any;
    expect(row).toBeDefined();
    expect(row.user_id).toBe(userId);
    expect(row.detail).toBe("some detail");
  });

  it("records a null user id for an action with no attributable household account (the bare API key)", async () => {
    const { logAuditEvent } = await import("../src/services/audit.js");
    logAuditEvent(null, "admin", "backup_downloaded");
    await flush();

    const row = (await db.prepare("SELECT * FROM audit_log WHERE username = 'admin' AND event_type = 'backup_downloaded'").get()) as any;
    expect(row).toBeDefined();
    expect(row.user_id).toBeNull();
    expect(row.detail).toBeNull();
  });
});

describe("auditActor", () => {
  it("attributes to the session user when one is present", async () => {
    const { auditActor } = await import("../src/services/audit.js");
    const req = { auth: { user: { id: 3, username: "bob" } } } as any;
    expect(auditActor(req)).toEqual({ userId: 3, username: "bob" });
  });

  it("falls back to the unattributed \"admin\" actor for a bare-API-key request", async () => {
    const { auditActor } = await import("../src/services/audit.js");
    expect(auditActor({ auth: { isAdmin: true } } as any)).toEqual({ userId: null, username: "admin" });
    expect(auditActor({} as any)).toEqual({ userId: null, username: "admin" });
  });
});
