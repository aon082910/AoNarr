import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

// The titles the lookup returns come from this mock; the origin country it reports is set per test.
const fetchAlternateTitlesFor = vi.fn<(type: string, ids: Record<string, string>) => Promise<string[]>>();
let originCountry: string[] | null = null;
vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/metadata.js")>()),
  fetchAliasDataFor: async (...args: [string, Record<string, string>]) => ({ titles: await fetchAlternateTitlesFor(...args), originCountry }),
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
  originCountry = null;
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

  it("replaces the provider's titles instead of adding to them, keeping the admin's own", async () => {
    const id = await insertItem("movie", "Replaced Film", { tmdb: "5" });
    await aliases.storeAliases(id, ["Mein Eigener Titel"], "user");
    fetchAlternateTitlesFor.mockResolvedValueOnce(["Old Name", "Kept Name"]);
    await backfill.refreshProviderAliases(id);
    fetchAlternateTitlesFor.mockResolvedValueOnce(["Kept Name", "New Name"]);
    await backfill.refreshProviderAliases(id);
    expect((await aliases.aliasRowsFor(id)).map((r) => [r.title, r.source]).sort()).toEqual([
      ["Kept Name", "tmdb_alt"],
      ["Mein Eigener Titel", "user"],
      ["New Name", "tmdb_alt"],
    ]);
  });

  it("records where the work was made, and the version of the lookup, next to the checked marker", async () => {
    const id = await insertItem("series", "The Office", { tmdb: "2316" });
    originCountry = ["US"];
    fetchAlternateTitlesFor.mockResolvedValue([]);
    await backfill.refreshProviderAliases(id);
    const row = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(id)) as { extra_metadata: string };
    expect(JSON.parse(row.extra_metadata)).toMatchObject({ originCountry: ["US"], aliasesVersion: 2 });
    expect(JSON.parse(row.extra_metadata).aliasesCheckedAt).toBeTypeOf("string");
    expect((await aliases.identityContextFor(id)).originCountry).toEqual(["US"]);
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

  it("leaves an item unchecked when the provider failed for a reason that says nothing about the item", async () => {
    for (const message of ["TMDB alternative titles lookup failed: HTTP 429", "TMDB alternative titles lookup failed: HTTP 503", "fetch failed", "TMDB alternative titles lookup failed: HTTP 401"]) {
      const id = await insertItem("movie", `Transient ${message}`, { tmdb: "5" });
      fetchAlternateTitlesFor.mockRejectedValueOnce(new Error(message));
      await expect(backfill.refreshProviderAliases(id)).rejects.toThrow(message);
      expect(await checkedAt(id), message).toBeUndefined();
    }
    for (const message of ["AniList has no record for this id", "Alternate titles lookup needs a TMDB id — this item doesn't have one", `Alternate titles aren't available for "series"`]) {
      const id = await insertItem("movie", `Definitive ${message}`, { tmdb: "6" });
      fetchAlternateTitlesFor.mockRejectedValueOnce(new Error(message));
      await expect(backfill.refreshProviderAliases(id)).rejects.toThrow();
      expect(await checkedAt(id), message).toBeTypeOf("string");
    }
  });

  it("keeps what another writer stored in extra_metadata while the provider was being asked", async () => {
    const id = await insertItem("movie", "Racing Film", { tmdb: "7" }, { posterColor: "#fff" });
    fetchAlternateTitlesFor.mockImplementation(async () => {
      // A provider match finishing while the lookup is in flight stages its result on the same row.
      await db.prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ?").run(JSON.stringify({ posterColor: "#fff", tvdb: { id: "9" } }), id);
      return ["Rennfilm"];
    });

    await backfill.refreshProviderAliases(id);

    const row = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(id)) as { extra_metadata: string };
    expect(JSON.parse(row.extra_metadata)).toMatchObject({ posterColor: "#fff", tvdb: { id: "9" } });
    expect(await checkedAt(id)).toBeTypeOf("string");
  });
});

describe("backfillProviderAliases — items checked by an earlier version of the lookup", () => {
  it("asks a TMDB item checked before the original title and translations were fetched again, but not an AniList one", async () => {
    const old = await insertItem("movie", "Old Check", { tmdb: "10" }, { aliasesCheckedAt: "2026-10-01T00:00:00.000Z" });
    const current = await insertItem("movie", "Current Check", { tmdb: "11" }, { aliasesCheckedAt: "2026-10-01T00:00:00.000Z", aliasesVersion: 2 });
    const anime = await insertItem("anime", "Anime Check", { anilist: "12" }, { aliasesCheckedAt: "2026-10-01T00:00:00.000Z" });
    fetchAlternateTitlesFor.mockResolvedValue(["Altes Alias"]);
    expect(await backfill.backfillProviderAliases()).toEqual({ checked: 1, added: 1 });
    expect(fetchAlternateTitlesFor).toHaveBeenCalledTimes(1);
    expect(fetchAlternateTitlesFor).toHaveBeenCalledWith("movie", { tmdb: "10" });
    expect((await aliases.aliasRowsFor(old)).map((r) => r.title)).toEqual(["Altes Alias"]);
    expect(await aliases.aliasRowsFor(current)).toEqual([]);
    expect(await aliases.aliasRowsFor(anime)).toEqual([]);
  });
});

describe("backfillProviderAliases", () => {
  it("visits only unchecked quality-tiered items with a provider id, once", async () => {
    const movie = await insertItem("movie", "Dune", { tmdb: "438631" });
    const already = await insertItem("movie", "Checked Film", { tmdb: "3" }, { aliasesCheckedAt: "2026-01-01T00:00:00.000Z", aliasesVersion: 2 });
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

  it("goes on to the AniList items when TMDB can't be asked", async () => {
    const movie = await insertItem("movie", "Keyless Movie", { tmdb: "20" });
    const secondMovie = await insertItem("movie", "Keyless Second Movie", { tmdb: "21" });
    const anime = await insertItem("anime", "Keyless Anime", { anilist: "16498", tmdb: "1429" });
    fetchAlternateTitlesFor.mockImplementation(async (_type, ids) => {
      if (ids.anilist) return ["Shingeki no Kyojin"];
      throw new Error("TMDB API key is not configured");
    });

    expect(await backfill.backfillProviderAliases()).toEqual({ checked: 1, added: 1 });

    // TMDB was asked once, then left alone for the run; AniList needs no key.
    expect(fetchAlternateTitlesFor).toHaveBeenCalledTimes(2);
    expect(await aliases.aliasTitlesFor(anime)).toEqual(["Shingeki no Kyojin"]);
    expect(await checkedAt(movie)).toBeUndefined();
    expect(await checkedAt(secondMovie)).toBeUndefined();
  });

  it("stops asking a provider that is rate limiting, and leaves its items for a later run", async () => {
    const first = await insertItem("movie", "Limited First", { tmdb: "30" });
    const second = await insertItem("movie", "Limited Second", { tmdb: "31" });
    fetchAlternateTitlesFor.mockRejectedValue(new Error("TMDB alternative titles lookup failed: HTTP 429"));

    expect(await backfill.backfillProviderAliases()).toEqual({ checked: 0, added: 0 });

    expect(fetchAlternateTitlesFor).toHaveBeenCalledTimes(1);
    expect(await checkedAt(first)).toBeUndefined();
    expect(await checkedAt(second)).toBeUndefined();

    // The next run asks again and finishes them.
    fetchAlternateTitlesFor.mockReset().mockResolvedValue([]);
    expect(await backfill.backfillProviderAliases()).toEqual({ checked: 2, added: 0 });
    expect(await checkedAt(first)).toBeTypeOf("string");
  });

  it("gives up on a provider after a few failures in a row, but not on one odd item", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertItem("movie", `Flaky ${i}`, { tmdb: String(40 + i) }));
    // One item fails, the next succeeds: carries on.
    fetchAlternateTitlesFor.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue([]);
    expect(await backfill.backfillProviderAliases()).toEqual({ checked: 4, added: 0 });
    expect(await checkedAt(ids[0])).toBeUndefined();

    // Three in a row: the rest wait.
    for (let i = 0; i < 4; i++) ids.push(await insertItem("movie", `Flaky again ${i}`, { tmdb: String(60 + i) }));
    fetchAlternateTitlesFor.mockReset().mockRejectedValue(new Error("fetch failed"));
    expect(await backfill.backfillProviderAliases()).toEqual({ checked: 0, added: 0 });
    expect(fetchAlternateTitlesFor).toHaveBeenCalledTimes(3);
  });

  it("lets only one run proceed when two start together", async () => {
    await insertItem("movie", "Twice Asked", { tmdb: "50" });
    fetchAlternateTitlesFor.mockResolvedValue(["Doppelt"]);

    const [a, b] = await Promise.all([backfill.backfillProviderAliases(), backfill.backfillProviderAliases()]);

    expect([a, b]).toContainEqual({ checked: 0, added: 0 });
    expect([a, b]).toContainEqual({ checked: 1, added: 1 });
    expect(fetchAlternateTitlesFor).toHaveBeenCalledTimes(1);
  });
});
