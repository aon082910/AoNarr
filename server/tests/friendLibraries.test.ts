import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
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

describe("friend library tokens at rest", () => {
  async function storedToken(id: number): Promise<string> {
    return ((await db.prepare("SELECT token FROM friend_libraries WHERE id = ?").get(id)) as { token: string }).token;
  }

  async function insertRaw(name: string, url: string, token: string): Promise<number> {
    return Number(
      (await db.prepare("INSERT INTO friend_libraries (name, type, url, token) VALUES (?, 'jellyfin', ?, ?)").run(name, url, token)).lastInsertRowid
    );
  }

  /** Stands in for the friend's Jellyfin server: records the token each request carried. */
  function stubJellyfin(url: string, title: string): { sentTokens: string[] } {
    const sentTokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (requestUrl: string, init?: { headers?: Record<string, string> }) => {
        sentTokens.push(init?.headers?.["X-Emby-Token"] ?? "");
        if (requestUrl === `${url}/Users`) return { ok: true, json: async () => [{ Id: "u" }] } as any;
        if (requestUrl.startsWith(`${url}/Users/u/Items`)) {
          return { ok: true, json: async () => ({ Items: [{ Name: title, Type: "Movie", ProductionYear: 2011 }] }) } as any;
        }
        return { ok: false, status: 404 } as any;
      })
    );
    return { sentTokens };
  }

  it("stores a new or replacement token encrypted and never returns it", async () => {
    const { decryptValue } = await import("../src/services/encryption.js");
    const created = await request(app)
      .post("/api/friend-libraries")
      .set("X-Api-Key", apiKey)
      .send({ name: "Encrypted Friend", type: "jellyfin", url: "http://enc-friend.example.com/", token: "friend-secret-token" });

    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain("friend-secret-token");
    const raw = await storedToken(created.body.id);
    expect(raw.startsWith("enc1:")).toBe(true);
    expect(decryptValue(raw)).toBe("friend-secret-token");

    const patched = await request(app).patch(`/api/friend-libraries/${created.body.id}`).set("X-Api-Key", apiKey).send({ token: "replacement-token" });
    const listed = await request(app).get("/api/friend-libraries").set("X-Api-Key", apiKey);

    expect(patched.status).toBe(200);
    expect(JSON.stringify(patched.body)).not.toContain("replacement-token");
    expect(JSON.stringify(listed.body)).not.toContain("enc1:");
    const rawAfter = await storedToken(created.body.id);
    expect(rawAfter.startsWith("enc1:")).toBe(true);
    expect(decryptValue(rawAfter)).toBe("replacement-token");
  });

  it("compares using the decrypted token", async () => {
    const created = await request(app)
      .post("/api/friend-libraries")
      .set("X-Api-Key", apiKey)
      .send({ name: "Comparing Friend", type: "jellyfin", url: "http://cmp-friend.example.com", token: "cmp-token" });
    const { sentTokens } = stubJellyfin("http://cmp-friend.example.com", "Encrypted Friend Only Film");

    const res = await request(app).get(`/api/friend-libraries/${created.body.id}/compare`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.map((m: { title: string }) => m.title)).toEqual(["Encrypted Friend Only Film"]);
    expect(sentTokens).toEqual(["cmp-token", "cmp-token"]);
  });

  it("keeps working with a token stored in plaintext before encryption, and re-saves it encrypted", async () => {
    const { decryptValue } = await import("../src/services/encryption.js");
    const id = await insertRaw("Legacy Friend", "http://legacy-friend.example.com", "legacy-plain-token");
    const { sentTokens } = stubJellyfin("http://legacy-friend.example.com", "Legacy Friend Only Film");

    const res = await request(app).get(`/api/friend-libraries/${id}/compare`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(sentTokens).toEqual(["legacy-plain-token", "legacy-plain-token"]);
    const raw = await storedToken(id);
    expect(raw.startsWith("enc1:")).toBe(true);
    expect(decryptValue(raw)).toBe("legacy-plain-token");
  });

  it("asks for the token to be re-entered when it can't be decrypted, without contacting the friend", async () => {
    const id = await insertRaw("Undecryptable Friend", "http://bad-key-friend.example.com", `enc1:${Buffer.alloc(40, 7).toString("base64")}`);
    const { sentTokens } = stubJellyfin("http://bad-key-friend.example.com", "Never Fetched");

    const res = await request(app).get(`/api/friend-libraries/${id}/compare`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/re-enter/);
    expect(sentTokens).toEqual([]);
  });

  it("encrypts plaintext friend tokens and remote-instance API keys at startup", async () => {
    const { decryptValue } = await import("../src/services/encryption.js");
    const { createApp } = await import("../src/app.js");
    const friendId = await insertRaw("Startup Friend", "http://startup-friend.example.com", "startup-plain-token");
    const remoteId = Number(
      (
        await db
          .prepare("INSERT INTO remote_instances (name, url, api_key) VALUES ('Startup Remote', 'http://startup-remote.local:9876', 'startup-plain-key')")
          .run()
      ).lastInsertRowid
    );

    await createApp();

    const token = await storedToken(friendId);
    const key = ((await db.prepare("SELECT api_key FROM remote_instances WHERE id = ?").get(remoteId)) as { api_key: string }).api_key;
    expect(token.startsWith("enc1:")).toBe(true);
    expect(decryptValue(token)).toBe("startup-plain-token");
    expect(key.startsWith("enc1:")).toBe(true);
    expect(decryptValue(key)).toBe("startup-plain-key");
  });
});
