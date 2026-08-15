import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

/** RFC 6238 TOTP over HMAC-SHA1 — implemented directly on Node's built-in crypto rather than
 * pulling in a dependency for what's ~30 lines of well-specified math. */

export function generateBase32Secret(bytes = 20): string {
  const raw = crypto.randomBytes(bytes);
  let bits = "";
  for (const byte of raw) bits += byte.toString(2).padStart(8, "0");
  let secret = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** Accepts a code from the current or adjacent 30s window (±1 step) to tolerate minor clock drift. */
export function verifyTotp(secret: string, token: string): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (const offset of [0, -1, 1]) {
    if (hotp(secret, counter + offset) === token) return true;
  }
  return false;
}

export function buildOtpauthUrl(secret: string, accountLabel: string): string {
  const issuer = encodeURIComponent("AoNarr");
  const label = encodeURIComponent(accountLabel);
  return `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
