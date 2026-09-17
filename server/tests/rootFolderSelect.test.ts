import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFreeSpace(byPath: Record<string, { bfree: number; blocks: number; bsize: number }>): void {
  vi.spyOn(fs, "statfsSync").mockImplementation((p: any) => {
    const stat = byPath[p];
    if (!stat) throw new Error(`unexpected path in test: ${p}`);
    return stat as any;
  });
}

describe("autoSelectRootFolderId", () => {
  it("returns null when the media type has no root folders configured", async () => {
    const { autoSelectRootFolderId } = await import("../src/services/rootFolderSelect.js");
    expect(await autoSelectRootFolderId("nonexistent-type-for-this-test")).toBeNull();
  });

  it("returns the only folder without needing to check disk space at all", async () => {
    const { autoSelectRootFolderId } = await import("../src/services/rootFolderSelect.js");
    const id = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/only/one', 'onlyonetype')").run()).lastInsertRowid
    );
    const statfsSpy = vi.spyOn(fs, "statfsSync");

    expect(await autoSelectRootFolderId("onlyonetype")).toBe(id);
    expect(statfsSpy).not.toHaveBeenCalled();
  });

  it("picks the folder with more free space when there are several", async () => {
    const { autoSelectRootFolderId } = await import("../src/services/rootFolderSelect.js");
    const smallId = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/small', 'multitype')").run()).lastInsertRowid
    );
    const bigId = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/big', 'multitype')").run()).lastInsertRowid
    );
    mockFreeSpace({
      "/small": { bfree: 10, blocks: 100, bsize: 1_000_000 },
      "/big": { bfree: 90, blocks: 100, bsize: 1_000_000 },
    });

    expect(await autoSelectRootFolderId("multitype")).toBe(bigId);
    expect(smallId).not.toBe(bigId);
  });

  it("treats an unreachable path as least-preferred rather than throwing", async () => {
    const { autoSelectRootFolderId } = await import("../src/services/rootFolderSelect.js");
    const unreachableId = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/unreachable', 'faulttype')").run()).lastInsertRowid
    );
    const reachableId = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/reachable', 'faulttype')").run()).lastInsertRowid
    );
    vi.spyOn(fs, "statfsSync").mockImplementation((p: any) => {
      if (p === "/unreachable") throw new Error("ENOENT");
      return { bfree: 1, blocks: 10, bsize: 1_000_000 } as any;
    });

    expect(await autoSelectRootFolderId("faulttype")).toBe(reachableId);
    expect(unreachableId).not.toBe(reachableId);
  });
});

describe("isRootFolderOverQuota", () => {
  it("returns false for a null root folder id", async () => {
    const { isRootFolderOverQuota } = await import("../src/services/rootFolderSelect.js");
    expect(await isRootFolderOverQuota(null)).toBe(false);
  });

  it("returns false when the folder has no quota configured", async () => {
    const { isRootFolderOverQuota } = await import("../src/services/rootFolderSelect.js");
    const id = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/no-quota', 'quotatype')").run()).lastInsertRowid
    );
    expect(await isRootFolderOverQuota(id)).toBe(false);
  });

  it("returns true once usage crosses the configured quota percentage", async () => {
    const { isRootFolderOverQuota } = await import("../src/services/rootFolderSelect.js");
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO root_folders (path, media_type, quota_percent, pause_grabs_at_quota) VALUES ('/over-quota', 'quotatype', 90, 1)"
          )
          .run()
      ).lastInsertRowid
    );
    mockFreeSpace({ "/over-quota": { bfree: 5, blocks: 100, bsize: 1_000_000 } }); // 95% used

    expect(await isRootFolderOverQuota(id)).toBe(true);
  });

  it("returns false while usage is still under the configured quota percentage", async () => {
    const { isRootFolderOverQuota } = await import("../src/services/rootFolderSelect.js");
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO root_folders (path, media_type, quota_percent, pause_grabs_at_quota) VALUES ('/under-quota', 'quotatype', 90, 1)"
          )
          .run()
      ).lastInsertRowid
    );
    mockFreeSpace({ "/under-quota": { bfree: 50, blocks: 100, bsize: 1_000_000 } }); // 50% used

    expect(await isRootFolderOverQuota(id)).toBe(false);
  });

  it("never reports over-quota for an unreachable path", async () => {
    const { isRootFolderOverQuota } = await import("../src/services/rootFolderSelect.js");
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO root_folders (path, media_type, quota_percent, pause_grabs_at_quota) VALUES ('/gone', 'quotatype', 50, 1)"
          )
          .run()
      ).lastInsertRowid
    );
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(await isRootFolderOverQuota(id)).toBe(false);
  });
});
