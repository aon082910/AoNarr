import { describe, it, expect } from "vitest";
import { matchesBypassFilter, parseBypassFilter } from "../src/services/networkAddress.js";

const list = parseBypassFilter("nas.example.com, *.corp.example, .media.test");

describe("host list matching", () => {
  it("matches an exact name, ignoring case", () => {
    expect(matchesBypassFilter("NAS.example.com", list)).toBe(true);
    expect(matchesBypassFilter("other.example.com", list)).toBe(false);
  });

  it("matches a wildcard", () => {
    expect(matchesBypassFilter("a.b.corp.example", list)).toBe(true);
    expect(matchesBypassFilter("corp.example", list)).toBe(false);
  });

  it("reads a leading dot as the domain and everything under it", () => {
    expect(matchesBypassFilter("media.test", list)).toBe(true);
    expect(matchesBypassFilter("plex.media.test", list)).toBe(true);
    expect(matchesBypassFilter("notmedia.test", list)).toBe(false);
  });

  it("matches nothing for an empty or blank list", () => {
    expect(parseBypassFilter("")).toEqual([]);
    expect(parseBypassFilter(null)).toEqual([]);
    expect(matchesBypassFilter("anything.example.com", parseBypassFilter(" , ; "))).toBe(false);
  });
});

describe("host list parsing details (review F10)", () => {
  it("hands every entry it cannot use to the caller", () => {
    const dropped: string[] = [];

    const entries = parseBypassFilter("fd00::/200, 192.0.2.0/99, ok.example.com", (item) => dropped.push(item));

    expect(dropped).toEqual(["fd00::/200", "192.0.2.0/99"]);
    expect(matchesBypassFilter("ok.example.com", entries)).toBe(true);
  });

  it("takes an IPv6 host written in brackets in the list", () => {
    expect(matchesBypassFilter("::1", parseBypassFilter("[::1]"))).toBe(true);
  });

  it("answers a many-star pattern at once instead of backtracking", () => {
    const entries = parseBypassFilter("*a*a*a*a*a*a*a*a*a*a*a*a*b");
    const started = Date.now();

    const matched = matchesBypassFilter("a".repeat(200) + ".example.com", entries);

    expect(matched).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("matches stars in the middle in order", () => {
    const entries = parseBypassFilter("media-*-prod.example.com");
    expect(matchesBypassFilter("media-eu-1-prod.example.com", entries)).toBe(true);
    expect(matchesBypassFilter("media-prod.example.com", entries)).toBe(false);
  });
});
