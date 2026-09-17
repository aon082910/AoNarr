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

  it("skips a malformed entry (missing trash_id) without affecting the rest of the sync", async () => {
    const { syncTrashFormats } = await import("../src/services/trashSync.js");
    mockGithub(
      [
        { name: "malformed.json", download_url: "https://raw/malformed.json", type: "file" },
        { name: "valid-alongside-malformed.json", download_url: "https://raw/valid-alongside-malformed.json", type: "file" },
      ],
      {
        "https://raw/malformed.json": { name: "No Trash Id", specifications: [] },
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
    expect(await db.prepare("SELECT id FROM custom_formats WHERE trash_id = ?").get("trash-valid-alongside-1")).toBeDefined();
  });

  it("treats a per-file download failure or thrown error as skippable, without failing the whole sync", async () => {
    const { syncTrashFormats } = await import("../src/services/trashSync.js");
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
    expect(await db.prepare("SELECT id FROM custom_formats WHERE trash_id = ?").get("trash-collide-1")).toBeUndefined();
  });
});
