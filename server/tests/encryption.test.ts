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

  it("creates a valid, persisted 64-hex-character key file on first use, not just an in-memory value", async () => {
    // Every prior test only proves encrypt/decrypt round-trips WITHIN the same process, where
    // cachedKey masks whatever actually landed on disk. A real restart re-reads the file, so the
    // file's own content is what actually matters for persistence across restarts/backups.
    const { encryptValue, reloadEncryptionKey } = await import("../src/services/encryption.js");
    const keyPath = path.join(configDir, "encryption.key");
    fs.rmSync(keyPath, { force: true });
    reloadEncryptionKey();

    encryptValue("triggers key creation");

    const written = fs.readFileSync(keyPath, "utf-8").trim();
    expect(written).toMatch(/^[0-9a-f]{64}$/i);
  });

  it("regenerates the key when the on-disk file is corrupted/malformed, rather than crashing", async () => {
    // Distinct code path from "no file at all" (which goes through the catch block below) --
    // readFileSync succeeds here, the regex just fails, so it falls through to the same
    // key-generation logic without ever throwing.
    const { encryptValue, decryptValue, reloadEncryptionKey } = await import("../src/services/encryption.js");
    const keyPath = path.join(configDir, "encryption.key");
    fs.writeFileSync(keyPath, "not-a-valid-hex-key", { mode: 0o600 });
    reloadEncryptionKey();

    const encrypted = encryptValue("survives a corrupted key file");
    expect(decryptValue(encrypted)).toBe("survives a corrupted key file");

    const regenerated = fs.readFileSync(keyPath, "utf-8").trim();
    expect(regenerated).toMatch(/^[0-9a-f]{64}$/i);
    expect(regenerated).not.toBe("not-a-valid-hex-key");
  });

  it("decryptValue throws on a truncated/malformed encrypted value, not just a wrong-key one", async () => {
    const { decryptValue } = await import("../src/services/encryption.js");
    // base64 for "tooshort" -- far too little data to contain a real 12-byte iv + 16-byte auth
    // tag + ciphertext, exercising a genuinely different failure mode than the key-mismatch test
    // above (a corrupted settings-table value, not a lost/rotated key).
    expect(() => decryptValue("enc1:dG9vc2hvcnQ=")).toThrow();
  });
});
