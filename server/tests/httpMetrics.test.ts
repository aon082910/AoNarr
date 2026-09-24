import { describe, it, expect } from "vitest";
import { recordHttpRequest, getHttpMetricsSamples } from "../src/services/httpMetrics.js";

describe("httpMetrics", () => {
  it("aggregates count/errorCount/avgDurationMs per method+route", () => {
    recordHttpRequest("GET", "/api/media/:id", 200, 10);
    recordHttpRequest("GET", "/api/media/:id", 200, 20);
    recordHttpRequest("GET", "/api/media/:id", 500, 30);

    const sample = getHttpMetricsSamples().find((s) => s.method === "GET" && s.route === "/api/media/:id");
    expect(sample).toBeDefined();
    expect(sample!.count).toBe(3);
    expect(sample!.errorCount).toBe(1);
    expect(sample!.avgDurationMs).toBe(20);
  });

  it("keeps different routes and different methods on the same route separate", () => {
    recordHttpRequest("POST", "/api/media", 201, 5);
    recordHttpRequest("GET", "/api/media", 200, 15);

    const samples = getHttpMetricsSamples();
    const post = samples.find((s) => s.method === "POST" && s.route === "/api/media");
    const get = samples.find((s) => s.method === "GET" && s.route === "/api/media");
    expect(post!.count).toBe(1);
    expect(get!.count).toBe(1);
  });

  it("only counts 5xx responses as errors, not 4xx", () => {
    recordHttpRequest("GET", "/api/four-oh-four-only", 404, 1);
    const sample = getHttpMetricsSamples().find((s) => s.route === "/api/four-oh-four-only");
    expect(sample!.count).toBe(1);
    expect(sample!.errorCount).toBe(0);
  });
});

// One app for every test below — setupTestDb() points config at a fresh dir, which only takes
// effect on the first import of src/config.ts.
let testAppPromise: ReturnType<typeof setupApp> | undefined;
async function setupApp() {
  const { setupTestDb } = await import("./helpers/testDb.js");
  return setupTestDb();
}
function testApp() {
  testAppPromise ??= setupApp();
  return testAppPromise;
}

// A request no route matched (a 401 from requireAuth, a 404) has no req.route; recording its raw
// path let any unauthenticated client grow the never-pruned metrics map one junk URL at a time.
describe("app request hook", () => {
  it("records unmatched requests under '<unmatched>' and matched ones under their route pattern", async () => {
    const { app, apiKey } = await testApp();
    const request = (await import("supertest")).default;

    expect((await request(app).get("/api/no-such-route-unauthenticated")).status).toBe(401);
    expect((await request(app).get("/api/no-such-route-authenticated").set("X-Api-Key", apiKey)).status).toBe(404);
    expect((await request(app).get("/api/tags").set("X-Api-Key", apiKey)).status).toBe(200);
    await new Promise((r) => setImmediate(r));

    const samples = getHttpMetricsSamples();
    expect(samples.some((s) => s.route.includes("no-such-route"))).toBe(false);
    expect(samples.find((s) => s.method === "GET" && s.route === "<unmatched>")?.count).toBeGreaterThanOrEqual(2);
    expect(samples.some((s) => s.method === "GET" && s.route.startsWith("/api/tags"))).toBe(true);
  });
});

// The template import route takes a 10mb body; parsing it before auth let any unauthenticated
// client make the server buffer and JSON.parse up to 10mb per request before getting its 401.
describe("POST /api/settings/template/import body parsing", () => {
  const malformed = '{"customFormats": [' + "x".repeat(200 * 1024);

  it("rejects an unauthenticated request before parsing its body", async () => {
    const { app } = await testApp();
    const request = (await import("supertest")).default;
    const res = await request(app).post("/api/settings/template/import").set("Content-Type", "application/json").send(malformed);
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin session before parsing its body", async () => {
    const { app, db } = await testApp();
    const request = (await import("supertest")).default;
    const { createSession, hashPassword } = await import("../src/services/auth.js");
    const userId = Number(
      (await db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('template-household', ?, 'user')`).run(hashPassword("x")))
        .lastInsertRowid
    );
    const { token } = await createSession(userId);

    const res = await request(app)
      .post("/api/settings/template/import")
      .set("X-Session-Token", token)
      .set("Content-Type", "application/json")
      .send(malformed);
    expect(res.status).toBe(403);
  });

  it("still parses an admin's body with the raised limit", async () => {
    const { app, apiKey } = await testApp();
    const request = (await import("supertest")).default;
    const res = await request(app)
      .post("/api/settings/template/import")
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .send(malformed);
    // A malformed-JSON 400 (not a 413) proves the 10mb parser, not the 100kb default, read it.
    expect(res.status).toBe(400);
  });
});
