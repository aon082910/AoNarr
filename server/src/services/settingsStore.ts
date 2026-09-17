import { db } from "../db/index.js";
import { log } from "./logger.js";
import { decryptValue, encryptValue, isEncryptedValue } from "./encryption.js";

/** Matches setting keys that hold a real credential/secret (as opposed to a plain preference or
 * URL) — API keys, passwords, access/bot/auth tokens, webhook URLs (a Discord/Slack webhook URL
 * *is* the credential, not just an address), and the instance's own admin API key. A substring
 * match on the key name rather than a hardcoded list, so a newly added provider's *ApiKey/
 * *Password/*Token/*WebhookUrl setting is automatically covered without a matching edit here. */
function isSensitiveSettingKey(key: string): boolean {
  return /password|apikey|token|secret|privatekey|userkey|webhookurl/i.test(key);
}

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
  cache = new Map();
  // Self-healing migration: an install that predates encryption-at-rest has plaintext rows for
  // keys that are now considered sensitive — decrypted (or already-plaintext) values still go
  // into the cache exactly the same either way, but a legacy plaintext sensitive value also gets
  // quietly re-encrypted and written back, so it's protected from the very next boot onward
  // without needing a person to re-enter every credential by hand.
  const toReencrypt: { key: string; value: string }[] = [];
  const failedToDecrypt: string[] = [];
  for (const row of rows) {
    if (isEncryptedValue(row.value)) {
      try {
        cache.set(row.key, decryptValue(row.value));
      } catch {
        // encryption.key doesn't match what this value was encrypted with — almost always a DB
        // backup restored into a different config volume than the one it came from (see
        // encryption.ts's module comment). Falls back to empty rather than crashing settings
        // load entirely, but is loud about exactly which setting needs re-entering by hand.
        cache.set(row.key, "");
        failedToDecrypt.push(row.key);
      }
    } else {
      cache.set(row.key, row.value);
      if (row.value && isSensitiveSettingKey(row.key)) toReencrypt.push(row);
    }
  }
  if (failedToDecrypt.length > 0) {
    log.error(
      `[settingsStore] couldn't decrypt ${failedToDecrypt.length} setting(s) — encryption.key doesn't match what they were encrypted with (likely a DB backup restored into a different config directory than it came from). These now need to be re-entered by hand: ${failedToDecrypt.join(", ")}`
    );
  }
  if (toReencrypt.length > 0) {
    for (const row of toReencrypt) {
      db.prepare("UPDATE settings SET value = ? WHERE key = ?")
        .run(encryptValue(row.value), row.key)
        .catch((err) => log.error(`[settingsStore] failed to encrypt legacy value for "${row.key}":`, (err as Error).message));
    }
    log.info(`[settingsStore] encrypted ${toReencrypt.length} legacy plaintext setting(s) at rest`);
  }
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
  cache.set(key, value); // cache always holds plaintext — see loadSettingsCache's comment
  const stored = value && isSensitiveSettingKey(key) ? encryptValue(value) : value;
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .run(key, stored)
    .catch((err) => log.error(`[settingsStore] failed to persist "${key}":`, (err as Error).message));
}

export function deleteSetting(key: string): void {
  if (!cache) throw new Error("settings cache accessed before loadSettingsCache() completed — check startup ordering in index.ts");
  cache.delete(key);
  db.prepare("DELETE FROM settings WHERE key = ?")
    .run(key)
    .catch((err) => log.error(`[settingsStore] failed to delete "${key}":`, (err as Error).message));
}
