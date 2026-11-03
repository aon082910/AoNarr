import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let isLocalRequest: (typeof import("../src/middleware/auth.js"))["isLocalRequest"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ isLocalRequest } = await import("../src/middleware/auth.js"));
});

afterEach(() => {
  setSetting("authRequired", "");
  setSetting("metricsToken", "");
});

const fakeRequest = (peer: string, headers: Record<string, string> = {}) =>
  ({
    socket: { remoteAddress: peer },
    ip: peer,
    header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
  }) as any;

describe("isLocalRequest (ST17)", () => {
  it("a private peer is local", () => {
    expect(isLocalRequest(fakeRequest("192.168.1.20"))).toBe(true);
    expect(isLocalRequest(fakeRequest("::ffff:10.0.0.4"))).toBe(true);
    expect(isLocalRequest(fakeRequest("127.0.0.1"))).toBe(true);
  });

  it("a public peer is not", () => {
    expect(isLocalRequest(fakeRequest("8.8.8.8"))).toBe(false);
  });

  it("the real client the proxy names decides, when the proxy itself is on the LAN", () => {
    expect(isLocalRequest(fakeRequest("192.168.1.2", { "X-Real-IP": "203.0.113.9" }))).toBe(false);
    expect(isLocalRequest(fakeRequest("192.168.1.2", { "X-Real-IP": "192.168.1.50" }))).toBe(true);
  });

  it("a forwarded chain with any public address is not local, so a proxy on the LAN cannot open the instance to the internet", () => {
    expect(isLocalRequest(fakeRequest("192.168.1.2", { "X-Forwarded-For": "203.0.113.9, 192.168.1.2" }))).toBe(false);
    expect(isLocalRequest(fakeRequest("192.168.1.2", { "X-Forwarded-For": "192.168.1.60" }))).toBe(true);
  });
});

describe("Authentication Required: disabled for local addresses (ST17)", () => {
  it("requires a login by default", async () => {
    expect((await request(app as any).get("/api/tags")).status).toBe(401);
  });

  it("lets a local request in without a key, and still takes the key", async () => {
    setSetting("authRequired", "local");
    expect((await request(app as any).get("/api/tags")).status).toBe(200);
    expect((await request(app as any).get("/api/tags").set("X-Api-Key", apiKey)).status).toBe(200);
  });

  it("keeps asking for a login when the request was forwarded from outside", async () => {
    setSetting("authRequired", "local");
    const res = await request(app as any).get("/api/tags").set("X-Forwarded-For", "203.0.113.9");
    expect(res.status).toBe(401);
    expect((await request(app as any).get("/api/tags").set("X-Forwarded-For", "203.0.113.9").set("X-Api-Key", apiKey)).status).toBe(200);
  });

  it("a valid login keeps its own role on the home network: a restricted account is not made admin (M8)", async () => {
    const { createSession, hashPassword } = await import("../src/services/auth.js");
    const userId = Number((await db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('kid', ?, 'user')").run(hashPassword("x"))).lastInsertRowid);
    const { token } = await createSession(userId);
    setSetting("authRequired", "local");
    expect((await request(app as any).get("/api/tags")).status).toBe(200);
    expect((await request(app as any).get("/api/tags").set("X-Session-Token", token)).status).toBe(403);
  });

  it("the old switch still turns authentication off for everyone", async () => {
    setSetting("authRequired", "0");
    expect((await request(app as any).get("/api/tags").set("X-Forwarded-For", "203.0.113.9")).status).toBe(200);
  });

  it("the setting takes only the three values", async () => {
    const bad = await request(app as any).put("/api/settings/authRequired").set("X-Api-Key", apiKey).send({ value: "sometimes" });
    expect(bad.status).toBe(400);
    const ok = await request(app as any).put("/api/settings/authRequired").set("X-Api-Key", apiKey).send({ value: "local" });
    expect(ok.status).toBe(200);
  });
});

describe("the metrics token (ST17)", () => {
  it("is open when no token is set, as before", async () => {
    expect((await request(app as any).get("/api/metrics")).status).toBe(200);
  });

  it("asks for the token once one is set, and takes it as a bearer, a query value or the API key", async () => {
    setSetting("metricsToken", "scrape-secret");
    expect((await request(app as any).get("/api/metrics")).status).toBe(401);
    expect((await request(app as any).get("/api/metrics").set("Authorization", "Bearer wrong")).status).toBe(401);
    expect((await request(app as any).get("/api/metrics").set("Authorization", "Bearer scrape-secret")).status).toBe(200);
    expect((await request(app as any).get("/api/metrics?token=scrape-secret")).status).toBe(200);
    expect((await request(app as any).get("/api/metrics").set("X-Api-Key", apiKey)).status).toBe(200);
  });
});
