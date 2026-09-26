import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface GithubContentEntry {
  name: string;
  download_url: string;
  type: string;
}

/** Stubs the global fetch used by trashSync.ts: the first call (the GitHub directory listing) goes
 * to api.github.com and returns dirEntries; every other call is a per-file download whose response
 * is looked up by URL in fileResponses (missing => HTTP not-ok, the string "THROW" => a network
 * error), matching real TRaSH-Guides sync traffic without hitting the network. */
function mockGithub(dirEntries: GithubContentEntry[], fileResponses: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.startsWith("https://api.github.com/")) {
        return { ok: true, json: async () => dirEntries } as any;
      }
      const entry = fileResponses[url];
      if (entry === undefined) return { ok: false, status: 404 } as any;
      if (entry === "THROW") throw new Error("simulated network failure");
      return { ok: true, json: async () => entry } as any;
    })
  );
}

describe("syncTrashFormats", () => {
  it("returns an error result (without throwing) when the GitHub directory listing fails", async () => {
    const { syncTrashFormats } = await import("../src/services/trashSync.js");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as any));

    const result = await syncTrashFormats("radarr");
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.error).toMatch(/HTTP 503/);
  });

  it("keeps the listing failure as the app's last sync result", async () => {
    const { syncTrashFormats, getLastTrashSyncResult } = await import("../src/services/trashSync.js");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502 }) as any));

    const before = Date.now();
    await syncTrashFormats("sonarr");

    const stored = getLastTrashSyncResult("sonarr");
    expect(stored).toMatchObject({ app: "sonarr", added: 0, updated: 0, unsupported: [], partiallyUnsupported: [], failed: [] });
    expect(stored!.error).toMatch(/HTTP 502/);
    expect(Date.parse(stored!.finishedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("keeps a finished sync's counts and names as the app's last result, persisted to the settings table", async () => {
    const { syncTrashFormats, getLastTrashSyncResult } = await import("../src/services/trashSync.js");
    await db.prepare("INSERT INTO custom_formats (name, patterns, media_types, trash_id) VALUES ('Persist Manual', '[]', NULL, NULL)").run();
    mockGithub(
      [
        { name: "persist-added.json", download_url: "https://raw/persist-added.json", type: "file" },
        { name: "persist-partial.json", download_url: "https://raw/persist-partial.json", type: "file" },
        { name: "persist-unsupported.json", download_url: "https://raw/persist-unsupported.json", type: "file" },
        { name: "persist-collide.json", download_url: "https://raw/persist-collide.json", type: "file" },
      ],
      {
        "https://raw/persist-added.json": {
          trash_id: "persist-added",
          name: "Persist Added",
          specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "FLUX" } }],
        },
        "https://raw/persist-partial.json": {
          trash_id: "persist-partial",
          name: "Persist Partial",
          specifications: [
            { implementation: "ReleaseTitleSpecification", fields: { value: "\\bHDR\\b" } },
            { implementation: "LanguageSpecification", fields: { value: 1 } },
          ],
        },
        "https://raw/persist-unsupported.json": {
          trash_id: "persist-unsupported",
          name: "Persist Unsupported",
          specifications: [{ implementation: "LanguageSpecification", fields: { value: 1 } }],
        },
        "https://raw/persist-collide.json": {
          trash_id: "persist-collide",
          name: "Persist Manual",
          specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "NTb" } }],
        },
      }
    );

    const result = await syncTrashFormats("radarr");

    const stored = getLastTrashSyncResult("radarr");
    expect(stored).toMatchObject({
      app: "radarr",
      added: result.added,
      updated: result.updated,
      unsupported: ["Persist Unsupported"],
      partiallyUnsupported: [{ name: "Persist Partial", skipped: expect.any(Array) }],
      failed: [{ name: "Persist Manual", error: expect.stringContaining("already uses this name") }],
      error: null,
    });
    expect(stored!.added).toBe(2);
    expect(stored!.partiallyUnsupported[0].skipped.length).toBeGreaterThan(0);

    // The settings write is fire-and-forget, so wait for the row rather than assuming it landed.
    await vi.waitFor(async () => {
      const row = (await db.prepare("SELECT value FROM settings WHERE key = ?").get("trashSyncLastResultRadarr")) as { value: string } | undefined;
      expect(row && JSON.parse(row.value).finishedAt).toBe(stored!.finishedAt);
    });
  });

  it("reports a malformed specification list as failed instead of aborting the rest of the sync", async () => {
    const { syncTrashFormats, getLastTrashSyncResult } = await import("../src/services/trashSync.js");
    mockGithub(
      [
        { name: "null-spec.json", download_url: "https://raw/null-spec.json", type: "file" },
        { name: "after-null-spec.json", download_url: "https://raw/after-null-spec.json", type: "file" },
      ],
      {
        "https://raw/null-spec.json": { trash_id: "null-spec", name: "Null Spec Format", specifications: [null] },
        "https://raw/after-null-spec.json": {
          trash_id: "after-null-spec",
          name: "After Null Spec",
          specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "HONE" } }],
        },
      }
    );

    const result = await syncTrashFormats("radarr");

    expect(result.added).toBe(1);
    expect(result.failed).toEqual([{ name: "Null Spec Format", error: expect.any(String) }]);
    expect(getLastTrashSyncResult("radarr")!.failed.map((f) => f.name)).toEqual(["Null Spec Format"]);
    expect(await db.prepare("SELECT id FROM custom_formats WHERE trash_id = ?").get("after-null-spec")).toBeDefined();
  });

  it("filters the directory listing to .json files only, then adds a new format", async () => {
    const { syncTrashFormats } = await import("../src/services/trashSync.js");
    mockGithub(
      [
        { name: "readme.md", download_url: "https://raw/readme.md", type: "file" },
        { name: "a-folder", download_url: "https://raw/a-folder", type: "dir" },
        { name: "new-format.json", download_url: "https://raw/new-format.json", type: "file" },
      ],
      {
        "https://raw/new-format.json": {
          trash_id: "trash-new-1",
          name: "Sync New Format A",
          specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "FLUX" } }],
        },
      }
    );

    const result = await syncTrashFormats("radarr");
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    const row = (await db.prepare("SELECT * FROM custom_formats WHERE trash_id = ?").get("trash-new-1")) as any;
    expect(row).toBeDefined();
    expect(row.name).toBe("Sync New Format A");
    expect(JSON.parse(row.media_types)).toEqual(["movie", "ppv"]);
    expect(JSON.parse(row.patterns)).toEqual([{ type: "releaseGroup", patterns: ["FLUX"], negate: false }]);
  });

  it("scopes a newly added sonarr format to series/anime/sports instead of radarr's types", async () => {
    const { syncTrashFormats } = await import("../src/services/trashSync.js");
    mockGithub([{ name: "sonarr-format.json", download_url: "https://raw/sonarr-format.json", type: "file" }], {
      "https://raw/sonarr-format.json": {
        trash_id: "trash-sonarr-1",
        name: "Sync Sonarr Format",
        specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "NTb" } }],
      },
    });

    await syncTrashFormats("sonarr");
    const row = (await db.prepare("SELECT * FROM custom_formats WHERE trash_id = ?").get("trash-sonarr-1")) as any;
    expect(JSON.parse(row.media_types)).toEqual(["series", "anime", "sports"]);
  });

  it("updates an existing format (matched by trash_id) instead of inserting a duplicate", async () => {
    const { syncTrashFormats } = await import("../src/services/trashSync.js");
    await db
      .prepare(
        "INSERT INTO custom_formats (name, patterns, media_types, trash_id) VALUES ('Old Name Before Sync', '[]', '[\"movie\"]', 'trash-update-1')"
      )
      .run();
    mockGithub([{ name: "updated-format.json", download_url: "https://raw/updated-format.json", type: "file" }], {
      "https://raw/updated-format.json": {
        trash_id: "trash-update-1",
        name: "Updated Name After Sync",
        specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "SPARKS" } }],
      },
    });

    const result = await syncTrashFormats("radarr");
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    const row = (await db.prepare("SELECT * FROM custom_formats WHERE trash_id = ?").get("trash-update-1")) as any;
    expect(row.name).toBe("Updated Name After Sync");
    expect(JSON.parse(row.patterns)).toEqual([{ type: "releaseGroup", patterns: ["SPARKS"], negate: false }]);
  });

  it("reports a format with no translatable specifications as unsupported, without adding it", async () => {
    const { syncTrashFormats } = await import("../src/services/trashSync.js");
    mockGithub([{ name: "unsupported-format.json", download_url: "https://raw/unsupported-format.json", type: "file" }], {
      "https://raw/unsupported-format.json": {
        trash_id: "trash-unsupported-1",
        name: "Fully Unsupported Format",
        specifications: [{ implementation: "LanguageSpecification", fields: { value: 1 } }],
      },
    });

    const result = await syncTrashFormats("radarr");
    expect(result.unsupported).toEqual(["Fully Unsupported Format"]);
    expect(result.added).toBe(0);
    expect(await db.prepare("SELECT id FROM custom_formats WHERE trash_id = ?").get("trash-unsupported-1")).toBeUndefined();
  });

  it("reports a malformed entry (missing trash_id) as failed without affecting the rest of the sync", async () => {
    const { syncTrashFormats } = await import("../src/services/trashSync.js");
    mockGithub(
      [
        { name: "malformed.json", download_url: "https://raw/malformed.json", type: "file" },
        { name: "nameless.json", download_url: "https://raw/nameless.json", type: "file" },
        { name: "valid-alongside-malformed.json", download_url: "https://raw/valid-alongside-malformed.json", type: "file" },
      ],
      {
        "https://raw/malformed.json": { name: "No Trash Id", specifications: [] },
        "https://raw/nameless.json": { trash_id: "trash-nameless-1", specifications: "not-a-list" },
        "https://raw/valid-alongside-malformed.json": {
          trash_id: "trash-valid-alongside-1",
          name: "Valid Alongside Malformed",
          specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "EVO" } }],
        },
      }
    );

    const result = await syncTrashFormats("radarr");
    expect(result.added).toBe(1);
    expect(result.unsupported).not.toContain("No Trash Id");
    expect(result.failed).toEqual([
      { name: "No Trash Id", error: "not a valid custom format file" },
      { name: "nameless.json", error: "not a valid custom format file" },
    ]);
    expect(await db.prepare("SELECT id FROM custom_formats WHERE trash_id = ?").get("trash-valid-alongside-1")).toBeDefined();
    expect(await db.prepare("SELECT id FROM custom_formats WHERE trash_id = ?").get("trash-nameless-1")).toBeUndefined();
  });

  it("reports a per-file download failure or thrown error as failed, without failing the whole sync", async () => {
    const { syncTrashFormats, getLastTrashSyncResult } = await import("../src/services/trashSync.js");
    mockGithub(
      [
        { name: "broken.json", download_url: "https://raw/broken.json", type: "file" },
        { name: "throws.json", download_url: "https://raw/throws.json", type: "file" },
        { name: "fine.json", download_url: "https://raw/fine.json", type: "file" },
      ],
      {
        "https://raw/throws.json": "THROW",
        "https://raw/fine.json": {
          trash_id: "trash-fine-1",
          name: "Survives Alongside Failures",
          specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "GECKOS" } }],
        },
      }
    );

    const result = await syncTrashFormats("radarr");
    expect(result.added).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.failed).toEqual([
      { name: "broken.json", error: "download failed: HTTP 404" },
      { name: "throws.json", error: "download failed: simulated network failure" },
    ]);
    expect(getLastTrashSyncResult("radarr")!.failed.map((f) => f.name)).toEqual(["broken.json", "throws.json"]);
    expect(await db.prepare("SELECT id FROM custom_formats WHERE trash_id = ?").get("trash-fine-1")).toBeDefined();
  });

  it("logs and skips a name collision with an existing manually-created format instead of aborting", async () => {
    const { syncTrashFormats } = await import("../src/services/trashSync.js");
    await db.prepare("INSERT INTO custom_formats (name, patterns, media_types, trash_id) VALUES ('Manual Collide', '[]', NULL, NULL)").run();
    mockGithub([{ name: "collide.json", download_url: "https://raw/collide.json", type: "file" }], {
      "https://raw/collide.json": {
        trash_id: "trash-collide-1",
        name: "Manual Collide",
        specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "TRUFFLE" } }],
      },
    });

    const result = await syncTrashFormats("radarr");
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.failed).toEqual([{ name: "Manual Collide", error: expect.stringContaining("already uses this name") }]);
    expect(await db.prepare("SELECT id FROM custom_formats WHERE trash_id = ?").get("trash-collide-1")).toBeUndefined();
    const manual = (await db.prepare("SELECT * FROM custom_formats WHERE name = 'Manual Collide'").get()) as any;
    expect(manual.trash_id).toBeNull();
  });

  it("syncs a Sonarr format whose name an already-synced Radarr format uses, under an app-suffixed name", async () => {
    const { syncTrashFormats, appScopedFormatName } = await import("../src/services/trashSync.js");
    mockGithub([{ name: "br-disk.json", download_url: "https://raw/radarr-br-disk.json", type: "file" }], {
      "https://raw/radarr-br-disk.json": {
        trash_id: "radarr-br-disk",
        name: "Shared BR-DISK",
        specifications: [{ implementation: "ReleaseTitleSpecification", fields: { value: "\\bBR-?DISK\\b" } }],
      },
    });
    expect((await syncTrashFormats("radarr")).added).toBe(1);

    const sonarrFile = (value: string) => ({
      "https://raw/sonarr-br-disk.json": {
        trash_id: "sonarr-br-disk",
        name: "Shared BR-DISK",
        specifications: [{ implementation: "ReleaseTitleSpecification", fields: { value } }],
      },
    });
    mockGithub([{ name: "br-disk.json", download_url: "https://raw/sonarr-br-disk.json", type: "file" }], sonarrFile("\\bBR-?DISK\\b"));
    const sonarr = await syncTrashFormats("sonarr");

    expect(sonarr).toMatchObject({ added: 1, failed: [] });
    const radarrRow = (await db.prepare("SELECT * FROM custom_formats WHERE trash_id = 'radarr-br-disk'").get()) as any;
    expect(radarrRow.name).toBe("Shared BR-DISK");
    expect(JSON.parse(radarrRow.media_types)).toEqual(["movie", "ppv"]);
    const sonarrRow = (await db.prepare("SELECT * FROM custom_formats WHERE trash_id = 'sonarr-br-disk'").get()) as any;
    expect(sonarrRow.name).toBe("Shared BR-DISK (Sonarr)");
    expect(appScopedFormatName("Shared BR-DISK", "sonarr")).toBe(sonarrRow.name);
    expect(JSON.parse(sonarrRow.media_types)).toEqual(["series", "anime", "sports"]);

    // A re-sync updates the suffixed format in place instead of colliding on the plain name again.
    mockGithub([{ name: "br-disk.json", download_url: "https://raw/sonarr-br-disk.json", type: "file" }], sonarrFile("\\bBD-?DISK\\b"));
    const resync = await syncTrashFormats("sonarr");

    expect(resync).toMatchObject({ added: 0, updated: 1, failed: [] });
    const updated = (await db.prepare("SELECT * FROM custom_formats WHERE trash_id = 'sonarr-br-disk'").get()) as any;
    expect(updated.name).toBe("Shared BR-DISK (Sonarr)");
    expect(updated.patterns).toContain("BD-?DISK");
  });
});
