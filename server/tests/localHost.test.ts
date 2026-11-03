import { describe, it, expect } from "vitest";
import { isLocalAddress } from "../src/services/networkAddress.js";

describe("isLocalAddress names", () => {
  it("accepts localhost, local suffixes and single-word names", () => {
    for (const host of ["localhost", "LOCALHOST", "app.localhost", "nas.local", "router.lan", "db.internal", "printer.home.arpa", "qbittorrent", "radarr."]) {
      expect(isLocalAddress(host), host).toBe(true);
    }
  });

  it("rejects public names and the empty string", () => {
    for (const host of ["example.com", "api.themoviedb.org", "nas.example.com", ""]) {
      expect(isLocalAddress(host), host).toBe(false);
    }
  });
});

describe("isLocalAddress IPv4", () => {
  it("accepts the private, loopback, link-local and shared-address blocks", () => {
    const local = ["127.0.0.1", "10.1.2.3", "172.16.0.5", "172.31.255.255", "192.168.1.205", "169.254.10.10", "100.64.0.1", "100.127.255.255"];
    for (const host of local) expect(isLocalAddress(host), host).toBe(true);
  });

  it("rejects public addresses and the neighbours of each block", () => {
    const outside = ["8.8.8.8", "172.15.255.255", "172.32.0.1", "192.169.0.1", "100.63.255.255", "100.128.0.1", "203.0.113.9"];
    for (const host of outside) expect(isLocalAddress(host), host).toBe(false);
  });
});

describe("isLocalAddress IPv6", () => {
  it("accepts loopback, unique-local, link-local and mapped private addresses, bracketed or not", () => {
    for (const host of ["::1", "[::1]", "fd00::1", "fe80::1", "::ffff:192.168.1.5"]) expect(isLocalAddress(host), host).toBe(true);
  });

  it("rejects global addresses", () => {
    for (const host of ["2001:db8::1", "[2606:4700::1111]", "::ffff:8.8.8.8"]) expect(isLocalAddress(host), host).toBe(false);
  });
});

describe("isLocalAddress as new URL() writes a host (review F9)", () => {
  it("reads a mapped IPv4 address written in hex", () => {
    for (const url of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:192.168.1.5]/"]) {
      expect(isLocalAddress(new URL(url).hostname), url).toBe(true);
    }
    expect(isLocalAddress(new URL("http://[::ffff:8.8.8.8]/").hostname)).toBe(false);
  });

  it("treats the unspecified IPv4 and IPv6 addresses alike", () => {
    expect(isLocalAddress("0.0.0.0")).toBe(true);
    expect(isLocalAddress("::")).toBe(true);
  });
});
