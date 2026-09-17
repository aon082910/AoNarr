import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function insertLocal(type: "movie" | "series", title: string, year: number | null): Promise<void> {
  await db
    .prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES (?, ?, ?, ?, 1, 1, 'unknown')")
    .run(type, title, title.toLowerCase(), year);
}

function mockFetchByUrl(responses: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const entry = responses[url];
      if (entry === undefined) return { ok: false, status: 404 } as any;
      return { ok: true, json: async () => entry } as any;
    })
  );
}

describe("compareFriendLibrary — Plex", () => {
  const cfg = { id: 1, name: "Friend Plex", type: "plex" as const, url: "http://plex.example.com:32400", token: "PLEXTOKEN" };
  const sectionsUrl = "http://plex.example.com:32400/library/sections?X-Plex-Token=PLEXTOKEN";

  it("returns titles the friend has that this library doesn't, across movie and show sections", async () => {
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    await insertLocal("movie", "Already Have This Movie", 2020);
    mockFetchByUrl({
      [sectionsUrl]: { MediaContainer: { Directory: [{ key: "1", type: "movie" }, { key: "2", type: "show" }] } },
      "http://plex.example.com:32400/library/sections/1/all?X-Plex-Token=PLEXTOKEN": {
        MediaContainer: { Metadata: [{ title: "Already Have This Movie", year: 2020 }, { title: "Missing Movie", year: 2021 }] },
      },
      "http://plex.example.com:32400/library/sections/2/all?X-Plex-Token=PLEXTOKEN": {
        MediaContainer: { Metadata: [{ title: "Missing Show", year: 2019 }] },
      },
    });

    const missing = await compareFriendLibrary(cfg);
    expect(missing.map((m) => m.title)).toEqual(["Missing Movie", "Missing Show"]);
    expect(missing.find((m) => m.title === "Missing Show")!.type).toBe("series");
  });

  it("skips non-movie/show sections (e.g. music) without requesting their items", async () => {
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === sectionsUrl) {
        return { ok: true, json: async () => ({ MediaContainer: { Directory: [{ key: "9", type: "artist" }] } }) } as any;
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const missing = await compareFriendLibrary(cfg);
    expect(missing).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the sections request itself fails", async () => {
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 }) as any));

    await expect(compareFriendLibrary(cfg)).rejects.toThrow(/401/);
  });

  it("skips a single section whose items request fails, without losing the other sections", async () => {
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    mockFetchByUrl({
      [sectionsUrl]: { MediaContainer: { Directory: [{ key: "1", type: "movie" }, { key: "2", type: "movie" }] } },
      "http://plex.example.com:32400/library/sections/2/all?X-Plex-Token=PLEXTOKEN": {
        MediaContainer: { Metadata: [{ title: "Recovered Section Movie", year: 2022 }] },
      },
      // Section 1's items URL is deliberately absent -> mockFetchByUrl returns ok:false for it.
    });

    const missing = await compareFriendLibrary(cfg);
    expect(missing.map((m) => m.title)).toEqual(["Recovered Section Movie"]);
  });
});

describe("compareFriendLibrary — Jellyfin/Emby", () => {
  it("queries the plain (non-/emby) API path for a jellyfin friend", async () => {
    const cfg = { id: 2, name: "Friend Jellyfin", type: "jellyfin" as const, url: "http://jf.example.com:8096", token: "JFTOKEN" };
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    mockFetchByUrl({
      "http://jf.example.com:8096/Users": [{ Id: "user-1" }],
      "http://jf.example.com:8096/Users/user-1/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProductionYear": {
        Items: [{ Name: "Jellyfin Only Movie", Type: "Movie", ProductionYear: 2018 }],
      },
    });

    const missing = await compareFriendLibrary(cfg);
    expect(missing.map((m) => m.title)).toEqual(["Jellyfin Only Movie"]);
  });

  it("queries the /emby-prefixed API path for an emby friend", async () => {
    const cfg = { id: 3, name: "Friend Emby", type: "emby" as const, url: "http://emby.example.com:8096", token: "EMBYTOKEN" };
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    mockFetchByUrl({
      "http://emby.example.com:8096/emby/Users": [{ Id: "user-9" }],
      "http://emby.example.com:8096/emby/Users/user-9/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProductionYear": {
        Items: [{ Name: "Emby Only Show", Type: "Series", ProductionYear: null }],
      },
    });

    const missing = await compareFriendLibrary(cfg);
    expect(missing.map((m) => m.title)).toEqual(["Emby Only Show"]);
  });

  it("returns nothing when the friend has zero users, without requesting items", async () => {
    const cfg = { id: 4, name: "Empty Jellyfin", type: "jellyfin" as const, url: "http://jf2.example.com:8096", token: "T" };
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "http://jf2.example.com:8096/Users") return { ok: true, json: async () => [] } as any;
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await compareFriendLibrary(cfg)).toEqual([]);
  });
});

describe("compareFriendLibrary — title/year matching and dedup", () => {
  const cfg = { id: 5, name: "Matching Friend", type: "jellyfin" as const, url: "http://match.example.com", token: "T" };
  const usersUrl = "http://match.example.com/Users";
  const itemsUrl = "http://match.example.com/Users/u/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProductionYear";

  it("matches titles case- and punctuation-insensitively", async () => {
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    await insertLocal("movie", "The Matrix", 1999);
    mockFetchByUrl({
      [usersUrl]: [{ Id: "u" }],
      [itemsUrl]: { Items: [{ Name: "the MATRIX!!", Type: "Movie", ProductionYear: 1999 }] },
    });

    expect(await compareFriendLibrary(cfg)).toEqual([]);
  });

  it("treats years within 1 of each other as the same release", async () => {
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    await insertLocal("movie", "Off By One Year", 2000);
    mockFetchByUrl({
      [usersUrl]: [{ Id: "u" }],
      [itemsUrl]: { Items: [{ Name: "Off By One Year", Type: "Movie", ProductionYear: 2001 }] },
    });

    expect(await compareFriendLibrary(cfg)).toEqual([]);
  });

  it("treats years more than 1 apart as a different release, reporting it missing", async () => {
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    await insertLocal("movie", "Different Cut Or Remake", 2000);
    mockFetchByUrl({
      [usersUrl]: [{ Id: "u" }],
      [itemsUrl]: { Items: [{ Name: "Different Cut Or Remake", Type: "Movie", ProductionYear: 2010 }] },
    });

    const missing = await compareFriendLibrary(cfg);
    expect(missing.map((m) => m.title)).toEqual(["Different Cut Or Remake"]);
  });

  it("treats a null year on either side as an automatic match", async () => {
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    await insertLocal("movie", "No Year Locally", null);
    mockFetchByUrl({
      [usersUrl]: [{ Id: "u" }],
      [itemsUrl]: { Items: [{ Name: "No Year Locally", Type: "Movie", ProductionYear: 1995 }] },
    });

    expect(await compareFriendLibrary(cfg)).toEqual([]);
  });

  it("only reports a duplicated friend title once, not once per occurrence", async () => {
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    mockFetchByUrl({
      [usersUrl]: [{ Id: "u" }],
      [itemsUrl]: {
        Items: [
          { Name: "Repeated Missing Movie", Type: "Movie", ProductionYear: 2005 },
          { Name: "Repeated Missing Movie", Type: "Movie", ProductionYear: 2005 },
        ],
      },
    });

    const missing = await compareFriendLibrary(cfg);
    expect(missing).toHaveLength(1);
  });

  it("sorts the missing list alphabetically by title", async () => {
    const { compareFriendLibrary } = await import("../src/services/friendLibraries.js");
    mockFetchByUrl({
      [usersUrl]: [{ Id: "u" }],
      [itemsUrl]: {
        Items: [
          { Name: "Zebra Movie", Type: "Movie", ProductionYear: 2001 },
          { Name: "Apple Movie", Type: "Movie", ProductionYear: 2002 },
          { Name: "Mango Movie", Type: "Movie", ProductionYear: 2003 },
        ],
      },
    });

    const missing = await compareFriendLibrary(cfg);
    expect(missing.map((m) => m.title)).toEqual(["Apple Movie", "Mango Movie", "Zebra Movie"]);
  });
});
