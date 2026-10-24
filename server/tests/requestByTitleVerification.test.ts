import crypto from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

// Adding a title found by a text search (a watchlist export, a Discord /request): only a hit the
// title and year verify is added; what the search cannot settle is left for the admin.

const searchMetadata = vi.fn();
const fetchSeriesEpisodesFor = vi.fn(async () => []);
vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/metadata.js")>()),
  searchMetadata: (...args: unknown[]) => searchMetadata(...args),
  fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...(args as [])),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(async () => {
  searchMetadata.mockReset();
  for (const t of ["import_review_items", "media_items"]) await db.prepare(`DELETE FROM ${t}`).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const hit = (title: string, year: number | null, tmdb: string) => ({ title, year, overview: null, posterUrl: null, externalIds: { tmdb } });

async function watchlist(rows: { title: string; year: number | null; type: string }[]) {
  const res = await request(app).post("/api/watchlist-import").set("X-Api-Key", apiKey).send({ rows });
  expect(res.status).toBe(200);
  return res.body.results as { title: string; status: string }[];
}

describe("watchlist import", () => {
  it("adds the hit whose title and year agree, asking the search for that year", async () => {
    searchMetadata.mockResolvedValue([hit("Dune: Part Two", 2024, "693134"), hit("Dune", 2021, "438631"), hit("Dune", 1984, "841")]);

    const results = await watchlist([{ title: "Dune", year: 2021, type: "movie" }]);

    expect(results).toEqual([{ title: "Dune", status: "added" }]);
    expect(searchMetadata).toHaveBeenCalledWith("movie", "Dune 2021", undefined, 2021);
    const row = (await db.prepare("SELECT year, external_ids FROM media_items WHERE type = 'movie'").get()) as any;
    expect([row.year, JSON.parse(row.external_ids)]).toEqual([2021, { tmdb: "438631" }]);
  });

  it("leaves a year-less title with two same-titled hits for review instead of taking the first", async () => {
    searchMetadata.mockResolvedValue([hit("Halloween", 2018, "424139"), hit("Halloween", 1978, "948")]);

    const results = await watchlist([{ title: "Halloween", year: null, type: "movie" }]);

    expect(results).toEqual([{ title: "Halloween", status: "needs_review" }]);
    expect(await db.prepare("SELECT id FROM media_items").get()).toBeUndefined();
    expect(await db.prepare("SELECT id FROM import_review_items WHERE title = 'Halloween'").get()).toBeTruthy();
  });

  it("takes a hit under another regional title only when its year agrees", async () => {
    searchMetadata.mockResolvedValue([hit("Harry Potter and the Philosopher's Stone", 2001, "671")]);
    const agrees = await watchlist([{ title: "Harry Potter and the Sorcerer's Stone", year: 2001, type: "movie" }]);
    expect(agrees).toEqual([{ title: "Harry Potter and the Sorcerer's Stone", status: "added" }]);

    searchMetadata.mockResolvedValue([hit("Something Unrelated", 1950, "1")]);
    const contradicts = await watchlist([{ title: "Another Film", year: 2001, type: "movie" }]);
    expect(contradicts).toEqual([{ title: "Another Film", status: "needs_review" }]);
    const noYear = await watchlist([{ title: "Yet Another", year: null, type: "movie" }]);
    expect(noYear).toEqual([{ title: "Yet Another", status: "needs_review" }]);
  });

  it("still reports a title the search found nothing for as not found, and queues it", async () => {
    searchMetadata.mockResolvedValue([]);
    expect(await watchlist([{ title: "Nothing Here", year: 2024, type: "movie" }])).toEqual([{ title: "Nothing Here", status: "not_found" }]);
    expect(await db.prepare("SELECT id FROM import_review_items WHERE title = 'Nothing Here'").get()).toBeTruthy();
  });
});

describe("Discord /request", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  // The raw 32 bytes at the end of the SPKI DER form: the shape Discord hands out.
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");

  async function requestCommand(type: "movie" | "series", title: string): Promise<string> {
    setSetting("discordPublicKey", publicKeyHex);
    setSetting("discordApplicationId", "app-1");
    const replies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        replies.push(JSON.parse(String(init?.body)).content);
        return new Response("{}", { status: 200 });
      })
    );
    const body = JSON.stringify({
      type: 2,
      token: "tok",
      data: { name: "request", options: [{ name: "type", value: type }, { name: "title", value: title }] },
    });
    const timestamp = String(Date.now());
    const signature = crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
    const res = await request(app)
      .post("/api/discord/interactions")
      .set("Content-Type", "application/json")
      .set("X-Signature-Ed25519", signature)
      .set("X-Signature-Timestamp", timestamp)
      .send(body);
    expect(res.body).toEqual({ type: 5 });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    return replies[0];
  }

  it("adds the one same-titled hit, and takes a trailing year as the year to look for", async () => {
    searchMetadata.mockResolvedValue([hit("Dune", 1984, "841"), hit("Dune", 2021, "438631")]);

    const reply = await requestCommand("movie", "Dune (2021)");

    expect(reply).toContain("Added **Dune** (2021)");
    expect(searchMetadata).toHaveBeenCalledWith("movie", "Dune", undefined, 2021);
    expect(JSON.parse(((await db.prepare("SELECT external_ids FROM media_items").get()) as any).external_ids)).toEqual({ tmdb: "438631" });
  });

  it("asks which one is meant instead of adding the first of two same-titled hits", async () => {
    searchMetadata.mockResolvedValue([hit("The Office", 2001, "2996"), hit("The Office", 2005, "2316")]);

    const reply = await requestCommand("series", "The Office");

    expect(reply).toMatch(/Couldn't tell which one you mean by "The Office" — found: The Office \(2001\); The Office \(2005\)\. Ask again with the exact title and year, like "The Office 2001"\./);
    expect(await db.prepare("SELECT id FROM media_items").get()).toBeUndefined();
  });
});
