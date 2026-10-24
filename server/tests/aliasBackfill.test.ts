import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchAlternateTitlesFor = vi.fn<(type: string, ids: Record<string, string>) => Promise<string[]>>();
vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/metadata.js")>()),
  fetchAlternateTitlesFor: (...args: [string, Record<string, string>]) => fetchAlternateTitlesFor(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let backfill: typeof import("../src/services/aliasBackfill.js");
let aliases: typeof import("../src/services/releaseAliases.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  backfill = await import("../src/services/aliasBackfill.js");
  aliases = await import("../src/services/releaseAliases.js");
});

beforeEach(async () => {
  await db.prepare("DELETE FROM media_item_titles").run();
  await db.prepare("DELETE FROM media_items").run();
  fetchAlternateTitlesFor.mockReset();
});

async function insertItem(type: string, title: string, externalIds: Record<string, string> | null, extra: Record<string, unknown> | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids, extra_metadata) VALUES (?, ?, ?, 1, 0, 'missing', ?, ?)")
        .run(type, title, title.toLowerCase(), externalIds ? JSON.stringify(externalIds) : null, extra ? JSON.stringify(extra) : null)
    ).lastInsertRowid
  );
}

async function checkedAt(id: number): Promise<string | undefined> {
  const row = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(id)) as { extra_metadata: string | null };
  return row.extra_metadata ? JSON.parse(row.extra_metadata).aliasesCheckedAt : undefined;
}

describe("refreshProviderAliases", () => {
  it("stores TMDB alternative titles for a movie and marks the item checked", async () => {
    const id = await insertItem("movie", "The Fall Guy", { tmdb: "746036" }, { posterColor: "#fff" });
    fetchAlternateTitlesFor.mockResolvedValue(["Kaskader", "The Fall Guy", "Le Cascadeur"]);

    expect(await backfill.refreshProviderAliases(id)).toBe(2);

    expect(fetchAlternateTitlesFor).toHaveBeenCalledWith("movie", { tmdb: "746036" });
    expect(await aliases.aliasRowsFor(id)).toMatchObject([
      { title: "Kaskader", source: "tmdb_alt" },
      { title: "Le Cascadeur", source: "tmdb_alt" },
    ]);
    expect(await checkedAt(id)).toBeTypeOf("string");
    // Other extra metadata survives the mark.
    const row = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(id)) as { extra_metadata: string };
    expect(JSON.parse(row.extra_metadata).posterColor).toBe("#fff");
  });

  it("stores AniList synonyms for an anime that has an AniList id", async () => {
    const id = await insertItem("anime", "Attack on Titan", { anilist: "16498", tmdb: "1429" });
    fetchAlternateTitlesFor.mockResolvedValue(["Shingeki no Kyojin", "進撃の巨人"]);

    expect(await backfill.refreshProviderAliases(id)).toBe(2);
    expect((await aliases.aliasRowsFor(id)).map((r) => r.source)).toEqual(["anilist_synonym", "anilist_synonym"]);
  });

  it("does nothing for a type without quality tiers or an unknown item", async () => {
    const id = await insertItem("artist", "Queen", { musicbrainz: "x" });
    expect(await backfill.refreshProviderAliases(id)).toBe(0);
    expect(await backfill.refreshProviderAliases(999_999)).toBe(0);
    expect(fetchAlternateTitlesFor).not.toHaveBeenCalled();
    expect(await checkedAt(id)).toBeUndefined();
  });

  it("marks an item the provider has nothing for as checked, but leaves it unchecked when the API key is missing", async () => {
    const noRecord = await insertItem("movie", "Obscure Film", { tmdb: "1" });
    fetchAlternateTitlesFor.mockRejectedValueOnce(new Error("TMDB alternative titles lookup failed: HTTP 404"));
    await expect(backfill.refreshProviderAliases(noRecord)).rejects.toThrow(/HTTP 404/);
    expect(await checkedAt(noRecord)).toBeTypeOf("string");

    const noKey = await insertItem("movie", "Keyless Film", { tmdb: "2" });
    fetchAlternateTitlesFor.mockRejectedValueOnce(new Error("TMDB API key is not configured"));
    await expect(backfill.refreshProviderAliases(noKey)).rejects.toThrow(/API key/);
    expect(await checkedAt(noKey)).toBeUndefined();
  });
});

describe("backfillProviderAliases", () => {
  it("visits only unchecked quality-tiered items with a provider id, once", async () => {
    const movie = await insertItem("movie", "Dune", { tmdb: "438631" });
    const already = await insertItem("movie", "Checked Film", { tmdb: "3" }, { aliasesCheckedAt: "2026-01-01T00:00:00.000Z" });
    const noIds = await insertItem("movie", "No Ids Film", { imdb: "tt1" });
    const book = await insertItem("author", "An Author", { goodreads: "9" });
    fetchAlternateTitlesFor.mockResolvedValue(["Dune: Part One"]);

    expect(await backfill.backfillProviderAliases()).toEqual({ checked: 1, added: 1 });

    expect(fetchAlternateTitlesFor).toHaveBeenCalledTimes(1);
    expect(fetchAlternateTitlesFor).toHaveBeenCalledWith("movie", { tmdb: "438631" });
    expect(await aliases.aliasTitlesFor(movie)).toEqual(["Dune: Part One"]);
    for (const id of [already, noIds, book]) expect(await aliases.aliasTitlesFor(id)).toEqual([]);
    expect(await checkedAt(already)).toBe("2026-01-01T00:00:00.000Z");

    // A second run finds nothing left to ask about.
    expect(await backfill.backfillProviderAliases()).toEqual({ checked: 0, added: 0 });
    expect(fetchAlternateTitlesFor).toHaveBeenCalledTimes(1);
  });

  it("stops at a missing API key, leaving the rest for a later run, and carries on past other failures", async () => {
    const first = await insertItem("movie", "First Film", { tmdb: "10" });
    const second = await insertItem("movie", "Second Film", { tmdb: "11" });
    fetchAlternateTitlesFor.mockRejectedValueOnce(new Error("TMDB API key is not configured"));

    expect(await backfill.backfillProviderAliases()).toEqual({ checked: 0, added: 0 });
    expect(fetchAlternateTitlesFor).toHaveBeenCalledTimes(1);
    expect(await checkedAt(first)).toBeUndefined();
    expect(await checkedAt(second)).toBeUndefined();

    fetchAlternateTitlesFor.mockReset();
    fetchAlternateTitlesFor.mockRejectedValueOnce(new Error("TMDB alternative titles lookup failed: HTTP 404")).mockResolvedValueOnce(["Zweiter Film"]);
    expect(await backfill.backfillProviderAliases()).toEqual({ checked: 2, added: 1 });
    expect(await checkedAt(first)).toBeTypeOf("string");
    expect(await aliases.aliasTitlesFor(second)).toEqual(["Zweiter Film"]);
  });
});
