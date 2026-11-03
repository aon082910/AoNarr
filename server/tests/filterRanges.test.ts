import { describe, it, expect } from "vitest";
import { matchesBypassFilter, parseBypassFilter } from "../src/services/networkAddress.js";

describe("range list matching", () => {
  const list = parseBypassFilter("192.0.2.0/24, not-a-range/99, 198.51.100.7/32");

  it("matches an address inside a range", () => {
    expect(matchesBypassFilter("192.0.2.77", list)).toBe(true);
    expect(matchesBypassFilter("192.0.3.1", list)).toBe(false);
  });

  it("matches a single-address range exactly", () => {
    expect(matchesBypassFilter("198.51.100.7", list)).toBe(true);
    expect(matchesBypassFilter("198.51.100.8", list)).toBe(false);
  });

  it("does not match a host name against a range", () => {
    expect(matchesBypassFilter("example.com", list)).toBe(false);
  });
});
