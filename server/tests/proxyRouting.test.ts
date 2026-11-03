import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { setupTestDb } from "./helpers/testDb.js";

// A SOCKS5 server that only records the host each client asks to reach, then refuses the connection.
function startFakeSocks(): Promise<{ port: number; asked: string[]; stop: () => void }> {
  const asked: string[] = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write(Buffer.from([5, 0]));
      socket.once("data", (request) => {
        const kind = request[3];
        const host = kind === 1 ? [...request.subarray(4, 8)].join(".") : kind === 3 ? request.subarray(5, 5 + request[4]).toString() : "ipv6";
        asked.push(host);
        socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, asked, stop: () => server.close() })));
}

// An HTTP proxy that records each CONNECT target and answers 502.
function startFakeHttpProxy(): Promise<{ port: number; asked: string[]; stop: () => void }> {
  const asked: string[] = [];
  const server = http.createServer();
  server.on("connect", (req, socket) => {
    asked.push(String(req.url));
    socket.on("error", () => {});
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, asked, stop: () => server.close() })));
}

let setSetting: (key: string, value: string) => void;
let applySocksProxySetting: () => void;
let originalDispatcher: unknown;
let socks: Awaited<ReturnType<typeof startFakeSocks>>;
let web: http.Server;
let webPort: number;

beforeAll(async () => {
  await setupTestDb();
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ applySocksProxySetting } = await import("../src/services/socksProxy.js"));
  originalDispatcher = getGlobalDispatcher();
  socks = await startFakeSocks();
  web = http.createServer((_req, res) => res.end("reached directly"));
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", () => resolve()));
  webPort = (web.address() as AddressInfo).port;
});

afterAll(() => {
  setSetting("socks5ProxyUrl", "");
  setSetting("proxyBypassLocal", "");
  setSetting("proxyBypassFilter", "");
  setGlobalDispatcher(originalDispatcher as any);
  socks.stop();
  web.close();
});

function useProxy(settings: Record<string, string>): void {
  for (const [key, value] of Object.entries(settings)) setSetting(key, value);
  applySocksProxySetting();
  socks.asked.length = 0;
}

describe("a SOCKS proxy and the local network (ST1)", () => {
  it("reaches a local server directly, without asking the proxy", async () => {
    useProxy({ socks5ProxyUrl: `socks5://127.0.0.1:${socks.port}`, proxyBypassLocal: "1", proxyBypassFilter: "" });

    const res = await fetch(`http://127.0.0.1:${webPort}/`);

    expect(await res.text()).toBe("reached directly");
    expect(socks.asked).toEqual([]);
  });

  it("sends a local address through the proxy when 'bypass local addresses' is off", async () => {
    useProxy({ proxyBypassLocal: "0" });

    await expect(fetch(`http://127.0.0.1:${webPort}/`)).rejects.toThrow();

    expect(socks.asked).toEqual(["127.0.0.1"]);
  });

  it("sends an outside host through the proxy", async () => {
    useProxy({ proxyBypassLocal: "1" });

    await expect(fetch("http://203.0.113.9/")).rejects.toThrow();

    expect(socks.asked).toEqual(["203.0.113.9"]);
  });

  it("keeps a host on the bypass list off the proxy", async () => {
    useProxy({ proxyBypassFilter: "" });
    await expect(fetch("http://svc.example-listed.invalid/")).rejects.toThrow();
    expect(socks.asked).toEqual(["svc.example-listed.invalid"]);

    useProxy({ proxyBypassFilter: "*.example-listed.invalid" });
    await expect(fetch("http://svc.example-listed.invalid/")).rejects.toThrow();
    expect(socks.asked).toEqual([]);
  });
});

describe("an HTTP proxy (ST1)", () => {
  it("tunnels an outside host through it and still reaches a local server directly", async () => {
    const proxy = await startFakeHttpProxy();
    try {
      useProxy({ socks5ProxyUrl: `http://127.0.0.1:${proxy.port}`, proxyBypassLocal: "1", proxyBypassFilter: "" });

      await expect(fetch("http://203.0.113.9/")).rejects.toThrow();
      expect(proxy.asked).toEqual(["203.0.113.9:80"]);

      proxy.asked.length = 0;
      const res = await fetch(`http://127.0.0.1:${webPort}/`);
      expect(await res.text()).toBe("reached directly");
      expect(proxy.asked).toEqual([]);
    } finally {
      proxy.stop();
    }
  });
});
