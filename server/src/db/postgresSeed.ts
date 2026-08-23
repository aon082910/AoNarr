import crypto from "node:crypto";
import type { AsyncDb } from "./asyncDb.js";
import { DEFAULT_QUALITY_ORDER } from "../services/quality.js";

/**
 * Async port of `db/client.ts`'s first-boot seeding (default qualities, the "Any" quality profile,
 * and the instance API key) — those run as SQLite-only synchronous top-level side effects and have
 * no equivalent for Postgres. Without this, a fresh Postgres database would have no qualities, no
 * default quality profile, and — critically — no generated API key, meaning nobody could even log
 * into a fresh Postgres-backed instance. Idempotent the same way the SQLite version is: each step
 * only acts when the table it seeds is still empty.
 */
export async function seedPostgresDefaults(db: AsyncDb): Promise<void> {
  const qualityCount = Number(((await db.prepare("SELECT COUNT(*) AS c FROM qualities").get()) as { c: number }).c);
  if (qualityCount === 0) {
    for (let rank = 0; rank < DEFAULT_QUALITY_ORDER.length; rank++) {
      await db.prepare("INSERT INTO qualities (name, rank) VALUES (?, ?)").run(DEFAULT_QUALITY_ORDER[rank], rank);
    }
  }

  const defaultProfile = await db.prepare("SELECT id FROM quality_profiles WHERE name = ?").get("Any");
  if (!defaultProfile) {
    await db
      .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)")
      .run(
        "Any",
        JSON.stringify(["SD", "HDTV-720p", "WEBDL-720p", "HDTV-1080p", "WEBDL-1080p", "Bluray-1080p", "Remux-2160p"]),
        "WEBDL-1080p"
      );
  }

  const existingApiKey = await db.prepare("SELECT value FROM settings WHERE key = 'apiKey'").get();
  if (!existingApiKey) {
    const apiKey = crypto.randomBytes(24).toString("hex");
    await db.prepare("INSERT INTO settings (key, value) VALUES ('apiKey', ?)").run(apiKey);
    console.log("=".repeat(60));
    console.log(`[startup] generated AoNarr API key: ${apiKey}`);
    console.log("Use this to log into the web UI. Find it again later in Settings.");
    console.log("=".repeat(60));
  }
}
