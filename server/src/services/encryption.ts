import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * Encryption-at-rest for sensitive `settings` table values (indexer/metadata-provider API keys,
 * download-client passwords, SMTP passwords, notification webhook URLs/tokens — see
 * `settingsStore.ts`'s `isSensitiveSettingKey`). The key itself lives in a file next to the
 * database (`<configDir>/encryption.key`), generated once on first boot the same way the AoNarr
 * API key already is — never in the database itself, since encrypting a value with a key stored
 * in the same table it's meant to protect would defend against nothing (anyone who can read the
 * settings table can already read the key sitting right next to it).
 *
 * This protects the DB file at rest (a stolen/leaked backup, a misconfigured volume mount someone
 * else can read) — it does NOT protect a value from anyone who already has shell/API access to a
 * running AoNarr instance, since the app itself always needs the plaintext to actually use these
 * credentials against a real service.
 */
const KEY_PATH = path.join(config.configDir, "encryption.key");
/** Backup/restore (see services/scheduledBackup.ts) needs to know exactly where this lives so it
 * can bundle it alongside the database — without it, restoring onto a different config volume
 * permanently loses every encrypted credential (see decryptValue's doc comment below). */
export const ENCRYPTION_KEY_PATH = KEY_PATH;
const PREFIX = "enc1:";

let cachedKey: Buffer | null = null;

/** Drops the in-memory key cache so the next encrypt/decrypt re-reads `encryption.key` from disk —
 * needed after a Postgres restore writes a (possibly different) key file into the same running
 * process, since unlike the SQLite restore path this one doesn't exit and restart. */
export function reloadEncryptionKey(): void {
  cachedKey = null;
}

function loadOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey;
  try {
    const hex = fs.readFileSync(KEY_PATH, "utf-8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      cachedKey = Buffer.from(hex, "hex");
      return cachedKey;
    }
  } catch {
    // no key file yet — fall through and create one
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, key.toString("hex"), { mode: 0o600 });
  cachedKey = key;
  return key;
}

/** AES-256-GCM. Format: `enc1:` + base64(12-byte iv || 16-byte auth tag || ciphertext). */
export function encryptValue(plaintext: string): string {
  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Returns the value unchanged if it isn't in our encrypted format — a legacy plaintext value from
 * before this feature existed, which the caller (settingsStore.ts) re-encrypts on next write
 * rather than this function silently "fixing" it on every read.
 *
 * Throws (rather than swallowing) when a value IS in the encrypted format but fails to decrypt —
 * this only happens if `encryption.key` doesn't match the key the value was encrypted with, the
 * realistic case being: the in-app DB backup/restore feature only backs up the database file, not
 * `encryption.key` (a deliberate, separate file precisely so a stolen DB backup alone can't
 * decrypt anything — see the module comment above) — restoring that backup into a *different*
 * config volume than the one it came from means every credential silently becomes unrecoverable
 * garbage unless this is loud about it. The caller (settingsStore.ts's loadSettingsCache) catches
 * this per-row and logs which specific setting key failed, instead of this function quietly
 * returning "" and leaving an admin to discover a broken integration with no explanation.
 */
export function decryptValue(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const key = loadOrCreateKey();
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith(PREFIX);
}
