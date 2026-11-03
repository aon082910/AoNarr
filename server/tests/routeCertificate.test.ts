import { describe, it, expect } from "vitest";
import { planRoute, type CertificateMode, type RoutePolicy } from "../src/services/outboundRouting.js";

function verifies(host: string, certificates: CertificateMode): boolean {
  const policy: RoutePolicy = { hasProxy: false, bypassLocal: true, filter: [], certificates };
  return planRoute(host, policy).verifyCertificate;
}

describe("planRoute verifyCertificate", () => {
  it("is on everywhere in enabled mode", () => {
    expect(verifies("example.com", "enabled")).toBe(true);
    expect(verifies("192.168.1.5", "enabled")).toBe(true);
  });

  it("is off everywhere in disabled mode", () => {
    expect(verifies("example.com", "disabled")).toBe(false);
    expect(verifies("192.168.1.5", "disabled")).toBe(false);
  });

  it("is off only for local hosts in local mode", () => {
    expect(verifies("example.com", "local")).toBe(true);
    expect(verifies("192.168.1.5", "local")).toBe(false);
    expect(verifies("radarr", "local")).toBe(false);
  });
});
