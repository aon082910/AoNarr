import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;

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
    ({ app, apiKey } = await setupTestDb());
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
