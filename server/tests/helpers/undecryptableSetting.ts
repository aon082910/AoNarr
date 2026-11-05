import type { setupTestDb } from "./testDb.js";

/**
 * Stores a proxy address that cannot be decrypted (the encryption key does not match) and reloads the settings cache.
 * `setSetting` persists in the background, so a write from an earlier test (an afterEach that cleared the key) can still
 * be on its way to the database and land after this row, turning it back into an empty value: the reload then sees no
 * undecryptable setting. Plant it again until the reload sees it.
 */
export async function plantUndecryptableProxy(db: Awaited<ReturnType<typeof setupTestDb>>["db"]): Promise<void> {
  const { loadSettingsCache, isSettingUndecryptable } = await import("../../src/services/settingsStore.js");
  for (let attempt = 0; attempt < 40; attempt++) {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('socks5ProxyUrl', 'enc1:AAAAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    await loadSettingsCache();
    if (isSettingUndecryptable("socks5ProxyUrl")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("could not plant an undecryptable socks5ProxyUrl: a background settings write keeps replacing it");
}
