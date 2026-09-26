import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

// Regression coverage for POST/PATCH /api/custom-formats' own validation+normalization layer
// (validateAndNormalizeGroups in routes/customFormats.ts) — a condition type can be fully wired up
// in the scoring engine (customFormatScoring.ts) and the web DSL and still get silently mangled
// here, since this function has its own independent per-type switch that has to be kept in sync by
// hand. A real bug of exactly this shape shipped in Round 346: edition/qualityModifier/releaseType
// worked in formatMatches() unit tests (which call it directly, bypassing this route) but the HTTP
// route's own normalization pass fell through to its `title` default for all three, silently
// dropping qualityModifiers/releaseTypes and turning `edition` into a plain title condition.
describe("POST /api/custom-formats — validateAndNormalizeGroups", () => {
  beforeAll(async () => {
    ({ app, apiKey, db } = await setupTestDb());
  });

  it("accepts and round-trips an edition condition group unchanged", async () => {
    const res = await request(app)
      .post("/api/custom-formats")
      .set("X-Api-Key", apiKey)
      .send({ name: "Edition CF", conditionGroups: [{ type: "edition", patterns: ["criterion"], negate: false }] });
    expect(res.status).toBe(201);
    expect(res.body.conditionGroups).toEqual([{ type: "edition", patterns: ["criterion"], negate: false }]);
  });

  it("accepts and round-trips a qualityModifier condition group, lowercasing its values", async () => {
    const res = await request(app)
      .post("/api/custom-formats")
      .set("X-Api-Key", apiKey)
      .send({ name: "QualityModifier CF", conditionGroups: [{ type: "qualityModifier", qualityModifiers: ["Screener"], negate: false }] });
    expect(res.status).toBe(201);
    expect(res.body.conditionGroups).toEqual([{ type: "qualityModifier", qualityModifiers: ["screener"], negate: false }]);
  });

  it("accepts and round-trips a releaseType condition group, lowercasing its values", async () => {
    const res = await request(app)
      .post("/api/custom-formats")
      .set("X-Api-Key", apiKey)
      .send({ name: "ReleaseType CF", conditionGroups: [{ type: "releaseType", releaseTypes: ["seasonPack"], negate: false }] });
    expect(res.status).toBe(201);
    expect(res.body.conditionGroups).toEqual([{ type: "releaseType", releaseTypes: ["seasonpack"], negate: false }]);
  });

  it("rejects a qualityModifier condition with an unrecognized value", async () => {
    const res = await request(app)
      .post("/api/custom-formats")
      .set("X-Api-Key", apiKey)
      .send({ name: "Bad QM", conditionGroups: [{ type: "qualityModifier", qualityModifiers: ["not-a-real-one"], negate: false }] });
    expect(res.status).toBe(400);
  });

  it("rejects a releaseType condition with an unrecognized value", async () => {
    const res = await request(app)
      .post("/api/custom-formats")
      .set("X-Api-Key", apiKey)
      .send({ name: "Bad RT", conditionGroups: [{ type: "releaseType", releaseTypes: ["not-a-real-one"], negate: false }] });
    expect(res.status).toBe(400);
  });

  it("accepts the extended source vocabulary (Cam/Telesync/Telecine/Workprint)", async () => {
    const res = await request(app)
      .post("/api/custom-formats")
      .set("X-Api-Key", apiKey)
      .send({ name: "Extended Source CF", conditionGroups: [{ type: "source", sources: ["Cam", "Telesync", "Telecine", "Workprint"], negate: false }] });
    expect(res.status).toBe(201);
    expect(res.body.conditionGroups[0].sources).toEqual(["Cam", "Telesync", "Telecine", "Workprint"]);
  });

  it("PATCH runs the same normalization — edition/qualityModifier/releaseType groups survive an edit instead of collapsing to title", async () => {
    const created = await request(app)
      .post("/api/custom-formats")
      .set("X-Api-Key", apiKey)
      .send({ name: "Patched CF", conditionGroups: [{ type: "title", patterns: ["x265"], negate: false }] });
    expect(created.status).toBe(201);

    const res = await request(app)
      .patch(`/api/custom-formats/${created.body.id}`)
      .set("X-Api-Key", apiKey)
      .send({
        conditionGroups: [
          { type: "edition", patterns: ["criterion"], negate: true },
          { type: "qualityModifier", qualityModifiers: ["BRDISK"], negate: false },
          { type: "releaseType", releaseTypes: ["Multi"], negate: false },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.conditionGroups).toEqual([
      { type: "edition", patterns: ["criterion"], negate: true },
      { type: "qualityModifier", qualityModifiers: ["brdisk"], negate: false },
      { type: "releaseType", releaseTypes: ["multi"], negate: false },
    ]);
  });

  it("rejects a resolution outside the vocabulary", async () => {
    const res = await request(app)
      .post("/api/custom-formats")
      .set("X-Api-Key", apiKey)
      .send({ name: "Bad Resolution CF", conditionGroups: [{ type: "resolution", resolutions: ["540p"], negate: false }] });
    expect(res.status).toBe(400);
  });

  it("accepts the extended resolution vocabulary (480p/576p)", async () => {
    const res = await request(app)
      .post("/api/custom-formats")
      .set("X-Api-Key", apiKey)
      .send({ name: "Extended Resolution CF", conditionGroups: [{ type: "resolution", resolutions: ["480p", "576p"] as any, negate: false }] });
    expect(res.status).toBe(201);
    expect(res.body.conditionGroups[0].resolutions).toEqual(["480p", "576p"]);
  });

  it("a releaseType condition saved via the route actually matches through the real scoring pipeline (case-insensitivity regression)", async () => {
    const created = await request(app)
      .post("/api/custom-formats")
      .set("X-Api-Key", apiKey)
      .send({ name: "Season Pack CF", conditionGroups: [{ type: "releaseType", releaseTypes: ["seasonPack"], negate: false }] });
    expect(created.status).toBe(201);

    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    const seasonPack = await scoreRelease("Show.Name.S03.1080p-GROUP", null, null, "series");
    expect(seasonPack.matches.map((m: any) => m.name)).toContain("Season Pack CF");
    const singleEp = await scoreRelease("Show.Name.S03E01.1080p-GROUP", null, null, "series");
    expect(singleEp.matches.map((m: any) => m.name)).not.toContain("Season Pack CF");
  });
});

describe("GET /api/custom-formats/trash-sync/status", () => {
  beforeAll(async () => {
    // Runnable on its own (-t "trash-sync/status"), not only after the block above set these up.
    if (!app) ({ app, apiKey, db } = await setupTestDb());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns each app's stored sync result once a sync started through the route has finished", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.github.com/")) {
          return { ok: true, json: async () => [{ name: "status.json", download_url: "https://raw/status.json", type: "file" }] } as any;
        }
        return {
          ok: true,
          json: async () => ({
            trash_id: "status-route-1",
            name: "Status Route Format",
            specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "FLUX" } }],
          }),
        } as any;
      })
    );

    const started = await request(app).post("/api/custom-formats/trash-sync").set("X-Api-Key", apiKey).send({ app: "radarr" });
    expect(started.body).toEqual({ started: true, alreadyRunning: false });

    const status = await vi.waitFor(async () => {
      const res = await request(app).get("/api/custom-formats/trash-sync/status").set("X-Api-Key", apiKey);
      expect(res.status).toBe(200);
      expect(res.body.radarr).not.toBeNull();
      return res.body;
    });
    expect(status.radarr).toMatchObject({ app: "radarr", added: 1, updated: 0, unsupported: [], failed: [], error: null });
    expect(Number.isNaN(Date.parse(status.radarr.finishedAt))).toBe(false);
    expect(status.sonarr).toBeNull();
  });

  it("returns null for an app whose stored result is unreadable", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("trashSyncLastResultSonarr", "{not json");

    const res = await request(app).get("/api/custom-formats/trash-sync/status").set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.sonarr).toBeNull();
  });

  it("is admin-only", async () => {
    const { createSession, hashPassword } = await import("../src/services/auth.js");
    const userId = Number(
      (
        await db
          .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')")
          .run("trash-status-household", hashPassword("x"))
      ).lastInsertRowid
    );
    const { token } = await createSession(userId);

    const res = await request(app).get("/api/custom-formats/trash-sync/status").set("X-Session-Token", token);
    expect(res.status).toBe(403);
  });

  it("joins a sync that is already running instead of starting a second one, and reports it as running", async () => {
    let releaseListing!: () => void;
    const listingGate = new Promise<void>((resolve) => (releaseListing = resolve));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.github.com/")) {
        await listingGate;
        return { ok: true, json: async () => [] } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await request(app).post("/api/custom-formats/trash-sync").set("X-Api-Key", apiKey).send({ app: "sonarr" });
    const second = await request(app).post("/api/custom-formats/trash-sync").set("X-Api-Key", apiKey).send({ app: "sonarr" });
    expect(first.body).toEqual({ started: true, alreadyRunning: false });
    expect(second.body).toEqual({ started: false, alreadyRunning: true });
    const during = await request(app).get("/api/custom-formats/trash-sync/status").set("X-Api-Key", apiKey);
    expect(during.body.running).toEqual({ radarr: false, sonarr: true });

    releaseListing();
    await vi.waitFor(async () => {
      const res = await request(app).get("/api/custom-formats/trash-sync/status").set("X-Api-Key", apiKey);
      expect(res.body.running.sonarr).toBe(false);
    });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("https://api.github.com/"))).toHaveLength(1);
  });
});
