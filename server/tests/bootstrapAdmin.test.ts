import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
const ADMIN_ENV_KEYS = ["AONARR_ADMIN_USERNAME", "AONARR_ADMIN_USERNAME_FILE", "AONARR_ADMIN_PASSWORD", "AONARR_ADMIN_PASSWORD_FILE"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

afterEach(async () => {
  for (const key of ADMIN_ENV_KEYS) delete process.env[key];
  // bootstrapAdminFromEnv only ever acts when NO admin exists yet, so leaving a created row behind
  // would make every later test in this file silently no-op — reset fully between tests instead.
  await db.prepare("DELETE FROM users").run();
});

async function countUsers(): Promise<number> {
  const row = (await db.prepare("SELECT COUNT(*) AS c FROM users").get()) as { c: number };
  return Number(row.c);
}

describe("bootstrapAdminFromEnv", () => {
  it("does nothing when an admin account already exists", async () => {
    const { bootstrapAdminFromEnv } = await import("../src/services/bootstrapAdmin.js");
    await db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('existing-admin', 'scrypt$x$y', 'admin')").run();
    process.env.AONARR_ADMIN_USERNAME = "should-not-be-created";
    process.env.AONARR_ADMIN_PASSWORD = "password123";
    const before = await countUsers();

    await bootstrapAdminFromEnv();

    expect(await countUsers()).toBe(before);
    expect(await db.prepare("SELECT id FROM users WHERE username = 'should-not-be-created'").get()).toBeUndefined();
  });

  it("does nothing when the username/password env vars aren't set", async () => {
    const { bootstrapAdminFromEnv } = await import("../src/services/bootstrapAdmin.js");
    const before = await countUsers();

    await bootstrapAdminFromEnv();

    expect(await countUsers()).toBe(before);
  });

  it("refuses to create an admin with a password shorter than 8 characters", async () => {
    const { bootstrapAdminFromEnv } = await import("../src/services/bootstrapAdmin.js");
    process.env.AONARR_ADMIN_USERNAME = "short-pw-admin";
    process.env.AONARR_ADMIN_PASSWORD = "short";

    await bootstrapAdminFromEnv();

    expect(await db.prepare("SELECT id FROM users WHERE username = 'short-pw-admin'").get()).toBeUndefined();
  });

  it("creates an admin from plain env vars, storing a hash rather than the plaintext password", async () => {
    const { bootstrapAdminFromEnv } = await import("../src/services/bootstrapAdmin.js");
    process.env.AONARR_ADMIN_USERNAME = "env-admin";
    process.env.AONARR_ADMIN_PASSWORD = "correct-horse-battery";

    await bootstrapAdminFromEnv();

    const row = (await db.prepare("SELECT * FROM users WHERE username = 'env-admin'").get()) as any;
    expect(row).toBeDefined();
    expect(row.role).toBe("admin");
    expect(row.password_hash).not.toBe("correct-horse-battery");
    expect(row.password_hash).toMatch(/^scrypt\$/);
  });

  it("trims surrounding whitespace from the username", async () => {
    const { bootstrapAdminFromEnv } = await import("../src/services/bootstrapAdmin.js");
    process.env.AONARR_ADMIN_USERNAME = "  padded-admin  ";
    process.env.AONARR_ADMIN_PASSWORD = "correct-horse-battery";

    await bootstrapAdminFromEnv();

    expect(await db.prepare("SELECT id FROM users WHERE username = 'padded-admin'").get()).toBeDefined();
  });

  it("supports the Docker-secrets _FILE variant for both username and password", async () => {
    const { bootstrapAdminFromEnv } = await import("../src/services/bootstrapAdmin.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-admin-secret-"));
    const userFile = path.join(dir, "user");
    const passFile = path.join(dir, "pass");
    fs.writeFileSync(userFile, "secret-file-admin\n");
    fs.writeFileSync(passFile, "correct-horse-battery\n");
    process.env.AONARR_ADMIN_USERNAME_FILE = userFile;
    process.env.AONARR_ADMIN_PASSWORD_FILE = passFile;

    await bootstrapAdminFromEnv();

    expect(await db.prepare("SELECT id FROM users WHERE username = 'secret-file-admin'").get()).toBeDefined();
  });
});
