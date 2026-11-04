import { describe, it, expect } from "vitest";
import { hostPatternProblem, matchesBypassFilter, parseBypassFilter, v6ToBigInt } from "../src/services/networkAddress.js";

describe("v6ToBigInt", () => {
  it("reads a full address, a compressed one and the loopback", () => {
    expect(v6ToBigInt("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(0x20010db8000000000000000000000001n);
    expect(v6ToBigInt("2001:db8::1")).toBe(0x20010db8000000000000000000000001n);
    expect(v6ToBigInt("::1")).toBe(1n);
    expect(v6ToBigInt("::")).toBe(0n);
  });

  it("reads brackets, a zone id and any letter case", () => {
    expect(v6ToBigInt("[2001:DB8::1]")).toBe(0x20010db8000000000000000000000001n);
    expect(v6ToBigInt("fe80::1%eth0")).toBe(0xfe800000000000000000000000000001n);
  });

  it("reads a dotted IPv4 tail", () => {
    expect(v6ToBigInt("::ffff:192.168.1.5")).toBe(0xffffc0a80105n);
  });

  it("gives null for text that is not an IPv6 address", () => {
    expect(v6ToBigInt("192.168.1.5")).toBeNull();
    expect(v6ToBigInt("home.lan")).toBeNull();
    expect(v6ToBigInt("2001:db8::1::2")).toBeNull();
    expect(v6ToBigInt("")).toBeNull();
  });
});

describe("IPv6 entries in the bypass list", () => {
  it("matches an address inside a range and none outside it", () => {
    const entries = parseBypassFilter("fd00::/8");
    expect(matchesBypassFilter("fd12:3456::1", entries)).toBe(true);
    expect(matchesBypassFilter("[fd12:3456::1]", entries)).toBe(true);
    expect(matchesBypassFilter("fe80::1", entries)).toBe(false);
    expect(matchesBypassFilter("2001:db8::1", entries)).toBe(false);
  });

  it("matches a single address however it is spelled", () => {
    const entries = parseBypassFilter("2001:db8::1");
    expect(matchesBypassFilter("2001:0db8:0:0:0:0:0:1", entries)).toBe(true);
    expect(matchesBypassFilter("2001:db8::2", entries)).toBe(false);
  });

  it("honors the prefix length of a narrow range", () => {
    const entries = parseBypassFilter("2001:db8:abcd::/48");
    expect(matchesBypassFilter("2001:db8:abcd:ffff::1", entries)).toBe(true);
    expect(matchesBypassFilter("2001:db8:abce::1", entries)).toBe(false);
  });

  it("matches an IPv4-mapped address against an IPv4 range", () => {
    const entries = parseBypassFilter("192.168.1.0/24");
    expect(matchesBypassFilter("::ffff:192.168.1.77", entries)).toBe(true);
    expect(matchesBypassFilter("::ffff:192.168.2.77", entries)).toBe(false);
  });

  it("keeps IPv4 ranges and host names working beside IPv6 ones", () => {
    const entries = parseBypassFilter("10.0.0.0/8, *.example.com, fd00::/8");
    expect(matchesBypassFilter("10.1.2.3", entries)).toBe(true);
    expect(matchesBypassFilter("api.example.com", entries)).toBe(true);
    expect(matchesBypassFilter("fd00::5", entries)).toBe(true);
    expect(matchesBypassFilter("11.0.0.1", entries)).toBe(false);
  });

  it("hands entries it cannot use to the callback instead of ignoring them", () => {
    const dropped: string[] = [];
    const entries = parseBypassFilter("fd00::/200, 2001:db8::zz, 10.0.0.0/40, 192.168.0.0/16", (item) => dropped.push(item));
    expect(dropped).toEqual(["fd00::/200", "2001:db8::zz", "10.0.0.0/40"]);
    expect(entries).toHaveLength(1);
  });
});

describe("range prefix lengths and single addresses (round 30d review)", () => {
  it("drops a range with an empty or non-numeric prefix instead of reading it as /0", () => {
    const dropped: string[] = [];
    const entries = parseBypassFilter("192.168.1.0/, fd00::/, 10.0.0.0/+8, 10.0.0.0/0x8", (item) => dropped.push(item));
    expect(entries).toHaveLength(0);
    expect(dropped).toEqual(["192.168.1.0/", "fd00::/", "10.0.0.0/+8", "10.0.0.0/0x8"]);
  });

  it("still reads /0 when it is written out, so the caller can decide it is too wide", () => {
    const entries = parseBypassFilter("0.0.0.0/0");
    expect(entries).toHaveLength(1);
    expect(matchesBypassFilter("203.0.113.9", entries)).toBe(true);
  });

  it("reads a single IPv4 address as a range of one", () => {
    const entries = parseBypassFilter("192.168.1.5, 127.0.0.1");
    expect(entries.every((entry) => entry.kind === "net")).toBe(true);
    expect(matchesBypassFilter("192.168.1.5", entries)).toBe(true);
    expect(matchesBypassFilter("127.0.0.1", entries)).toBe(true);
    expect(matchesBypassFilter("192.168.1.6", entries)).toBe(false);
    expect(matchesBypassFilter("::ffff:192.168.1.5", entries)).toBe(true);
  });
});

describe("hostPatternProblem (round 30d review)", () => {
  it("accepts a plain name and a wildcard in front of a domain", () => {
    for (const ok of ["aonarr.example.com", "nas", "*.home.example.com", "nas-*.example.com", ".example.com", "a.*.example.com"]) {
      expect(hostPatternProblem(ok), ok).toBeNull();
    }
  });

  it("refuses a wildcard that would accept names an attacker can register", () => {
    for (const bad of ["*", "**", "*.com", "*example.com", "nas-*", "*.duckdns.org", "*.x.dyndns.org", ".com"]) {
      expect(hostPatternProblem(bad), bad).not.toBeNull();
    }
  });

  it("refuses more than three wildcards", () => {
    expect(hostPatternProblem("*.*.*.*.example.com")).toMatch(/three wildcards/);
  });

  it("a name with a leading dot matches the domain and its sub-domains", () => {
    const entries = parseBypassFilter(".example.com");
    expect(matchesBypassFilter("example.com", entries)).toBe(true);
    expect(matchesBypassFilter("a.example.com", entries)).toBe(true);
    expect(matchesBypassFilter("badexample.com", entries)).toBe(false);
  });
});
