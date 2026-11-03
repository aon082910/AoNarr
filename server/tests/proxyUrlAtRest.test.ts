import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let settings: typeof import("../src/services/settingsStore.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  settings = await import("../src/services/settingsStore.js");
});

describe("the proxy URL carries a password, so it is stored encrypted (ST1)", () => {
  it("keeps the credentials out of the settings table, and reads them back whole", async () => {
    const url = "socks5://vpnuser:s3cretpass@proxy.example.com:1080";
    settings.setSetting("socks5ProxyUrl", url);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = (await db.prepare("SELECT value FROM settings WHERE key = 'socks5ProxyUrl'").get()) as { value: string };

    expect(row.value).not.toContain("s3cretpass");
    expect(row.value).not.toContain("vpnuser");
    expect(settings.getSetting("socks5ProxyUrl")).toBe(url);
  });

  it("does not encrypt the bypass list, which is not a credential", async () => {
    settings.setSetting("proxyBypassFilter", "nas.example.com, *.corp.example");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = (await db.prepare("SELECT value FROM settings WHERE key = 'proxyBypassFilter'").get()) as { value: string };

    expect(row.value).toBe("nas.example.com, *.corp.example");
  });
});
