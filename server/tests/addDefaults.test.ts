import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchMovieByTmdbId = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/metadata.js")>()),
  fetchMovieByTmdbId: (...args: unknown[]) => fetchMovieByTmdbId(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let finishWantedAdd: (typeof import("../src/services/addDefaults.js"))["finishWantedAdd"];
let resetReleaseLookupBreaker: (typeof import("../src/services/addDefaults.js"))["resetReleaseLookupBreaker"];
let setSetting: (key: string, value: string) => void;
let rootDir: string;
let rootFolderId: number;
let counter = 0;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ finishWantedAdd, resetReleaseLookupBreaker } = await import("../src/services/addDefaults.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-adddefaults-"));
  rootFolderId = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(rootDir)).lastInsertRowid);
});

beforeEach(() => {
  fetchMovieByTmdbId.mockReset();
  resetReleaseLookupBreaker();
  setSetting("defaultMinimumAvailability", "");
  setSetting("tmdbApiKey", "test-key");
  setSetting("createEmptyFoldersOnAdd", "");
});

async function addMovie(title: string, extra: { releaseDate?: string; minimumAvailability?: string } = {}): Promise<number> {
  counter++;
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, external_ids, root_folder_id, release_date, minimum_availability, monitored, status)
       VALUES ('movie', ?, ?, 2031, ?, ?, ?, ?, 1, 'missing')`
    )
    .run(title, title.toLowerCase(), JSON.stringify({ tmdb: String(9000 + counter) }), rootFolderId, extra.releaseDate ?? null, extra.minimumAvailability ?? null);
  return Number(result.lastInsertRowid);
}

async function rowOf(id: number) {
  return (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
}

describe("finishWantedAdd (ST3)", () => {
  it("gives the item the default minimum availability, and the dates and runtime TMDB has", async () => {
    setSetting("defaultMinimumAvailability", "released");
    fetchMovieByTmdbId.mockResolvedValue({ releaseDate: "2031-05-01", digitalReleaseDate: "2031-08-01", physicalReleaseDate: "2031-09-01", runtimeMinutes: 128 });
    const id = await addMovie("Future Film");

    await finishWantedAdd(id);

    const row = await rowOf(id);
    expect(row.minimum_availability).toBe("released");
    expect([row.release_date, row.digital_release_date, row.physical_release_date, Number(row.runtime_minutes)]).toEqual(["2031-05-01", "2031-08-01", "2031-09-01", 128]);
  });

  it("makes the search gate hold an unreleased film that came from a list", async () => {
    const { isReleaseAvailableForSearch } = await import("../src/services/scheduler.js");
    const { mediaItemFromRow } = await import("../src/db/mappers.js");
    setSetting("defaultMinimumAvailability", "released");
    fetchMovieByTmdbId.mockResolvedValue({ releaseDate: "2031-05-01", digitalReleaseDate: null, physicalReleaseDate: null, runtimeMinutes: null });
    const id = await addMovie("Held Back Film");

    await finishWantedAdd(id);

    expect(isReleaseAvailableForSearch(mediaItemFromRow(await rowOf(id)))).toBe(false);
  });

  it("does not ask TMDB when the default never waits ('announced')", async () => {
    setSetting("defaultMinimumAvailability", "announced");
    const id = await addMovie("Announced Film");

    await finishWantedAdd(id);

    expect(fetchMovieByTmdbId).not.toHaveBeenCalled();
    expect((await rowOf(id)).minimum_availability).toBe("announced");
  });

  it("does not ask TMDB for 'inCinemas' when the source already gave the release date, and keeps that date", async () => {
    setSetting("defaultMinimumAvailability", "inCinemas");
    const id = await addMovie("Dated Film");

    await finishWantedAdd(id, { releaseDate: "2031-07-04" });

    expect(fetchMovieByTmdbId).not.toHaveBeenCalled();
    expect((await rowOf(id)).release_date).toBe("2031-07-04");
  });

  it("keeps an availability the item already has, and a date it already has", async () => {
    setSetting("defaultMinimumAvailability", "released");
    fetchMovieByTmdbId.mockResolvedValue({ releaseDate: "2040-01-01", digitalReleaseDate: null, physicalReleaseDate: null, runtimeMinutes: null });
    const id = await addMovie("Chosen Film", { minimumAvailability: "inCinemas", releaseDate: "2031-05-01" });

    await finishWantedAdd(id, { releaseDate: "2035-01-01" });

    const row = await rowOf(id);
    expect(row.minimum_availability).toBe("inCinemas");
    expect(row.release_date).toBe("2031-05-01");
  });

  it("never throws, and still adds the item, when TMDB fails", async () => {
    setSetting("defaultMinimumAvailability", "released");
    fetchMovieByTmdbId.mockRejectedValue(new Error("TMDB down"));
    const id = await addMovie("No Dates Film");

    await expect(finishWantedAdd(id)).resolves.toBeUndefined();

    expect((await rowOf(id)).minimum_availability).toBe("released");
  });

  it("stops asking after three failures in a row, so a long list does not wait out TMDB for every item (review F13)", async () => {
    setSetting("defaultMinimumAvailability", "released");
    fetchMovieByTmdbId.mockRejectedValue(new Error("TMDB down"));

    for (let i = 0; i < 6; i++) await finishWantedAdd(await addMovie(`Outage ${i}`));

    expect(fetchMovieByTmdbId).toHaveBeenCalledTimes(3);
  });

  it("starts asking again once the breaker is reset, and a success clears the count", async () => {
    setSetting("defaultMinimumAvailability", "released");
    fetchMovieByTmdbId.mockRejectedValueOnce(new Error("blip")).mockRejectedValueOnce(new Error("blip"));
    fetchMovieByTmdbId.mockResolvedValue({ releaseDate: "2031-05-01", digitalReleaseDate: null, physicalReleaseDate: null, runtimeMinutes: null });

    for (let i = 0; i < 5; i++) await finishWantedAdd(await addMovie(`Blippy ${i}`));

    expect(fetchMovieByTmdbId).toHaveBeenCalledTimes(5);
  });

  it("creates the item's library folder when 'create empty folders on add' is on", async () => {
    setSetting("createEmptyFoldersOnAdd", "1");
    const id = await addMovie("Folder Film");

    await finishWantedAdd(id);

    expect(fs.readdirSync(rootDir).some((name) => name.includes("Folder Film"))).toBe(true);
  });

  it("does nothing for a missing item", async () => {
    await expect(finishWantedAdd(999999)).resolves.toBeUndefined();
    await expect(finishWantedAdd(null)).resolves.toBeUndefined();
  });
});
