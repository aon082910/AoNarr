import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import { guardedLocalLookup, planRoute, RefusingDispatcher, type RoutePolicy } from "../src/services/outboundRouting.js";
import { parseBypassFilter } from "../src/services/networkAddress.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const policy = (over: Partial<RoutePolicy> = {}): RoutePolicy => ({ hasProxy: false, bypassLocal: true, filter: [], certificates: "local", ...over });

describe("planRoute: the lookup guard for local names (round 30d)", () => {
  it("guards a local NAME when the certificate check is skipped for local hosts", () => {
    expect(planRoute("nas.lan", policy())).toMatchObject({ viaProxy: false, verifyCertificate: false, guardName: true });
    expect(planRoute("unraid", policy())).toMatchObject({ verifyCertificate: false, guardName: true });
  });

  it("does not guard an IP address: the text says it all", () => {
    expect(planRoute("192.168.1.5", policy())).toMatchObject({ verifyCertificate: false, guardName: false });
    expect(planRoute("[fd00::5]", policy())).toMatchObject({ verifyCertificate: false, guardName: false });
  });

  it("checks the certificate of a public host and does not guard it", () => {
    expect(planRoute("example.com", policy())).toMatchObject({ verifyCertificate: true, guardName: false });
  });

  it("does not guard a local name when nothing skips the certificate and no proxy is in use", () => {
    expect(planRoute("nas.lan", policy({ certificates: "enabled" }))).toMatchObject({ verifyCertificate: true, guardName: false });
    expect(planRoute("nas.lan", policy({ certificates: "disabled" }))).toMatchObject({ verifyCertificate: false, guardName: false });
  });

  it("guards a name that goes out directly only because it looks local while a proxy is in use, whatever the certificate setting", () => {
    for (const certificates of ["enabled", "local", "disabled"] as const) {
      expect(planRoute("nas.lan", policy({ hasProxy: true, certificates })).guardName).toBe(true);
    }
  });

  it("does not guard a name the admin put on the bypass list himself", () => {
    const filter = parseBypassFilter("nas.lan");
    expect(planRoute("nas.lan", policy({ hasProxy: true, certificates: "enabled", filter })).guardName).toBe(false);
  });

  it("checks the certificate of a local name that is sent through the proxy, because the proxy looks it up", () => {
    const route = planRoute("nas.lan", policy({ hasProxy: true, bypassLocal: false }));
    expect(route).toMatchObject({ viaProxy: true, verifyCertificate: true, guardName: false });
    // An IP address needs no lookup, so the local rule still holds for it.
    expect(planRoute("192.168.1.5", policy({ hasProxy: true, bypassLocal: false }))).toMatchObject({ viaProxy: true, verifyCertificate: false });
  });
});

type LookupCallback = (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void;

function stubLookup(addresses: dns.LookupAddress[] | Error): void {
  vi.spyOn(dns, "lookup").mockImplementation(((_host: string, _options: unknown, callback: LookupCallback) => {
    if (addresses instanceof Error) callback(addresses as NodeJS.ErrnoException, []);
    else callback(null, addresses);
  }) as any);
}

function lookup(options: unknown): Promise<{ error: Error | null; result: unknown[] }> {
  return new Promise((resolve) => guardedLocalLookup("nas.lan", options, (error: Error | null, ...result: unknown[]) => resolve({ error, result })));
}

describe("guardedLocalLookup (round 30d)", () => {
  it("answers with a local address", async () => {
    stubLookup([{ address: "192.168.1.5", family: 4 }]);
    expect(await lookup({})).toEqual({ error: null, result: ["192.168.1.5", 4] });
  });

  it("answers with the list when the caller asked for all addresses", async () => {
    stubLookup([{ address: "192.168.1.5", family: 4 }, { address: "fd00::5", family: 6 }]);
    const { error, result } = await lookup({ all: true });
    expect(error).toBeNull();
    expect(result[0]).toEqual([{ address: "192.168.1.5", family: 4 }, { address: "fd00::5", family: 6 }]);
  });

  it("refuses a name that leads to a public address, and names that address", async () => {
    stubLookup([{ address: "203.0.113.9", family: 4 }]);
    const { error } = await lookup({});
    expect(error?.message).toContain("203.0.113.9");
    expect(error?.message).toContain("nas.lan");
  });

  it("uses the private address of a name that also has a public one (a router adds a global IPv6 address)", async () => {
    stubLookup([{ address: "2001:db8::5", family: 6 }, { address: "192.168.1.5", family: 4 }]);
    expect(await lookup({})).toEqual({ error: null, result: ["192.168.1.5", 4] });
    const all = await lookup({ all: true });
    expect(all.result[0]).toEqual([{ address: "192.168.1.5", family: 4 }]);
  });

  it("passes a lookup error on unchanged", async () => {
    const failure = Object.assign(new Error("getaddrinfo ENOTFOUND nas.lan"), { code: "ENOTFOUND" });
    stubLookup(failure);
    expect((await lookup({})).error).toBe(failure);
  });
});

describe("RefusingDispatcher (round 30d)", () => {
  const options = { origin: "http://example.com", path: "/", method: "GET" } as any;

  it("tells the handler about an error with a code and the reason, and not before dispatch returns", async () => {
    const dispatcher = new RefusingDispatcher("Outbound request refused: the proxy address is bad");
    const received: any[] = [];
    const handler = { onError: (err: Error) => received.push(err) } as any;

    expect(dispatcher.dispatch(options, handler)).toBe(true);
    expect(received).toHaveLength(0);
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0].message).toBe("Outbound request refused: the proxy address is bad");
    expect(received[0].code).toBe("AONARR_PROXY_UNUSABLE");
  });

  it("calls the refusal callback for every refused request", async () => {
    const onRefuse = vi.fn();
    const dispatcher = new RefusingDispatcher("no", onRefuse);
    dispatcher.dispatch(options, { onError: () => {} } as any);
    dispatcher.dispatch(options, { onError: () => {} } as any);
    await Promise.resolve();
    expect(onRefuse).toHaveBeenCalledTimes(2);
  });

  it("does not turn a handler that throws into an uncaught exception", async () => {
    const dispatcher = new RefusingDispatcher("no");
    const uncaught = vi.fn();
    process.once("uncaughtException", uncaught);
    dispatcher.dispatch(options, {
      onError: () => {
        throw new Error("handler broke");
      },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("uncaughtException", uncaught);
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("closes and destroys without a connection to close", async () => {
    const dispatcher = new RefusingDispatcher("no");
    await expect(dispatcher.close()).resolves.toBeUndefined();
    await expect(dispatcher.destroy()).resolves.toBeUndefined();
    const closed = vi.fn();
    dispatcher.close(closed);
    expect(closed).toHaveBeenCalledOnce();
  });
});
