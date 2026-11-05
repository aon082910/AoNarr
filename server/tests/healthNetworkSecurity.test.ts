import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { setupTestDb } from "./helpers/testDb.js";
import { plantUndecryptableProxy } from "./helpers/undecryptableSetting.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let networkSecurityIssues: (typeof import("../src/services/healthReport.js"))["networkSecurityIssues"];
let applySocksProxySetting: (typeof import("../src/services/socksProxy.js"))["applySocksProxySetting"];
let verifyOutboundDispatcher: (typeof import("../src/services/socksProxy.js"))["verifyOutboundDispatcher"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let originalDispatcher: unknown;

beforeAll(async () => {
  ({ app, db } = await setupTestDb());
  ({ networkSecurityIssues } = await import("../src/services/healthReport.js"));
  ({ applySocksProxySetting, verifyOutboundDispatcher } = await import("../src/services/socksProxy.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  originalDispatcher = getGlobalDispatcher();
});

afterEach(() => {
  for (const key of ["authRequired", "localNetworks", "externalUrl", "allowedHosts", "socks5ProxyUrl"]) setSetting(key, "");
  setSetting("tlsRejectUnauthorized", "1");
  applySocksProxySetting();
});

afterAll(() => {
  setGlobalDispatcher(originalDispatcher as any);
});

const sources = async () => (await networkSecurityIssues()).map((issue) => issue.source);

describe("Health: the outbound proxy (round 30d)", () => {
  it("says nothing while the network settings are in order", async () => {
    expect(await networkSecurityIssues()).toEqual([]);
  });

  it("reports a stored proxy address that could not be decrypted as an error, and stops once it is cleared", async () => {
    await plantUndecryptableProxy(db);
    applySocksProxySetting();

    const issues = await networkSecurityIssues();
    expect(issues.map((issue) => issue.source)).toEqual(["outbound-proxy-unusable"]);
    expect(issues[0]).toMatchObject({ severity: "error", transient: false });
    expect(issues[0].message).toMatch(/could not be decrypted/);
    expect(issues[0].message).toMatch(/refused instead of going out directly/);

    setSetting("socks5ProxyUrl", "");
    applySocksProxySetting();
    expect(await sources()).toEqual([]);
  });

  it("leaves an address that does not parse to the proxy check, so it is reported once", async () => {
    setSetting("socks5ProxyUrl", "not a url at all");
    applySocksProxySetting();
    expect(await sources()).toEqual([]);
  });

  it("reports a fetch() that does not go through the installed dispatcher", async () => {
    setSetting("tlsRejectUnauthorized", "local");
    applySocksProxySetting();
    const router = getGlobalDispatcher();
    setGlobalDispatcher(new Agent());
    try {
      await verifyOutboundDispatcher();
      expect(await sources()).toEqual(["outbound-dispatcher"]);
    } finally {
      setGlobalDispatcher(router);
    }
    expect(await verifyOutboundDispatcher()).toBe(true);
    expect(await sources()).toEqual([]);
  });
});

describe("Health: the login-free modes (round 30d)", () => {
  it("warns when 'disabled for local addresses' and an external URL are set without a Local networks list", async () => {
    setSetting("authRequired", "local");
    setSetting("externalUrl", "https://aonarr.example.com");
    expect(await sources()).toContain("local-auth-external");

    setSetting("localNetworks", "192.168.1.0/24");
    expect(await sources()).not.toContain("local-auth-external");
  });

  it("stays quiet about the external URL in the other modes", async () => {
    setSetting("externalUrl", "https://aonarr.example.com");
    expect(await sources()).not.toContain("local-auth-external");
    setSetting("authRequired", "0");
    expect(await sources()).not.toContain("local-auth-external");
  });

  it("warns about a request let in as local that carried reverse-proxy headers and no chain of addresses", async () => {
    setSetting("authRequired", "local");
    await request(app as any).get("/api/tags").set("Forwarded", "for=192.0.2.1").expect(200);

    const issue = (await networkSecurityIssues()).find((i) => i.source === "local-auth-proxy");
    expect(issue).toMatchObject({ severity: "warning", transient: false });
    expect(issue?.message).toMatch(/Local networks/);
  });

  it("warns about a visit refused because of its host name, naming the host", async () => {
    setSetting("authRequired", "0");
    await request(app as any).get("/api/tags").set("Host", "rebind.example.net").expect(401);

    const issue = (await networkSecurityIssues()).find((i) => i.source === "open-access-host");
    expect(issue?.message).toContain("rebind.example.net");
    expect(issue?.message).toMatch(/Allowed host names/);
  });

  it("does not report the host warning when login is required anyway", async () => {
    setSetting("authRequired", "");
    expect(await sources()).not.toContain("open-access-host");
  });
});
