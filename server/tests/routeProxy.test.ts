import { describe, it, expect } from "vitest";
import { parseBypassFilter } from "../src/services/networkAddress.js";
import { planRoute, type RoutePolicy } from "../src/services/outboundRouting.js";

const base: RoutePolicy = { hasProxy: true, bypassLocal: true, filter: [], certificates: "enabled" };

describe("planRoute viaProxy", () => {
  it("goes direct for local hosts and through the proxy for the rest", () => {
    expect(planRoute("192.168.1.205", base).viaProxy).toBe(false);
    expect(planRoute("127.0.0.1", base).viaProxy).toBe(false);
    expect(planRoute("qbittorrent", base).viaProxy).toBe(false);
    expect(planRoute("api.themoviedb.org", base).viaProxy).toBe(true);
  });

  it("uses the proxy for local hosts when that switch is off", () => {
    expect(planRoute("192.168.1.205", { ...base, bypassLocal: false }).viaProxy).toBe(true);
  });

  it("goes direct for a host on the list", () => {
    expect(planRoute("tracker.example.com", { ...base, filter: parseBypassFilter("*.example.com") }).viaProxy).toBe(false);
  });

  it("is never proxied when no proxy is set", () => {
    expect(planRoute("api.themoviedb.org", { ...base, hasProxy: false }).viaProxy).toBe(false);
  });
});
