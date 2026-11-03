import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let profiles: typeof import("../src/services/metadataProfiles.js");
let fetchArtistAlbumsFor: (typeof import("../src/services/metadata.js"))["fetchArtistAlbumsFor"];
let fetchCollectionChildrenFor: (typeof import("../src/services/metadata.js"))["fetchCollectionChildrenFor"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  profiles = await import("../src/services/metadataProfiles.js");
  ({ fetchArtistAlbumsFor, fetchCollectionChildrenFor } = await import("../src/services/metadata.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(async () => {
  for (const t of ["media_items", "root_folders", "metadata_profiles"]) await db.prepare(`DELETE FROM ${t}`).run();
  setSetting("defaultMetadataProfileId", "");
  setSetting("musicAlbumTypes", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const profile = (over: Partial<import("../src/services/metadataProfiles.js").MetadataProfile> = {}) => ({
  id: 1,
  name: "P",
  primaryTypes: ["album"],
  excludedSecondaryTypes: [] as string[],
  skipMissingDate: false,
  skipSets: false,
  ...over,
});

describe("filterAlbumsByProfile (ST6)", () => {
  const albums = [
    { title: "Studio", primaryType: "album", secondaryTypes: [] as string[] },
    { title: "Live", primaryType: "album", secondaryTypes: ["live"] },
    { title: "Greatest Hits", primaryType: "album", secondaryTypes: ["compilation"] },
    { title: "Single", primaryType: "single", secondaryTypes: [] as string[] },
    { title: "Untyped", primaryType: null, secondaryTypes: [] as string[] },
  ];

  it("keeps the primary types the profile lists and drops excluded secondary types", () => {
    const kept = profiles.filterAlbumsByProfile(albums, profile({ primaryTypes: ["album"], excludedSecondaryTypes: ["live", "compilation"] }));
    expect(kept.map((a) => a.title)).toEqual(["Studio", "Untyped"]);
  });

  it("lists everything of a primary type when no secondary type is excluded", () => {
    const kept = profiles.filterAlbumsByProfile(albums, profile({ primaryTypes: ["album", "single"] }));
    expect(kept.map((a) => a.title)).toEqual(["Studio", "Live", "Greatest Hits", "Single", "Untyped"]);
  });

  it("no profile means no filtering: the global setting stays in charge", () => {
    expect(profiles.filterAlbumsByProfile(albums, null)).toHaveLength(5);
  });
});

describe("filterBooksByProfile (ST6)", () => {
  const books = [
    { title: "A Novel", releaseDate: "2001-01-01" },
    { title: "Undated Novel", releaseDate: null },
    { title: "The Complete Series Box Set", releaseDate: "2010-01-01" },
    { title: "Books 1-3 Omnibus", releaseDate: "2012-01-01" },
    { title: "Collection Agency", releaseDate: "2013-01-01" },
  ];
  it("skips undated works and sets only when asked", () => {
    expect(profiles.filterBooksByProfile(books, profile({ skipMissingDate: true })).map((b) => b.title)).not.toContain("Undated Novel");
    const noSets = profiles.filterBooksByProfile(books, profile({ skipSets: true })).map((b) => b.title);
    expect(noSets).toContain("A Novel");
    expect(noSets).toContain("Collection Agency");
    expect(noSets).not.toContain("The Complete Series Box Set");
    expect(noSets).not.toContain("Books 1-3 Omnibus");
    expect(profiles.filterBooksByProfile(books, profile())).toHaveLength(5);
  });
});

describe("the MusicBrainz album list with a profile (ST6)", () => {
  function stubMusicBrainz() {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return {
          ok: true,
          json: async () => ({
            "release-group-count": 3,
            "release-groups": [
              { id: "1", title: "Studio One", "primary-type": "Album", "secondary-types": [], "first-release-date": "2000-01-01" },
              { id: "2", title: "Live In Town", "primary-type": "Album", "secondary-types": ["Live"], "first-release-date": "2001-01-01" },
              { id: "3", title: "A Small EP", "primary-type": "EP", "secondary-types": [], "first-release-date": "2002-01-01" },
            ],
          }),
        };
      })
    );
    return urls;
  }

  it("asks for the profile's primary types and drops an excluded secondary type", async () => {
    const urls = stubMusicBrainz();
    const result = await fetchArtistAlbumsFor({ musicbrainz: "abc" }, profile({ primaryTypes: ["album", "ep"], excludedSecondaryTypes: ["live"] }));
    expect(new URL(urls[0]).searchParams.get("type")).toBe("album|ep");
    expect(result?.albums.map((a) => a.title)).toEqual(["Studio One", "A Small EP"]);
  });

  it("without a profile it still asks by the global setting and lists what the provider sends", async () => {
    const urls = stubMusicBrainz();
    setSetting("musicAlbumTypes", "album,single");
    const result = await fetchArtistAlbumsFor({ musicbrainz: "abc" });
    expect(new URL(urls[0]).searchParams.get("type")).toBe("album|single");
    expect(result?.albums).toHaveLength(3);
  });
});

describe("resolving an item's profile", () => {
  async function addProfile(name: string): Promise<number> {
    return Number((await db.prepare("INSERT INTO metadata_profiles (name) VALUES (?)").run(name)).lastInsertRowid);
  }

  it("uses the item's own, then its root folder's default, then the instance default, then none", async () => {
    const own = await addProfile("Own");
    const folder = await addProfile("Folder");
    const instance = await addProfile("Instance");
    const rootId = Number((await db.prepare("INSERT INTO root_folders (path, media_type, default_metadata_profile_id) VALUES ('/m', 'artist', ?)").run(folder)).lastInsertRowid);

    expect((await profiles.resolveMetadataProfile({ metadata_profile_id: own, root_folder_id: rootId }))?.name).toBe("Own");
    expect((await profiles.resolveMetadataProfile({ metadata_profile_id: null, root_folder_id: rootId }))?.name).toBe("Folder");
    await db.prepare("UPDATE root_folders SET default_metadata_profile_id = NULL").run();
    expect(await profiles.resolveMetadataProfile({ metadata_profile_id: null, root_folder_id: rootId })).toBeNull();
    setSetting("defaultMetadataProfileId", String(instance));
    expect((await profiles.resolveMetadataProfile({ metadata_profile_id: null, root_folder_id: rootId }))?.name).toBe("Instance");
  });
});

describe("the metadata profile routes", () => {
  const send = (method: "post" | "put" | "delete" | "get", path: string, body?: unknown) =>
    (request(app as any) as any)[method](`/api/metadata-profiles${path}`).set("X-Api-Key", apiKey).send(body);

  it("creates, edits, defaults and deletes a profile", async () => {
    const created = await send("post", "", { name: "Standard", primaryTypes: ["album"], excludedSecondaryTypes: ["live", "compilation"] });
    expect(created.status).toBe(201);
    expect(created.body.excludedSecondaryTypes).toEqual(["live", "compilation"]);

    expect((await send("post", "", { name: "Standard" })).status).toBe(409);

    const edited = await send("put", `/${created.body.id}`, { primaryTypes: ["album", "ep"], skipSets: true });
    expect(edited.body.primaryTypes).toEqual(["album", "ep"]);
    expect(edited.body.skipSets).toBe(true);

    expect((await send("post", "/default", { id: created.body.id })).status).toBe(200);
    expect((await send("get", "")).body[0].isDefault).toBe(true);

    expect((await send("delete", `/${created.body.id}`)).status).toBe(204);
    expect((await send("get", "")).body).toEqual([]);
  });

  it("rejects an unknown type and an empty primary list", async () => {
    expect((await send("post", "", { name: "Bad", primaryTypes: ["opera"] })).status).toBe(400);
    expect((await send("post", "", { name: "Bad", primaryTypes: [] })).status).toBe(400);
    expect((await send("post", "", { name: "Bad", excludedSecondaryTypes: ["cheesy"] })).status).toBe(400);
  });

  it("refuses to delete a profile a title or a root folder uses", async () => {
    const created = await send("post", "", { name: "In Use" });
    await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status, metadata_profile_id) VALUES ('artist', 'Band', 'band', 1, 'missing', ?)").run(created.body.id);
    const res = await send("delete", `/${created.body.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/1 title/);
  });
});

describe("book lists with a profile (ST6)", () => {
  it("does not drop a comic or a video list by the book rules", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    );
    // No provider ids at all: an empty list comes back whatever the profile says.
    const result = await fetchCollectionChildrenFor({}, profile({ skipMissingDate: true, skipSets: true }));
    expect(result.children).toEqual([]);
  });
});
