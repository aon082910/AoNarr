import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import { isKnownSettingKey, settingValueProblem } from "../src/services/settingsRegistry.js";

let app: Express;
let apiKey: string;

beforeAll(async () => {
  ({ app, apiKey } = await setupTestDb());
});

const put = (key: string, value: unknown) => request(app).put(`/api/settings/${encodeURIComponent(key)}`).set("X-Api-Key", apiKey).send({ value });

describe("localNetworks (round 30d)", () => {
  it("is a known setting", () => {
    expect(isKnownSettingKey("localNetworks")).toBe(true);
    expect(isKnownSettingKey("allowedHosts")).toBe(true);
  });

  it("accepts addresses and ranges of both families, and an empty value", () => {
    expect(settingValueProblem("localNetworks", "")).toBeNull();
    expect(settingValueProblem("localNetworks", "192.168.1.0/24, 10.0.0.0/8, fd12:3456::/48, ::1, 127.0.0.1")).toBeNull();
  });

  it("refuses a host name, naming what it takes", () => {
    expect(settingValueProblem("localNetworks", "nas.example.com")).toMatch(/IP addresses and ranges/);
  });

  it("refuses an entry that is not an address or has a bad prefix, and lists it", () => {
    const problem = settingValueProblem("localNetworks", "192.168.1.0/33, fd00::/200, 192.168.1.0/");
    expect(problem).toContain("192.168.1.0/33");
    expect(problem).toContain("fd00::/200");
    expect(problem).toContain("192.168.1.0/");
  });

  it("refuses a range so wide that most of the internet would be local (review H2)", () => {
    expect(settingValueProblem("localNetworks", "0.0.0.0/0")).toMatch(/too wide/);
    expect(settingValueProblem("localNetworks", "::/0")).toMatch(/too wide/);
    expect(settingValueProblem("localNetworks", "128.0.0.0/1")).toMatch(/too wide/);
    expect(settingValueProblem("localNetworks", "fd00::/6")).toMatch(/too wide/);
    // The largest private ranges are fine.
    expect(settingValueProblem("localNetworks", "10.0.0.0/8")).toBeNull();
    expect(settingValueProblem("localNetworks", "fc00::/7")).toBeNull();
    expect(settingValueProblem("localNetworks", "fd00::/8")).toBeNull();
  });

  it("is refused by the settings route with a 400, and saved when it is fine", async () => {
    expect((await put("localNetworks", "0.0.0.0/0")).status).toBe(400);
    expect((await put("localNetworks", "192.168.1.0/24")).status).toBe(200);
    expect((await put("localNetworks", "")).status).toBe(200);
  });
});

describe("allowedHosts (round 30d)", () => {
  it("accepts plain names, names with a port and wildcards in front of a domain", () => {
    expect(settingValueProblem("allowedHosts", "aonarr.example.com, nas.example.com:8443, *.home.example.com, .lab.example.org")).toBeNull();
  });

  it("refuses something that is not a host name", () => {
    expect(settingValueProblem("allowedHosts", "https://aonarr.example.com/path")).toMatch(/host names/);
  });

  it("refuses a wildcard that would accept names an attacker can register (review M5)", () => {
    for (const bad of ["*", "*.com", "*.duckdns.org", "*example.com", "*.*.*.*.example.com"]) {
      expect(settingValueProblem("allowedHosts", bad), bad).not.toBeNull();
    }
    expect(settingValueProblem("allowedHosts", "ok.example.com, *.com")).toContain("*.com");
  });

  it("is refused by the settings route with a 400", async () => {
    expect((await put("allowedHosts", "*.com")).status).toBe(400);
    expect((await put("allowedHosts", "aonarr.example.com")).status).toBe(200);
    expect((await put("allowedHosts", "")).status).toBe(200);
  });
});
