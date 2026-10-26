import { describe, it, expect, beforeAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

async function rawValue(key: string): Promise<string | undefined> {
  const row = (await db.prepare("SELECT value FROM settings WHERE key = ?").get(key)) as { value: string } | undefined;
  return row?.value;
}

// setSetting / deleteSetting persist in the background (the cache updates synchronously, the database
// catches up), so an assertion on the raw stored row polls until the write lands. A fixed wait failed
// intermittently when the Postgres job's runner was busy.
const eventually = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 5000, interval: 25 });

describe("getSetting / setSetting", () => {
  it("returns null for a key that was never set", async () => {
    const { getSetting } = await import("../src/services/settingsStore.js");
    expect(getSetting("neverSetTestKey")).toBeNull();
  });

  it("returns the value synchronously right after setting it, without awaiting anything", async () => {
    const { getSetting, setSetting } = await import("../src/services/settingsStore.js");
    setSetting("plainTestSetting", "hello");
    expect(getSetting("plainTestSetting")).toBe("hello");
  });

  it("persists a plain (non-sensitive) key's value as plaintext in the database", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("plainPersistedSetting", "visible-value");

    await eventually(async () => {
      expect(await rawValue("plainPersistedSetting")).toBe("visible-value");
    });
  });

  it("encrypts a sensitive-looking key's value at rest, while the cache keeps serving plaintext", async () => {
    const { getSetting, setSetting } = await import("../src/services/settingsStore.js");
    const { isEncryptedValue } = await import("../src/services/encryption.js");
    setSetting("someServiceApiKey", "super-secret-value");

    expect(getSetting("someServiceApiKey")).toBe("super-secret-value");
    await eventually(async () => {
      const stored = await rawValue("someServiceApiKey");
      expect(stored).toBeDefined();
      expect(stored).not.toBe("super-secret-value");
      expect(isEncryptedValue(stored!)).toBe(true);
    });
  });

  it("matches sensitive key names case-insensitively and for every recognized suffix", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { isEncryptedValue } = await import("../src/services/encryption.js");
    const sensitiveKeys = ["myDiscordWEBHOOKurl", "adminPASSWORD", "botToken", "instanceSecret", "somePrivateKey", "friendUserKey"];
    for (const key of sensitiveKeys) setSetting(key, "value-for-" + key);

    await eventually(async () => {
      for (const key of sensitiveKeys) {
        const stored = await rawValue(key);
        expect(stored).toBeDefined();
        expect(isEncryptedValue(stored!)).toBe(true);
      }
    });
  });

  it("overwrites an existing key's value instead of creating a duplicate row", async () => {
    const { getSetting, setSetting } = await import("../src/services/settingsStore.js");
    setSetting("overwriteTestSetting", "first");
    setSetting("overwriteTestSetting", "second");

    expect(getSetting("overwriteTestSetting")).toBe("second");
    await eventually(async () => {
      const count = (await db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'overwriteTestSetting'").get()) as { c: number };
      expect(Number(count.c)).toBe(1);
    });
  });
});

describe("getAllSettings", () => {
  it("includes a just-set key in a plain object snapshot of the whole cache", async () => {
    const { setSetting, getAllSettings } = await import("../src/services/settingsStore.js");
    setSetting("snapshotTestKey", "snapshot-value");

    const all = getAllSettings();
    expect(all.snapshotTestKey).toBe("snapshot-value");
  });
});

describe("deleteSetting", () => {
  it("removes the key from both the cache and the database", async () => {
    const { setSetting, getSetting, deleteSetting } = await import("../src/services/settingsStore.js");
    setSetting("deleteMeTestSetting", "temporary");
    expect(getSetting("deleteMeTestSetting")).toBe("temporary");
    await eventually(async () => {
      expect(await rawValue("deleteMeTestSetting")).toBe("temporary");
    });

    deleteSetting("deleteMeTestSetting");

    expect(getSetting("deleteMeTestSetting")).toBeNull();
    await eventually(async () => {
      expect(await rawValue("deleteMeTestSetting")).toBeUndefined();
    });
  });
});
