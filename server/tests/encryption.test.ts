import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/** encryption.ts reads AONARR_CONFIG_DIR (via src/config.ts) at module-import time to locate
 * encryption.key, so — same reasoning as tests/helpers/testDb.ts — the env var must be set before
 * the first `await import(...)` of it, and every import stays dynamic rather than a static
 * top-level one. */
let configDir: string;

beforeAll(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-enc-"));
  process.env.AONARR_CONFIG_DIR = configDir;
});

describe("encryption", () => {
  it("round-trips a value through encryptValue/decryptValue", async () => {
    const { encryptValue, decryptValue } = await import("../src/services/encryption.js");
    const encrypted = encryptValue("super-secret-api-key");
    expect(encrypted).not.toBe("super-secret-api-key");
    expect(decryptValue(encrypted)).toBe("super-secret-api-key");
  });

  it("produces a different ciphertext each time (random IV) but both still decrypt correctly", async () => {
    const { encryptValue, decryptValue } = await import("../src/services/encryption.js");
    const a = encryptValue("same-plaintext");
    const b = encryptValue("same-plaintext");
    expect(a).not.toBe(b);
    expect(decryptValue(a)).toBe("same-plaintext");
    expect(decryptValue(b)).toBe("same-plaintext");
  });

  it("isEncryptedValue distinguishes our format from plaintext", async () => {
    const { encryptValue, isEncryptedValue } = await import("../src/services/encryption.js");
    expect(isEncryptedValue(encryptValue("x"))).toBe(true);
    expect(isEncryptedValue("plain-old-value")).toBe(false);
    expect(isEncryptedValue("")).toBe(false);
  });

  it("decryptValue returns a legacy plaintext value unchanged instead of throwing", async () => {
    const { decryptValue } = await import("../src/services/encryption.js");
    expect(decryptValue("never-encrypted-legacy-value")).toBe("never-encrypted-legacy-value");
  });

  it("decryptValue throws (rather than silently returning garbage) when encryption.key doesn't match what a value was encrypted with", async () => {
    const { encryptValue, decryptValue, reloadEncryptionKey } = await import("../src/services/encryption.js");
    const encrypted = encryptValue("will-become-unrecoverable");

    // Simulates restoring a DB backup into a config volume with a different (or freshly
    // generated) encryption.key — exactly the scenario encryption.ts's own module doc warns about.
    fs.writeFileSync(path.join(configDir, "encryption.key"), crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    reloadEncryptionKey();

    expect(() => decryptValue(encrypted)).toThrow();
  });

  it("reloadEncryptionKey lets a fresh key take effect for new encryptions immediately", async () => {
    const { encryptValue, decryptValue, reloadEncryptionKey } = await import("../src/services/encryption.js");
    fs.writeFileSync(path.join(configDir, "encryption.key"), crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    reloadEncryptionKey();

    const encrypted = encryptValue("under-the-new-key");
    expect(decryptValue(encrypted)).toBe("under-the-new-key");
  });
});
