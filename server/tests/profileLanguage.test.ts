import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import { languageRejection, normalizeProfileLanguage } from "../src/services/profileLanguage.js";
import { buildRejections, emptyFacts } from "../src/services/releaseDecision.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let chooseBestResult: (typeof import("../src/services/scheduler.js"))["chooseBestResult"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ chooseBestResult } = await import("../src/services/scheduler.js"));
});

beforeEach(async () => {
  await db.prepare("DELETE FROM quality_profiles").run();
});

describe("languageRejection (ST24)", () => {
  it("accepts everything when the profile wants no language", () => {
    expect(languageRejection(null, ["german"])).toBeNull();
    expect(languageRejection("", ["french"])).toBeNull();
  });

  it("takes a name with no language tag as English", () => {
    expect(languageRejection("english", [])).toBeNull();
    expect(languageRejection("german", [])).toMatch(/not the profile's wanted language/);
  });

  it("accepts the wanted language, a multi release, and rejects another language", () => {
    expect(languageRejection("german", ["german"])).toBeNull();
    expect(languageRejection("german", ["multi"])).toBeNull();
    expect(languageRejection("english", ["german"])).toMatch(/german/);
  });

  it("reads vff and vfq as French and vostfr as no claim about the audio", () => {
    expect(languageRejection("french", ["vff"])).toBeNull();
    expect(languageRejection("french", ["vfq"])).toBeNull();
    expect(languageRejection("english", ["vostfr"])).toBeNull();
  });

  it("reads nordic as no claim about the audio, and knows hindi and chinese (L5)", () => {
    expect(languageRejection("english", ["nordic"])).toBeNull();
    expect(languageRejection("hindi", ["hindi"])).toBeNull();
    expect(languageRejection("chinese", ["chinese"])).toBeNull();
    expect(normalizeProfileLanguage("hindi")).toBe("hindi");
  });

  it("normalizes what a profile stores", () => {
    expect(normalizeProfileLanguage("German")).toBe("german");
    expect(normalizeProfileLanguage("any")).toBeNull();
    expect(normalizeProfileLanguage("klingon")).toBeNull();
  });

  it("shows up as its own reason in the decision", () => {
    const facts = emptyFacts();
    facts.language = "Its language (german) is not the profile's wanted language (english)";
    expect(buildRejections(facts).map((r) => r.code)).toEqual(["language"]);
  });
});

describe("a quality profile's language (ST24)", () => {
  const body = { name: "English only", allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p" };

  it("is stored on create and edit, and any clears it", async () => {
    const created = await request(app as any).post("/api/quality-profiles").set("X-Api-Key", apiKey).send({ ...body, language: "English" });
    expect(created.status).toBe(201);
    expect(created.body.language).toBe("english");
    const edited = await request(app as any).patch(`/api/quality-profiles/${created.body.id}`).set("X-Api-Key", apiKey).send({ language: "any" });
    expect(edited.body.language).toBeNull();
  });

  it("refuses a language a release name cannot say", async () => {
    const res = await request(app as any).post("/api/quality-profiles").set("X-Api-Key", apiKey).send({ ...body, language: "klingon" });
    expect(res.status).toBe(400);
  });
});

describe("the automatic pick honors the wanted language (ST24)", () => {
  const release = (title: string, seeders: number) =>
    ({
      indexerId: 1,
      indexerName: "Idx",
      title,
      size: 4_000_000_000,
      seeders,
      leechers: 1,
      publishDate: "2024-01-01T00:00:00Z",
      downloadUrl: `magnet:?xt=${title}`,
      protocol: "torrent",
      category: null,
    }) as any;

  async function profile(language: string | null): Promise<number> {
    return Number(
      (
        await db
          .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, language) VALUES ('P', '[\"WEBDL-1080p\"]', 'WEBDL-1080p', ?)")
          .run(language)
      ).lastInsertRowid
    );
  }

  it("takes the release in the wanted language over a better seeded one in another", async () => {
    const id = await profile("english");
    const german = release("Some.Film.2024.German.1080p.WEB-DL.x264-GRP", 500);
    const english = release("Some.Film.2024.1080p.WEB-DL.x264-GRP", 5);
    const best = await chooseBestResult([german, english], ["WEBDL-1080p"], "WEBDL-1080p", id, 0, null, new Set(), "movie");
    expect(best?.result.title).toBe(english.title);
  });

  it("takes nothing when only another language is on offer, and anything when the profile wants none", async () => {
    const english = await profile("english");
    const german = release("Some.Film.2024.German.1080p.WEB-DL.x264-GRP", 500);
    expect(await chooseBestResult([german], ["WEBDL-1080p"], "WEBDL-1080p", english, 0, null, new Set(), "movie")).toBeNull();

    await db.prepare("UPDATE quality_profiles SET language = NULL WHERE id = ?").run(english);
    const best = await chooseBestResult([german], ["WEBDL-1080p"], "WEBDL-1080p", english, 0, null, new Set(), "movie");
    expect(best?.result.title).toBe(german.title);
  });
});

describe("a profile's language travels in the settings template (ST24)", () => {
  const send = (path: string, body: unknown) => request(app as any).post(path).set("X-Api-Key", apiKey).send(body);

  it("exports it, restores it, keeps it for a backup from before it existed, and clears it when the backup says any", async () => {
    const created = await send("/api/quality-profiles", { name: "German only", allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p", language: "german" });
    expect(created.status).toBe(201);

    const exported = (await request(app as any).get("/api/settings/template/export").set("X-Api-Key", apiKey)).body;
    expect(exported.qualityProfiles.find((p: any) => p.name === "German only").language).toBe("german");

    const base = { name: "German only", allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p", minFormatScore: 0, maxSizeGb: null };
    const languageNow = async () => ((await db.prepare("SELECT language FROM quality_profiles WHERE id = ?").get(created.body.id)) as any).language;

    expect((await send("/api/settings/template/import", { qualityProfiles: [base] })).status).toBe(200);
    expect(await languageNow()).toBe("german");

    expect((await send("/api/settings/template/import", { qualityProfiles: [{ ...base, language: null }] })).status).toBe(200);
    expect(await languageNow()).toBeNull();

    expect((await send("/api/settings/template/import", { qualityProfiles: [{ ...base, name: "Imported fresh", language: "french" }] })).status).toBe(200);
    const fresh = (await db.prepare("SELECT language FROM quality_profiles WHERE name = 'Imported fresh'").get()) as any;
    expect(fresh.language).toBe("french");
  });
});
