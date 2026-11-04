import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import http from "node:http";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { setupTestDb } from "./helpers/testDb.js";

let applySocksProxySetting: (typeof import("../src/services/socksProxy.js"))["applySocksProxySetting"];
let proxyBlockedReason: (typeof import("../src/services/socksProxy.js"))["proxyBlockedReason"];
let verifyOutboundDispatcher: (typeof import("../src/services/socksProxy.js"))["verifyOutboundDispatcher"];
let outboundDispatcherCheck: (typeof import("../src/services/socksProxy.js"))["outboundDispatcherCheck"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let originalDispatcher: unknown;
let counter = 0;
let local: http.Server;
let localPort = 0;

/** A fresh text each call: the module skips an apply whose settings it has already applied. */
const uniqueBadUrl = () => `not a url at all ${++counter}`;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ applySocksProxySetting, proxyBlockedReason, verifyOutboundDispatcher, outboundDispatcherCheck } = await import("../src/services/socksProxy.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  originalDispatcher = getGlobalDispatcher();
  local = http.createServer((_req, res) => res.end("local ok"));
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  localPort = (local.address() as { port: number }).port;
});

afterEach(() => {
  setSetting("socks5ProxyUrl", "");
  setSetting("proxyBypassFilter", "");
  setSetting("proxyBypassLocal", "1");
  setSetting("tlsRejectUnauthorized", "1");
  applySocksProxySetting();
});

afterAll(async () => {
  setGlobalDispatcher(originalDispatcher as any);
  await new Promise<void>((resolve) => local.close(() => resolve()));
});

describe("a proxy that is set but unusable fails closed (round 30d)", () => {
  it("refuses a request that needs the proxy instead of sending it out directly", async () => {
    setSetting("socks5ProxyUrl", uniqueBadUrl());
    applySocksProxySetting();

    expect(proxyBlockedReason()).toMatch(/proxy address/);
    // .invalid never resolves: reaching DNS would mean the request went out directly. The refusal comes first.
    const error = await fetch("http://outside.example.invalid:8999/", { signal: AbortSignal.timeout(5000) }).catch((e) => e);
    const reason = `${error?.message} ${error?.cause?.message ?? ""}`;
    expect(reason).toMatch(/Outbound request refused/);
  });

  it("still reaches a local server directly", async () => {
    setSetting("socks5ProxyUrl", uniqueBadUrl());
    applySocksProxySetting();

    const res = await fetch(`http://127.0.0.1:${localPort}/`);
    expect(await res.text()).toBe("local ok");
  });

  it("still sends a host on the bypass list out directly", async () => {
    setSetting("socks5ProxyUrl", uniqueBadUrl());
    setSetting("proxyBypassFilter", "127.0.0.1");
    setSetting("proxyBypassLocal", "0");
    applySocksProxySetting();

    const res = await fetch(`http://127.0.0.1:${localPort}/`);
    expect(await res.text()).toBe("local ok");
  });

  it("refuses a local host too when local addresses are not exempt from the proxy", async () => {
    setSetting("socks5ProxyUrl", uniqueBadUrl());
    setSetting("proxyBypassLocal", "0");
    applySocksProxySetting();

    const error = await fetch(`http://127.0.0.1:${localPort}/`).catch((e) => e);
    expect(`${error?.message} ${error?.cause?.message ?? ""}`).toMatch(/Outbound request refused/);
  });

  it("goes back to direct requests once the setting is cleared", async () => {
    setSetting("socks5ProxyUrl", uniqueBadUrl());
    applySocksProxySetting();
    expect(proxyBlockedReason()).not.toBeNull();

    setSetting("socks5ProxyUrl", "");
    applySocksProxySetting();

    expect(proxyBlockedReason()).toBeNull();
    expect(getGlobalDispatcher()).toBe(originalDispatcher);
  });

  it("reports a wrong scheme as unusable too", async () => {
    setSetting("socks5ProxyUrl", `ftp://proxy-${++counter}.example.com:21`);
    applySocksProxySetting();
    expect(proxyBlockedReason()).toMatch(/must start with/);
  });
});

describe("a stored proxy address that cannot be decrypted (round 30d)", () => {
  it("is told apart from no proxy at all", async () => {
    const { loadSettingsCache, isSettingUndecryptable } = await import("../src/services/settingsStore.js");
    await db.prepare("INSERT INTO settings (key, value) VALUES ('socks5ProxyUrl', 'enc1:AAAAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    await loadSettingsCache();

    expect(isSettingUndecryptable("socks5ProxyUrl")).toBe(true);
    applySocksProxySetting();
    expect(proxyBlockedReason()).toMatch(/could not be decrypted/);
    const error = await fetch("http://outside.example.invalid:8999/", { signal: AbortSignal.timeout(5000) }).catch((e) => e);
    expect(`${error?.message} ${error?.cause?.message ?? ""}`).toMatch(/Outbound request refused/);

    // Entering the address again is the admin's own value.
    setSetting("socks5ProxyUrl", "");
    expect(isSettingUndecryptable("socks5ProxyUrl")).toBe(false);
    applySocksProxySetting();
    expect(proxyBlockedReason()).toBeNull();
  });
});

describe("verifyOutboundDispatcher (round 30d)", () => {
  it("passes when fetch goes through the installed dispatcher", async () => {
    setSetting("socks5ProxyUrl", "");
    setSetting("tlsRejectUnauthorized", "0");
    applySocksProxySetting();

    expect(await verifyOutboundDispatcher()).toBe(true);
    expect(outboundDispatcherCheck()).toMatchObject({ ok: true });
  });

  it("fails when something else took over the global dispatcher", async () => {
    setSetting("tlsRejectUnauthorized", "local");
    applySocksProxySetting();
    const router = getGlobalDispatcher();
    setGlobalDispatcher(new Agent());
    try {
      // The router stays "installed" in the module, but fetch no longer reaches it.
      expect(await verifyOutboundDispatcher()).toBe(false);
      expect(outboundDispatcherCheck()).toMatchObject({ ok: false });
    } finally {
      setGlobalDispatcher(router);
    }
  });

  it("has nothing to check while no dispatcher is installed", async () => {
    setSetting("tlsRejectUnauthorized", "1");
    setSetting("socks5ProxyUrl", "");
    applySocksProxySetting();

    expect(await verifyOutboundDispatcher()).toBe(true);
    expect(outboundDispatcherCheck()).toBeNull();
  });
});
