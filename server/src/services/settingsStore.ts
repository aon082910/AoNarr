import { db } from "../db/index.js";
import { log } from "./logger.js";

/**
 * `getSetting` is called synchronously from extremely hot, extremely widely-used paths —
 * `requireAuth` middleware on every single request being the most important one — so making it
 * `async` would cascade `await` through the ~24 files (101 call sites) that call it today, most of
 * which have nothing else to do with the DB. Instead: the whole (small — a few dozen rows) settings
 * table is cached in memory, loaded once at startup via `loadSettingsCache()`, and every write goes
 * through the cache synchronously first (so a `setSetting()` immediately followed by a `getSetting()`
 * in the same tick sees the new value, matching the old synchronous-DB behavior exactly) with the
 * actual persistence to the DB happening in the background. This is a deliberate, scoped exception
 * to "convert every table's access to the async interface" — safe specifically because settings is
 * small, read far more often than written, and every existing call site already treated `setSetting`
 * as fire-and-forget (nothing awaited its synchronous better-sqlite3 call either).
 */
let cache: Map<string, string> | null = null;

export async function loadSettingsCache(): Promise<void> {
  const rows = (await db.prepare("SELECT key, value FROM settings").all()) as { key: string; value: string }[];
  cache = new Map(rows.map((r) => [r.key, r.value]));
}

export function getSetting(key: string): string | null {
  if (!cache) throw new Error("settings cache accessed before loadSettingsCache() completed — check startup ordering in index.ts");
  return cache.get(key) ?? null;
}

export function getAllSettings(): Record<string, string> {
  if (!cache) throw new Error("settings cache accessed before loadSettingsCache() completed — check startup ordering in index.ts");
  return Object.fromEntries(cache);
}

export function setSetting(key: string, value: string): void {
  if (!cache) throw new Error("settings cache accessed before loadSettingsCache() completed — check startup ordering in index.ts");
  cache.set(key, value);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .run(key, value)
    .catch((err) => log.error(`[settingsStore] failed to persist "${key}":`, (err as Error).message));
}

export function deleteSetting(key: string): void {
  if (!cache) throw new Error("settings cache accessed before loadSettingsCache() completed — check startup ordering in index.ts");
  cache.delete(key);
  db.prepare("DELETE FROM settings WHERE key = ?")
    .run(key)
    .catch((err) => log.error(`[settingsStore] failed to delete "${key}":`, (err as Error).message));
}
