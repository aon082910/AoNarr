import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import { languageFromTrash, translateTrashProfile, type TrashProfileFile } from "../src/services/trashProfiles.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

const base: TrashProfileFile = {
  name: "Language Profile",
  upgradeAllowed: true,
  cutoff: "Bluray-1080p",
  minFormatScore: 0,
  cutoffFormatScore: 100,
  minUpgradeFormatScore: 1,
  items: [{ name: "Bluray-1080p", allowed: true }],
  formatItems: {},
};

const ranks = new Map(["Bluray-720p", "Bluray-1080p"].map((n, i) => [n, i]));

describe("languageFromTrash (round 30d)", () => {
  it("reads 'Any', nothing and a missing value as any language, without a note", () => {
    expect(languageFromTrash("Any")).toEqual({ language: null, named: false, note: null });
    expect(languageFromTrash("")).toEqual({ language: null, named: false, note: null });
    expect(languageFromTrash(undefined)).toEqual({ language: null, named: false, note: null });
  });

  it("takes a language AoNarr knows, whatever the letter case", () => {
    expect(languageFromTrash("English")).toEqual({ language: "english", named: true, note: null });
    expect(languageFromTrash("german")).toMatchObject({ language: "german", named: true });
  });

  it("leaves 'Original' as any language and says why", () => {
    const result = languageFromTrash("Original");
    expect(result.language).toBeNull();
    expect(result.named).toBe(false);
    expect(result.note).toMatch(/original language/);
  });

  it("leaves a language AoNarr cannot tell from a release name as any, with a note naming it", () => {
    const result = languageFromTrash("Klingon");
    expect(result).toMatchObject({ language: null, named: false });
    expect(result.note).toContain("Klingon");
  });

  it("does not throw on a value that is not text", () => {
    expect(languageFromTrash({ name: "English" })).toMatchObject({ language: null, named: false });
    expect(languageFromTrash(7)).toMatchObject({ language: null, named: false });
  });
});

describe("translateTrashProfile language (round 30d)", () => {
  it("carries the language and the flags along with the rest of the translation", () => {
    const t = translateTrashProfile({ ...base, language: "English" }, ranks, new Map());
    expect(t).toMatchObject({ language: "english", languageNamed: true, languageNote: null });
    const original = translateTrashProfile({ ...base, language: "Original" }, ranks, new Map());
    expect(original).toMatchObject({ language: null, languageNamed: false });
    expect(original.languageNote).toBeTruthy();
  });
});

function mockTrashRepo(profiles: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("https://api.github.com/")) {
        return { ok: true, json: async () => Object.keys(profiles).map((name) => ({ name, type: "file", download_url: `https://raw.test/${name}` })) } as any;
      }
      const body = profiles[url.split("/").pop() as string];
      if (body === undefined) return { ok: false, status: 404 } as any;
      return { ok: true, json: async () => body } as any;
    })
  );
}

const importProfile = (file: string) => authed(request(app).post("/api/custom-formats/trash-profiles/import")).send({ app: "radarr", file });
const languageOf = async (name: string) => ((await db.prepare("SELECT language FROM quality_profiles WHERE name = ?").get(name)) as { language: string | null }).language;

describe("importing a TRaSH profile with a language (round 30d)", () => {
  it("stores the language a new profile asks for", async () => {
    mockTrashRepo({ "english.json": { ...base, name: "English Only", language: "English" } });

    const res = await importProfile("english.json");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ language: "english", languageNamed: true });
    expect(await languageOf("English Only")).toBe("english");
  });

  it("leaves a new profile on any language for 'Original', and returns the note", async () => {
    mockTrashRepo({ "original.json": { ...base, name: "Original Language", language: "Original" } });

    const res = await importProfile("original.json");

    expect(res.status).toBe(201);
    expect(res.body.languageNote).toMatch(/original language/);
    expect(await languageOf("Original Language")).toBeNull();
  });

  it("replaces the language of an existing profile when TRaSH names one", async () => {
    mockTrashRepo({ "swap.json": { ...base, name: "Swap Me", language: "English" } });
    await importProfile("swap.json").expect(201);
    await db.prepare("UPDATE quality_profiles SET language = 'french' WHERE name = 'Swap Me'").run();

    await importProfile("swap.json").expect(200);

    expect(await languageOf("Swap Me")).toBe("english");
  });

  it("keeps the admin's own language on an existing profile when TRaSH says 'Any' or 'Original'", async () => {
    mockTrashRepo({ "keep.json": { ...base, name: "Keep Mine", language: "English" } });
    await importProfile("keep.json").expect(201);
    await db.prepare("UPDATE quality_profiles SET language = 'french' WHERE name = 'Keep Mine'").run();

    mockTrashRepo({ "keep.json": { ...base, name: "Keep Mine", language: "Any" } });
    await importProfile("keep.json").expect(200);
    expect(await languageOf("Keep Mine")).toBe("french");

    mockTrashRepo({ "keep.json": { ...base, name: "Keep Mine", language: "Original" } });
    await importProfile("keep.json").expect(200);
    expect(await languageOf("Keep Mine")).toBe("french");
  });
});
