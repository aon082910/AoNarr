import { describe, it, expect } from "vitest";
import { MAX_NAME_BYTES, fitFileName, truncateToBytes } from "../src/services/pathNames.js";

describe("truncateToBytes", () => {
  it("cuts by UTF-8 bytes without splitting a character", () => {
    expect(truncateToBytes("abcdef", 4)).toBe("abcd");
    expect(truncateToBytes("漢字漢字", 7)).toBe("漢字"); // 3 bytes each: a third character would be 9
    expect(Buffer.byteLength(truncateToBytes("é".repeat(200), 255))).toBeLessThanOrEqual(255);
  });

  it("returns a short text unchanged", () => {
    expect(truncateToBytes("short", 255)).toBe("short");
  });
});

describe("fitFileName", () => {
  it("leaves a name that fits alone", () => {
    expect(fitFileName("1700000000000-abcd1234-", "Movie (2020).mkv")).toBe("1700000000000-abcd1234-Movie (2020).mkv");
  });

  it("cuts the stem, keeping the extension, when the prefix would push the name past the limit", () => {
    const prefix = "1700000000000-abcd1234-";
    const name = `${"a".repeat(235)}.mkv`;
    const fitted = fitFileName(prefix, name);
    expect(Buffer.byteLength(fitted)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(fitted.startsWith(prefix)).toBe(true);
    expect(fitted.endsWith(".mkv")).toBe(true);
  });

  it("copes with a name with no extension, and with multi-byte names", () => {
    expect(Buffer.byteLength(fitFileName("p-", "x".repeat(400)))).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(Buffer.byteLength(fitFileName("1700000000000-abcd1234-", `${"漢".repeat(78)}.mkv`))).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });
});
