import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP-SHA1 — a reference computation the tests use to derive "the code that should be
 * valid right now", so verifyTotp's actual behavior (time-window tolerance, input validation) gets
 * exercised against a real, correctly-generated code rather than only ever seeing garbage. */
function referenceHotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** 6).padStart(6, "0");
}

describe("totp", () => {
  it("generateBase32Secret produces a secret using only the RFC 4648 base32 alphabet, and never repeats", async () => {
    const { generateBase32Secret } = await import("../src/services/totp.js");
    const a = generateBase32Secret();
    const b = generateBase32Secret();
    expect(a).toMatch(/^[A-Z2-7]+$/);
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it("buildOtpauthUrl includes the issuer, account label, and the 6-digit/30s parameters an authenticator app needs", async () => {
    const { buildOtpauthUrl } = await import("../src/services/totp.js");
    const url = buildOtpauthUrl("JBSWY3DPEHPK3PXP", "alice");
    expect(url).toMatch(/^otpauth:\/\/totp\//);
    expect(url).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(url).toContain("issuer=AoNarr");
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
    expect(decodeURIComponent(url)).toContain("AoNarr:alice");
  });

  describe("verifyTotp", () => {
    const secret = "JBSWY3DPEHPK3PXP";

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects malformed input before ever touching the secret (non-6-digit, non-numeric)", async () => {
      const { verifyTotp } = await import("../src/services/totp.js");
      expect(verifyTotp(secret, "12345")).toBe(false);
      expect(verifyTotp(secret, "1234567")).toBe(false);
      expect(verifyTotp(secret, "abcdef")).toBe(false);
      expect(verifyTotp(secret, "")).toBe(false);
    });

    it("accepts the code for the current 30s window", async () => {
      const { verifyTotp } = await import("../src/services/totp.js");
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const counter = Math.floor(now / 1000 / STEP_SECONDS);
      expect(verifyTotp(secret, referenceHotp(secret, counter))).toBe(true);
    });

    it("tolerates one step of clock drift in either direction", async () => {
      const { verifyTotp } = await import("../src/services/totp.js");
      const now = 1_700_000_000_000;
      const counter = Math.floor(now / 1000 / STEP_SECONDS);

      vi.setSystemTime(now);
      expect(verifyTotp(secret, referenceHotp(secret, counter - 1))).toBe(true); // a code generated just before this window
      expect(verifyTotp(secret, referenceHotp(secret, counter + 1))).toBe(true); // or just after
    });

    it("rejects a code from more than one step away", async () => {
      const { verifyTotp } = await import("../src/services/totp.js");
      const now = 1_700_000_000_000;
      const counter = Math.floor(now / 1000 / STEP_SECONDS);

      vi.setSystemTime(now);
      expect(verifyTotp(secret, referenceHotp(secret, counter - 2))).toBe(false);
      expect(verifyTotp(secret, referenceHotp(secret, counter + 2))).toBe(false);
    });

    it("rejects a code generated for a different secret", async () => {
      const { verifyTotp } = await import("../src/services/totp.js");
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const counter = Math.floor(now / 1000 / STEP_SECONDS);
      const codeForOtherSecret = referenceHotp("AAAAAAAAAAAAAAAA", counter);
      expect(verifyTotp(secret, codeForOtherSecret)).toBe(false);
    });
  });
});
