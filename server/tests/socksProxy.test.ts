import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { setupTestDb } from "./helpers/testDb.js";

let applySocksProxySetting: (typeof import("../src/services/socksProxy.js"))["applySocksProxySetting"];
let setSetting: (key: string, value: string) => void;
let originalDispatcher: unknown;
let uniqueCounter = 0;

/** A fresh hostname per call, guaranteeing a signature the module has never seen before — the
 * source memoizes on a signature string built from (url, rejectUnauthorized) and short-circuits on
 * a repeat, and that internal `appliedSignature` isn't reset between tests (it's module-private
 * state, not exported), so reusing a URL across tests would make a later test's call silently
 * no-op instead of actually exercising the code path being tested. */
function uniqueProxyUrl(): string {
  uniqueCounter++;
  return `socks5://proxy-${uniqueCounter}.example.com:1080`;
}

beforeAll(async () => {
  await setupTestDb();
  ({ applySocksProxySetting } = await import("../src/services/socksProxy.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  originalDispatcher = getGlobalDispatcher();
});

afterEach(() => {
  setSetting("socks5ProxyUrl", "");
  setSetting("tlsRejectUnauthorized", "1");
});

afterAll(() => {
  setGlobalDispatcher(originalDispatcher as any);
});

describe("applySocksProxySetting", () => {
  it("restores the true default dispatcher when the proxy URL is cleared", () => {
    // Two calls within the same test: the first (a fresh, never-before-seen URL) is guaranteed to
    // actually proceed and move the dispatcher away from default; the second (clearing the URL)
    // then has a signature guaranteed different from the first, so it's guaranteed to proceed too
    // — regardless of what any earlier test in this file already did.
    setSetting("socks5ProxyUrl", uniqueProxyUrl());
    applySocksProxySetting();
    expect(getGlobalDispatcher()).not.toBe(originalDispatcher);

    setSetting("socks5ProxyUrl", "");
    applySocksProxySetting();

    expect(getGlobalDispatcher()).toBe(originalDispatcher);
  });

  it("installs a cert-validation-disabled agent when no proxy is set but TLS validation is off", () => {
    const before = getGlobalDispatcher();
    setSetting("socks5ProxyUrl", "");
    setSetting("tlsRejectUnauthorized", "0");

    applySocksProxySetting();

    expect(getGlobalDispatcher()).not.toBe(before);
  });

  it("leaves the dispatcher untouched and doesn't throw for an unparseable proxy URL", () => {
    const before = getGlobalDispatcher();
    setSetting("socks5ProxyUrl", "not a url at all " + uniqueProxyUrl());

    expect(() => applySocksProxySetting()).not.toThrow();
    expect(getGlobalDispatcher()).toBe(before);
  });

  it("leaves the dispatcher untouched and doesn't throw for a URL with the wrong protocol", () => {
    const before = getGlobalDispatcher();
    setSetting("socks5ProxyUrl", `http://not-a-socks-proxy-${uniqueCounter++}.example.com:8080`);

    expect(() => applySocksProxySetting()).not.toThrow();
    expect(getGlobalDispatcher()).toBe(before);
  });

  it("installs a new agent for a valid socks5:// proxy URL", () => {
    const before = getGlobalDispatcher();
    setSetting("socks5ProxyUrl", uniqueProxyUrl().replace("socks5://", "socks5://user:pass@"));

    applySocksProxySetting();

    expect(getGlobalDispatcher()).not.toBe(before);
  });

  it("does not reinstall the dispatcher on a repeated call with unchanged settings", () => {
    const url = uniqueProxyUrl();
    setSetting("socks5ProxyUrl", url);
    applySocksProxySetting();
    const firstDispatcher = getGlobalDispatcher();

    applySocksProxySetting(); // same settings as the call above, nothing changed in between

    expect(getGlobalDispatcher()).toBe(firstDispatcher);
  });

  it("installs a genuinely new dispatcher when the proxy URL setting changes", () => {
    setSetting("socks5ProxyUrl", uniqueProxyUrl());
    applySocksProxySetting();
    const firstDispatcher = getGlobalDispatcher();

    setSetting("socks5ProxyUrl", uniqueProxyUrl());
    applySocksProxySetting();

    expect(getGlobalDispatcher()).not.toBe(firstDispatcher);
  });

  it("accepts the bare socks:// scheme as well as socks5://", () => {
    const before = getGlobalDispatcher();
    setSetting("socks5ProxyUrl", uniqueProxyUrl().replace("socks5://", "socks://"));

    applySocksProxySetting();

    expect(getGlobalDispatcher()).not.toBe(before);
  });
});
