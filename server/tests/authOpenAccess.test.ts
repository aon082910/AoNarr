import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let isLocalRequest: (typeof import("../src/middleware/auth.js"))["isLocalRequest"];
let clientIp: (typeof import("../src/middleware/auth.js"))["clientIp"];
let hostAllowedForOpenAccess: (typeof import("../src/middleware/auth.js"))["hostAllowedForOpenAccess"];
let openAccessObservations: (typeof import("../src/middleware/auth.js"))["openAccessObservations"];

beforeAll(async () => {
  ({ app, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ isLocalRequest, clientIp, hostAllowedForOpenAccess, openAccessObservations } = await import("../src/middleware/auth.js"));
});

afterEach(() => {
  for (const key of ["authRequired", "localNetworks", "allowedHosts", "externalUrl", "corsAllowedOrigins"]) setSetting(key, "");
});

const fakeRequest = (peer: string, headers: Record<string, string> = {}) =>
  ({
    socket: { remoteAddress: peer },
    ip: peer,
    header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
  }) as any;

const withHost = (host: string | undefined) => fakeRequest("127.0.0.1", host === undefined ? {} : { Host: host });

describe("Local networks (round 30d)", () => {
  it("takes the place of the built-in private ranges", () => {
    setSetting("localNetworks", "192.168.1.0/24");
    expect(isLocalRequest(fakeRequest("192.168.1.20"))).toBe(true);
    expect(isLocalRequest(fakeRequest("10.0.0.4"))).toBe(false);
    expect(isLocalRequest(fakeRequest("127.0.0.1"))).toBe(false);
  });

  it("takes IPv6 ranges and a single address, and reads an IPv4-mapped peer", () => {
    setSetting("localNetworks", "fd12:3456::/48, 192.168.1.5");
    expect(isLocalRequest(fakeRequest("fd12:3456::9"))).toBe(true);
    expect(isLocalRequest(fakeRequest("::ffff:192.168.1.5"))).toBe(true);
    expect(isLocalRequest(fakeRequest("fd00::9"))).toBe(false);
  });

  it("does not need the proxy in front to be on the list: its own address is trusted by the built-in ranges (review H1)", () => {
    setSetting("localNetworks", "192.168.1.0/24");
    // nginx on loopback names the real visitor in X-Real-IP and X-Forwarded-For.
    const home = fakeRequest("127.0.0.1", { "X-Real-IP": "192.168.1.50", "X-Forwarded-For": "192.168.1.50" });
    expect(clientIp(home)).toBe("192.168.1.50");
    expect(isLocalRequest(home)).toBe(true);
    const outside = fakeRequest("127.0.0.1", { "X-Real-IP": "203.0.113.9", "X-Forwarded-For": "203.0.113.9" });
    expect(isLocalRequest(outside)).toBe(false);
    // A peer that is not a private address cannot name the visitor.
    expect(clientIp(fakeRequest("203.0.113.9", { "X-Real-IP": "192.168.1.50" }))).toBe("203.0.113.9");
  });

  it("treats a list with nothing usable in it as 'nothing is local', not as the built-in ranges (review L7)", () => {
    setSetting("localNetworks", "nas.example.com");
    expect(isLocalRequest(fakeRequest("192.168.1.20"))).toBe(false);
  });

  it("goes back to the built-in ranges when cleared", () => {
    setSetting("localNetworks", "10.9.0.0/16");
    expect(isLocalRequest(fakeRequest("192.168.1.20"))).toBe(false);
    setSetting("localNetworks", "");
    expect(isLocalRequest(fakeRequest("192.168.1.20"))).toBe(true);
  });

  it("a header that names a visitor outside the list makes the request not local", () => {
    for (const header of ["CF-Connecting-IP", "True-Client-IP", "X-Client-IP", "X-Original-Forwarded-For"]) {
      expect(isLocalRequest(fakeRequest("192.168.1.2", { [header]: "203.0.113.9" })), header).toBe(false);
      expect(isLocalRequest(fakeRequest("192.168.1.2", { [header]: "192.168.1.60" })), header).toBe(true);
    }
  });
});

describe("hostAllowedForOpenAccess (round 30d)", () => {
  it("lets in an address, localhost, a short name and the LAN suffixes, with or without a port", () => {
    for (const host of ["127.0.0.1:8080", "192.168.1.5", "[::1]:3000", "localhost", "localhost:80", "unraid", "aonarr.lan", "box.home.arpa", "nas.local:8080", "router.fritz.box", "pi.ts.net", "a.intranet", "UNRAID"]) {
      expect(hostAllowedForOpenAccess(withHost(host)), host).toBe(true);
    }
  });

  it("refuses a domain name nobody listed (DNS rebinding)", () => {
    for (const host of ["evil.example.com", "evil.example.com:8080", "127.0.0.1.evil.example.com", "localhost.evil.example.com"]) {
      expect(hostAllowedForOpenAccess(withHost(host)), host).toBe(false);
    }
  });

  it("refuses a missing, oversized or malformed Host", () => {
    expect(hostAllowedForOpenAccess(withHost(undefined))).toBe(false);
    expect(hostAllowedForOpenAccess(withHost(""))).toBe(false);
    expect(hostAllowedForOpenAccess(withHost(`${"a".repeat(300)}.lan`))).toBe(false);
    expect(hostAllowedForOpenAccess(withHost("evil.com@127.0.0.1"))).toBe(false);
    expect(hostAllowedForOpenAccess(withHost("evil.com/x"))).toBe(false);
    expect(hostAllowedForOpenAccess(withHost("evil.com:80:80"))).toBe(false);
  });

  it("reads a trailing dot as the same name", () => {
    expect(hostAllowedForOpenAccess(withHost("unraid."))).toBe(true);
    expect(hostAllowedForOpenAccess(withHost("evil.example.com."))).toBe(false);
  });

  it("accepts the host of the external URL", () => {
    setSetting("externalUrl", "https://aonarr.example.com/");
    expect(hostAllowedForOpenAccess(withHost("aonarr.example.com"))).toBe(true);
    expect(hostAllowedForOpenAccess(withHost("other.example.com"))).toBe(false);
  });

  it("accepts names listed under Allowed host names, with wildcards, ignoring a port", () => {
    setSetting("allowedHosts", "aonarr.example.com:443, *.home.example.com, .lab.example.org");
    expect(hostAllowedForOpenAccess(withHost("aonarr.example.com"))).toBe(true);
    expect(hostAllowedForOpenAccess(withHost("nas.home.example.com:8080"))).toBe(true);
    expect(hostAllowedForOpenAccess(withHost("lab.example.org"))).toBe(true);
    expect(hostAllowedForOpenAccess(withHost("x.lab.example.org"))).toBe(true);
    expect(hostAllowedForOpenAccess(withHost("nothome.example.com"))).toBe(false);
    expect(hostAllowedForOpenAccess(withHost("home.example.com.evil.com"))).toBe(false);
  });

  it("accepts the hosts of the allowed CORS origins", () => {
    setSetting("corsAllowedOrigins", "https://dash.example.com");
    expect(hostAllowedForOpenAccess(withHost("dash.example.com"))).toBe(true);
  });

  it("does not let a bare '*' (a CORS 'any origin' value or a typo) switch the check off (review M5)", () => {
    setSetting("corsAllowedOrigins", "*");
    expect(hostAllowedForOpenAccess(withHost("evil.example.com"))).toBe(false);
    setSetting("allowedHosts", "*");
    expect(hostAllowedForOpenAccess(withHost("evil.example.com"))).toBe(false);
    setSetting("allowedHosts", "*.com, *.duckdns.org");
    expect(hostAllowedForOpenAccess(withHost("evil.com"))).toBe(false);
    expect(hostAllowedForOpenAccess(withHost("x.duckdns.org"))).toBe(false);
  });

  it("answers a wildcard pattern against a long Host in a moment (no backtracking, review M4)", () => {
    setSetting("allowedHosts", "*.*.*.lan.example.com");
    const started = Date.now();
    expect(hostAllowedForOpenAccess(withHost(`${"a.".repeat(100)}zzz.example.org`))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("the login-free modes check the Host name (round 30d)", () => {
  it("mode 0: a name nobody listed gets a 401 that names the setting; the server's address and a key still work", async () => {
    setSetting("authRequired", "0");

    const refused = await request(app as any).get("/api/tags").set("Host", "evil.example.com");
    expect(refused.status).toBe(401);
    expect(refused.body.error).toContain("evil.example.com");
    expect(refused.body.error).toContain("Allowed host names");

    expect((await request(app as any).get("/api/tags")).status).toBe(200);
    expect((await request(app as any).get("/api/tags").set("Host", "evil.example.com").set("X-Api-Key", apiKey)).status).toBe(200);
    setSetting("allowedHosts", "evil.example.com");
    expect((await request(app as any).get("/api/tags").set("Host", "evil.example.com")).status).toBe(200);
  });

  it("mode local: a local visitor under an unlisted name is refused, one under a listed name is let in", async () => {
    setSetting("authRequired", "local");

    expect((await request(app as any).get("/api/tags").set("Host", "evil.example.com")).status).toBe(401);
    expect((await request(app as any).get("/api/tags").set("Host", "nas.lan")).status).toBe(200);
    setSetting("externalUrl", "https://aonarr.example.com");
    expect((await request(app as any).get("/api/tags").set("Host", "aonarr.example.com")).status).toBe(200);
  });

  it("remembers refused visits for Health, cleaning the host text, and does not count an accepted one", async () => {
    setSetting("authRequired", "0");
    const before = openAccessObservations().hostRefused;

    await request(app as any).get("/api/tags").set("Host", "bad<script>.example.com");
    await request(app as any).get("/api/tags");

    const seen = openAccessObservations();
    expect(seen.hostRefused).toBe(before + 1);
    expect(seen.lastHostRefused).toBe("badscript.example.com");
  });

  it("counts a request let in as local that carried proxy headers but no chain of addresses", async () => {
    setSetting("authRequired", "local");
    const before = openAccessObservations().proxiedWithoutChain;

    await request(app as any).get("/api/tags").set("Forwarded", "for=192.0.2.1");
    await request(app as any).get("/api/tags").set("X-Forwarded-For", "192.168.1.5, 192.168.1.2").set("Forwarded", "for=192.168.1.5");

    expect(openAccessObservations().proxiedWithoutChain).toBe(before + 1);
  });

  it("mode off: the Host name is not looked at", async () => {
    setSetting("authRequired", "");
    expect((await request(app as any).get("/api/tags").set("Host", "nas.lan")).status).toBe(401);
    expect((await request(app as any).get("/api/tags").set("Host", "evil.example.com").set("X-Api-Key", apiKey)).status).toBe(200);
  });
});
