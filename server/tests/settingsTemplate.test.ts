import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function qualityLadder(): Promise<{ name: string; rank: number; min_size_mb: number | null; max_size_mb: number | null; preferred_size_mb: number | null }[]> {
  const rows = (await db.prepare("SELECT name, rank, min_size_mb, max_size_mb, preferred_size_mb FROM qualities ORDER BY rank").all()) as any[];
  return rows.map((r) => ({
    name: r.name,
    rank: Number(r.rank),
    min_size_mb: r.min_size_mb === null ? null : Number(r.min_size_mb),
    max_size_mb: r.max_size_mb === null ? null : Number(r.max_size_mb),
    preferred_size_mb: r.preferred_size_mb === null ? null : Number(r.preferred_size_mb),
  }));
}

describe("POST /api/settings/template/import", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("imports only naming* keys — a template can't flip authRequired, the API key, or any other setting", async () => {
    const { getSetting } = await import("../src/services/settingsStore.js");
    const authRequiredBefore = getSetting("authRequired");

    const res = await request(app)
      .post("/api/settings/template/import")
      .set("X-Api-Key", apiKey)
      .send({
        namingTemplates: {
          namingMovieTemplate: "{title} ({year})",
          authRequired: "0",
          apiKey: "attacker-known-key",
          socks5ProxyUrl: "socks5://attacker.example:1080",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.namingImported).toBe(1);
    expect(getSetting("namingMovieTemplate")).toBe("{title} ({year})");
    expect(getSetting("authRequired")).toBe(authRequiredBefore);
    expect(getSetting("apiKey")).toBe(apiKey);
    expect(getSetting("socks5ProxyUrl")).toBeNull();

    // The real key still authenticates; the template's one never does.
    expect((await request(app).get("/api/auth/me").set("X-Api-Key", apiKey)).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("X-Api-Key", "attacker-known-key")).status).toBe(401);
  });

  it("slots a quality this instance lacks in after its nearest template-order predecessor — no UNIQUE(rank) clash, existing order untouched", async () => {
    await db.prepare("DELETE FROM qualities").run();
    for (const [rank, name] of ["A", "B", "C", "D"].entries()) {
      await db.prepare("INSERT INTO qualities (name, rank) VALUES (?, ?)").run(name, rank);
    }

    // The template orders C before B (the source instance was reordered), and carries two tiers
    // this instance lacks: M first of all, N right after C. N's source rank (3) — and M's (0) — are
    // both already taken here.
    const res = await request(app)
      .post("/api/settings/template/import")
      .set("X-Api-Key", apiKey)
      .send({
        qualities: [
          { name: "M", rank: 0, min_size_mb: 1, max_size_mb: 2, preferred_size_mb: null },
          { name: "A", rank: 1, min_size_mb: null, max_size_mb: null, preferred_size_mb: null },
          { name: "C", rank: 2, min_size_mb: null, max_size_mb: null, preferred_size_mb: null },
          { name: "N", rank: 3, min_size_mb: 300, max_size_mb: 900, preferred_size_mb: 600 },
          { name: "B", rank: 4, min_size_mb: 100, max_size_mb: 200, preferred_size_mb: 150 },
          { name: "D", rank: 5, min_size_mb: null, max_size_mb: null, preferred_size_mb: null },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.qualitiesImported).toBe(6);
    const ladder = await qualityLadder();
    // A, B, C, D keep their own relative order (B is NOT moved after C to match the template);
    // M goes first (no predecessor), N lands right after C, not at the end.
    expect(ladder.map((q) => q.name)).toEqual(["M", "A", "B", "C", "N", "D"]);
    expect(ladder.map((q) => q.rank)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ladder.find((q) => q.name === "N")).toMatchObject({ min_size_mb: 300, max_size_mb: 900, preferred_size_mb: 600 });
    // An existing quality only gets its size fields updated.
    expect(ladder.find((q) => q.name === "B")).toMatchObject({ min_size_mb: 100, max_size_mb: 200, preferred_size_mb: 150 });
  });

  it("re-importing the same template is a no-op for the ladder order", async () => {
    const before = (await qualityLadder()).map((q) => q.name);

    const res = await request(app)
      .post("/api/settings/template/import")
      .set("X-Api-Key", apiKey)
      .send({
        qualities: [
          { name: "M", rank: 0 },
          { name: "A", rank: 1 },
          { name: "C", rank: 2 },
          { name: "N", rank: 3 },
          { name: "B", rank: 4 },
          { name: "D", rank: 5 },
        ],
      });

    expect(res.status).toBe(200);
    expect((await qualityLadder()).map((q) => q.name)).toEqual(before);
  });
});
