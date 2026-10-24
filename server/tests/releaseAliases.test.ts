import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import { parseReleaseTitle } from "../src/services/releaseParser.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let aliases: typeof import("../src/services/releaseAliases.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  aliases = await import("../src/services/releaseAliases.js");
});

async function insertItem(type: string, title: string, year: number | null = null, externalIds: Record<string, string> | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, external_ids) VALUES (?, ?, ?, ?, 1, 0, 'missing', ?)")
        .run(type, title, title.toLowerCase(), year, externalIds ? JSON.stringify(externalIds) : null)
    ).lastInsertRowid
  );
}

const itemRow = (id: number, type: string, title: string, year: number | null, externalIds: Record<string, string> | null = null) => ({
  id,
  type,
  title,
  year,
  externalIds: externalIds ? JSON.stringify(externalIds) : null,
});

describe("cleanTitle (Sonarr's CleanSeriesTitle)", () => {
  it("lowercases, folds accents and punctuation, drops common words and runs the rest together", () => {
    expect(aliases.cleanTitle("The Office (US)")).toBe("officeus");
    expect(aliases.cleanTitle("Marvel's Agents of S.H.I.E.L.D.")).toBe("marvelsagentsshield");
    expect(aliases.cleanTitle("Léon: The Professional")).toBe("leonprofessional");
    expect(aliases.cleanTitle("Attack on Titan")).toBe("attackontitan");
    expect(aliases.cleanTitle("Shingeki no Kyojin")).toBe("shingekinokyojin");
  });

  it("keeps a title made only of common words or digits", () => {
    expect(aliases.cleanTitle("24")).toBe("24");
    expect(aliases.cleanTitle("The And")).toBe("theand");
    expect(aliases.cleanTitle("")).toBe("");
  });

  it("gives two spellings of one title the same key", () => {
    expect(aliases.cleanTitle("Agents of SHIELD")).toBe(aliases.cleanTitle("Agents of S.H.I.E.L.D."));
    expect(aliases.cleanTitle("Star Wars Episode IV")).toBe(aliases.cleanTitle("Star Wars: Episode 4"));
  });
});

describe("storeAliases / aliasTitlesFor / deleteAlias", () => {
  it("stores trimmed titles once each, skipping empties, duplicates by clean title and the item's own title", async () => {
    const id = await insertItem("anime", "Attack on Titan", 2013);
    const added = await aliases.storeAliases(id, ["  Shingeki no Kyojin ", "", "Shingeki No Kyojin", "attack-on-titan", "Shingeki no Kyojin: The Final Season"], "anilist_synonym", 2013);
    expect(added).toBe(2);
    expect(await aliases.aliasTitlesFor(id)).toEqual(["Shingeki no Kyojin", "Shingeki no Kyojin: The Final Season"]);
    // The same title again, from another source, is not stored twice.
    expect(await aliases.storeAliases(id, ["Shingeki no Kyojin"], "user")).toBe(0);
    const rows = await aliases.aliasRowsFor(id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ mediaItemId: id, title: "Shingeki no Kyojin", cleanTitle: "shingekinokyojin", source: "anilist_synonym", year: 2013 });
  });

  it("stores nothing for an unknown item", async () => {
    expect(await aliases.storeAliases(999_999, ["Whatever"], "user")).toBe(0);
  });

  it("deletes an alias of the item only, never its primary row", async () => {
    const id = await insertItem("movie", "Dune", 2021);
    const other = await insertItem("movie", "Heat", 1995);
    await aliases.syncPrimaryTitle(id);
    await aliases.storeAliases(id, ["Dune: Part One"], "tmdb_alt");
    const rows = await aliases.aliasRowsFor(id);
    const primary = rows.find((r) => r.source === "primary")!;
    const alt = rows.find((r) => r.source === "tmdb_alt")!;
    expect(await aliases.deleteAlias(other, alt.id)).toBe(false); // someone else's item id
    expect(await aliases.deleteAlias(id, primary.id)).toBe(false);
    expect(await aliases.deleteAlias(id, alt.id)).toBe(true);
    expect(await aliases.aliasTitlesFor(id)).toEqual([]);
    expect((await aliases.aliasRowsFor(id)).map((r) => r.source)).toEqual(["primary"]);
  });

  it("lists an item's alias titles in a fixed order: the admin's and the scanned-in names first, then the providers' in the order stored", async () => {
    const id = await insertItem("movie", "Ordered Film", 2020);
    await aliases.storeAliases(id, ["Zebra Provider Title"], "tmdb_alt");
    await aliases.storeAliases(id, ["Alpha Provider Title"], "tmdb_alt");
    await aliases.storeAliases(id, ["Anime Synonym"], "anilist_synonym");
    await aliases.storeAliases(id, ["Old Folder Name"], "original");
    await aliases.storeAliases(id, ["Typed By Admin"], "user");

    expect(await aliases.aliasTitlesFor(id)).toEqual(["Typed By Admin", "Old Folder Name", "Anime Synonym", "Zebra Provider Title", "Alpha Provider Title"]);
  });

  it("maps alias titles by item for the library-wide matcher", async () => {
    const a = await insertItem("series", "The Late Show with Stephen Colbert", 2015);
    const b = await insertItem("series", "Alias Map Show", 2020);
    await aliases.storeAliases(a, ["The Late Show"], "tmdb_alt");
    await aliases.syncPrimaryTitle(b); // a primary row is not an alias
    const map = await aliases.aliasTitlesByItem();
    expect(map.get(a)).toEqual(["The Late Show"]);
    expect(map.has(b)).toBe(false);
  });
});

describe("syncPrimaryTitle / backfillCleanTitles", () => {
  it("writes the item's clean title and a primary row, replacing the old primary row after a title change", async () => {
    const id = await insertItem("series", "Wrong Family Film", 2001);
    await aliases.syncPrimaryTitle(id);
    expect((await db.prepare("SELECT clean_title FROM media_items WHERE id = ?").get(id) as any).clean_title).toBe("wrongfamilyfilm");
    expect(await aliases.aliasRowsFor(id)).toMatchObject([{ title: "Wrong Family Film", source: "primary", year: 2001 }]);

    await db.prepare("UPDATE media_items SET title = 'Correct Film' WHERE id = ?").run(id);
    await aliases.syncPrimaryTitle(id);
    expect((await db.prepare("SELECT clean_title FROM media_items WHERE id = ?").get(id) as any).clean_title).toBe("correctfilm");
    const rows = await aliases.aliasRowsFor(id);
    expect(rows.map((r) => [r.title, r.source])).toEqual([
      ["Wrong Family Film", "original"],
      ["Correct Film", "primary"],
    ]);
    expect(await aliases.aliasTitlesFor(id)).toEqual(["Wrong Family Film"]);
  });

  it("drops the old primary row instead of demoting it when told the old title is not the item's", async () => {
    const id = await insertItem("movie", "Extraction 2", 2023);
    await aliases.syncPrimaryTitle(id);
    await db.prepare("UPDATE media_items SET title = 'Extraction' WHERE id = ?").run(id);
    await aliases.syncPrimaryTitle(id, { keepOldTitle: false });
    expect((await aliases.aliasRowsFor(id)).map((r) => [r.title, r.source])).toEqual([["Extraction", "primary"]]);
    expect(await aliases.aliasTitlesFor(id)).toEqual([]);
  });

  it("clears only the titles a provider supplied", async () => {
    const id = await insertItem("movie", "Provider Clear Film", 2020);
    await aliases.syncPrimaryTitle(id);
    await aliases.storeAliases(id, ["Alt From Tmdb"], "tmdb_alt");
    await aliases.storeAliases(id, ["Alt From AniList"], "anilist_synonym");
    await aliases.storeAliases(id, ["Folder Name"], "original");
    await aliases.storeAliases(id, ["Typed By Admin"], "user");
    await aliases.clearProviderAliases(id);
    expect((await aliases.aliasRowsFor(id)).map((r) => r.source).sort()).toEqual(["original", "primary", "user"]);
  });

  it("promotes an existing alias row to primary when the item takes that title", async () => {
    const id = await insertItem("movie", "Promoted Before", 2010);
    await aliases.syncPrimaryTitle(id);
    await aliases.storeAliases(id, ["Promoted After"], "user");
    await db.prepare("UPDATE media_items SET title = 'Promoted After' WHERE id = ?").run(id);
    await aliases.syncPrimaryTitle(id);
    const rows = await aliases.aliasRowsFor(id);
    expect(rows.map((r) => [r.title, r.source])).toEqual([
      ["Promoted Before", "original"],
      ["Promoted After", "primary"],
    ]);
    expect(await aliases.aliasTitlesFor(id)).toEqual(["Promoted Before"]);
  });

  it("does nothing for a missing item", async () => {
    await expect(aliases.syncPrimaryTitle(999_998)).resolves.toBeUndefined();
  });

  it("keys only the items whose clean title is missing or stale", async () => {
    const fresh = await insertItem("movie", "Backfill Fresh", 2020);
    await aliases.syncPrimaryTitle(fresh);
    const missing = await insertItem("movie", "Backfill Missing", 2020);
    const stale = await insertItem("movie", "Backfill Stale", 2020);
    await db.prepare("UPDATE media_items SET clean_title = 'oldkey' WHERE id = ?").run(stale);
    const before = (await db.prepare("SELECT COUNT(*) AS n FROM media_items WHERE clean_title IS NULL OR clean_title = 'oldkey'").get()) as { n: number };

    const updated = await aliases.backfillCleanTitles();

    expect(updated).toBe(Number(before.n));
    expect((await db.prepare("SELECT clean_title FROM media_items WHERE id = ?").get(missing) as any).clean_title).toBe("backfillmissing");
    expect((await db.prepare("SELECT clean_title FROM media_items WHERE id = ?").get(stale) as any).clean_title).toBe("backfillstale");
    expect(await aliases.backfillCleanTitles()).toBe(0);
  });

  it("keys a library bigger than one transaction chunk", async () => {
    await db.transaction(async () => {
      for (let i = 0; i < 1100; i++) await insertItem("movie", `Bulk Backfill ${i}`, 2020);
    });

    expect(await aliases.backfillCleanTitles()).toBeGreaterThanOrEqual(1100);

    const unkeyed = (await db.prepare("SELECT COUNT(*) AS n FROM media_items WHERE clean_title IS NULL").get()) as { n: number };
    expect(Number(unkeyed.n)).toBe(0);
    const primaries = (await db.prepare("SELECT COUNT(*) AS n FROM media_item_titles WHERE source = 'primary' AND title LIKE 'Bulk Backfill %'").get()) as { n: number };
    expect(Number(primaries.n)).toBe(1100);
  });

  it("drops the old title from an item whose stored key no longer matches its title", async () => {
    const id = await insertItem("movie", "Stale Key After", 2020);
    await db.prepare("INSERT INTO media_item_titles (media_item_id, title, clean_title, source) VALUES (?, 'Stale Key Before', 'stalekeybefore', 'primary')").run(id);
    await db.prepare("UPDATE media_items SET clean_title = 'stalekeybefore' WHERE id = ?").run(id);

    await aliases.backfillCleanTitles();

    expect((await aliases.aliasRowsFor(id)).map((r) => [r.title, r.source])).toEqual([["Stale Key After", "primary"]]);
  });
});

describe("alternateQueriesFor", () => {
  it("writes the query under the title less its qualifier, the qualifier spelled out, then the first aliases", async () => {
    const id = await insertItem("series", "The Office (US)", 2005);
    await aliases.storeAliases(id, ["Das Büro", "Le Bureau", "El Trabajo"], "tmdb_alt");
    const queries = await aliases.alternateQueriesFor({ id, type: "series", title: "The Office (US)" }, "The Office (US) S03E01");
    expect(queries).toEqual(["The Office S03E01", "The Office US S03E01", "Das Büro S03E01"]);

    const none = await insertItem("series", "The Office (US) Twin", 2005);
    await aliases.storeAliases(none, ["Duplicate Alias"], "tmdb_alt");
    const withQualifier = await insertItem("series", "Shameless (UK)", 2004);
    expect(await aliases.alternateQueriesFor({ id: withQualifier, type: "series", title: "Shameless (UK)" }, "Shameless (UK) S01E01")).toEqual([
      "Shameless S01E01",
      "Shameless UK S01E01",
    ]);
  });

  it("writes a year qualifier as the year, never as the bare title that is also the other show, and a title without one to its aliases", async () => {
    const charmed = await insertItem("series", "Charmed (2018)", 2018);
    expect(await aliases.alternateQueriesFor({ id: charmed, type: "series", title: "Charmed (2018)" }, "Charmed (2018) S01E01")).toEqual(["Charmed 2018 S01E01"]);
    const plain = await insertItem("movie", "The Fall Guy", 2024);
    await aliases.storeAliases(plain, ["Kaskader", "the fall guy", "The Fall-Guy"], "tmdb_alt");
    expect(await aliases.alternateQueriesFor({ id: plain, type: "movie", title: "The Fall Guy" }, "The Fall Guy 2024")).toEqual(["Kaskader 2024"]);
  });

  it("is empty for a type with no quality tiers and for a query that does not start with the title", async () => {
    const artist = await insertItem("artist", "Queen", null);
    await aliases.storeAliases(artist, ["Queen Band"], "user");
    expect(await aliases.alternateQueriesFor({ id: artist, type: "artist", title: "Queen" }, "Queen Greatest Hits")).toEqual([]);
    const movie = await insertItem("movie", "Dune Part Two", 2024);
    await aliases.storeAliases(movie, ["Dune 2"], "tmdb_alt");
    expect(await aliases.alternateQueriesFor({ id: movie, type: "movie", title: "Dune Part Two" }, "something else")).toEqual([]);
  });
});

describe("identityTargetFor", () => {
  it("builds the gate's target from the row, parsing external ids and loading aliases", async () => {
    const id = await insertItem("movie", "Dune", 2021, { imdb: "tt1160419" });
    await aliases.storeAliases(id, ["Dune: Part One"], "tmdb_alt");
    expect(await aliases.identityTargetFor(itemRow(id, "movie", "Dune", 2021, { imdb: "tt1160419" }))).toEqual({
      type: "movie",
      title: "Dune",
      year: 2021,
      externalIds: { imdb: "tt1160419" },
      aliases: ["Dune: Part One"],
    });
  });

  it("treats unparseable external ids as none", async () => {
    const id = await insertItem("movie", "Broken Ids", 2021);
    const target = await aliases.identityTargetFor({ id, type: "movie", title: "Broken Ids", year: 2021, externalIds: "{not json" });
    expect(target.externalIds).toEqual({});
  });
});

describe("resolveReleaseItem (library-wide, with aliases)", () => {
  const release = (title: string) => [{ title }, parseReleaseTitle(title)] as const;

  it("returns the one item the release names, by title or alias", () => {
    const aot = itemRow(1, "anime", "Attack on Titan", 2013);
    const other = itemRow(2, "anime", "One Piece", 1999);
    const map = new Map([[1, ["Shingeki no Kyojin"]]]);
    const byAlias = aliases.resolveReleaseItem(...release("Shingeki.no.Kyojin.S04E01.1080p.WEB-GRP"), [other, aot], map);
    expect(byAlias).toMatchObject({ kind: "one", item: { id: 1 }, verdict: { matchType: "alias" } });
    const byTitle = aliases.resolveReleaseItem(...release("[SubsPlease] One Piece - 1000 (1080p) [ABCD1234].mkv"), [other, aot], map);
    expect(byTitle).toMatchObject({ kind: "one", item: { id: 2 } });
    expect(aliases.resolveReleaseItem(...release("Jujutsu.Kaisen.S02E01.1080p.WEB-GRP"), [other, aot], map)).toEqual({ kind: "none" });
  });

  it("is ambiguous when two items both claim the release, unless its year singles one out", () => {
    const original = itemRow(1, "series", "Charmed", 1998);
    const reboot = itemRow(2, "series", "Charmed", 2018);
    const map = new Map<number, string[]>();
    expect(aliases.resolveReleaseItem(...release("Charmed.S01E01.1080p.WEB-GRP"), [original, reboot], map)).toMatchObject({ kind: "ambiguous", items: [{ id: 1 }, { id: 2 }] });
    expect(aliases.resolveReleaseItem(...release("Charmed.2018.S01E01.1080p.WEB-GRP"), [original, reboot], map)).toMatchObject({ kind: "one", item: { id: 2 } });
    expect(aliases.resolveReleaseItem(...release("Charmed.1998.S01E01.1080p.WEB-GRP"), [original, reboot], map)).toMatchObject({ kind: "one", item: { id: 1 } });
  });

  it("stays ambiguous when the release year is one off both items (the gate's slack) and nothing else separates them", () => {
    const a = itemRow(1, "movie", "Twin Film", 2019);
    const b = itemRow(2, "movie", "Twin Film", 2021);
    expect(aliases.resolveReleaseItem(...release("Twin.Film.2020.1080p.WEB-GRP"), [a, b], new Map())).toMatchObject({ kind: "ambiguous" });
  });

  it("picks the item whose year the release names when both are within the gate's slack of it", () => {
    const a = itemRow(1, "movie", "Slack Film", 2019);
    const b = itemRow(2, "movie", "Slack Film", 2020);
    // 2020 is within a year of both items; the year only the second has is what singles it out.
    expect(aliases.resolveReleaseItem(...release("Slack.Film.2020.1080p.WEB-GRP"), [a, b], new Map())).toMatchObject({ kind: "one", item: { id: 2 } });
    expect(aliases.resolveReleaseItem(...release("Slack.Film.2019.1080p.WEB-GRP"), [a, b], new Map())).toMatchObject({ kind: "one", item: { id: 1 } });
  });

  it("matches a containment type by its whole title unless the type's gate enforces", () => {
    const ufc = itemRow(1, "ppv", "UFC 300", null);
    expect(aliases.resolveReleaseItem(...release("UFC.300.Prelims.720p.WEB-GRP"), [ufc], new Map())).toEqual({ kind: "none" });
    expect(aliases.resolveReleaseItem(...release("UFC.300.720p.WEB-GRP"), [ufc], new Map())).toMatchObject({ kind: "one", item: { id: 1 } });
  });

  it("lets an indexer id claim an item whose title differs, and survives bad external ids", () => {
    const dune = itemRow(1, "movie", "Dune", 2021, { imdb: "tt1160419" });
    const broken = { ...itemRow(2, "movie", "Other", 2000), externalIds: "{oops" };
    const outcome = aliases.resolveReleaseItem({ title: "Some.Other.Name.2021.1080p.WEB-GRP", imdbId: "tt1160419" } as any, parseReleaseTitle("Some.Other.Name.2021.1080p.WEB-GRP"), [broken, dune], new Map());
    expect(outcome).toMatchObject({ kind: "one", item: { id: 1 }, verdict: { matchType: "id" } });
  });
});
