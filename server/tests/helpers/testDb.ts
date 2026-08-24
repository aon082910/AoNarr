import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Initializes a real database for one test file — SQLite (a fresh temp-dir file, fully isolated
 * per file) by default, or Postgres when AONARR_DATABASE_DRIVER=postgres/AONARR_DATABASE_URL are
 * already set in the environment (the CI Postgres job, or a manual `AONARR_DATABASE_DRIVER=postgres
 * AONARR_DATABASE_URL=... npx vitest run` — mirrors this project's own practice of verifying
 * everything against both real backends, never mocks).
 *
 * Config is read from env vars at module-import time (see src/config.ts) — env vars MUST be set
 * before anything imports src/config.ts (transitively, via src/db/index.js), so every import here
 * is a dynamic `await import(...)`, never a static top-level one.
 *
 * Postgres has no per-file filesystem isolation (every test file shares one live database), so its
 * public schema is dropped and recreated before the app's own startup (schema create + default
 * seeding) runs — the same effect as SQLite's fresh temp file, just for a shared server.
 */
export async function setupTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-test-"));
  process.env.AONARR_CONFIG_DIR = dir;
  process.env.AONARR_DOWNLOADS_DIR = dir;

  if (process.env.AONARR_DATABASE_DRIVER === "postgres") {
    if (!process.env.AONARR_DATABASE_URL) {
      throw new Error("AONARR_DATABASE_DRIVER=postgres requires AONARR_DATABASE_URL to be set for tests too");
    }
    const { Client } = await import("pg");
    const client = new Client({ connectionString: process.env.AONARR_DATABASE_URL });
    await client.connect();
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await client.end();
  }

  const { createApp } = await import("../../src/app.js");
  const { db } = await import("../../src/db/index.js");
  const { getSetting } = await import("../../src/services/settingsStore.js");
  const app = await createApp();
  const apiKey = getSetting("apiKey") as string;
  return { app, db, apiKey };
}

