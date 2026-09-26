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

/** `bavail` is what the unprivileged server can actually write into; `bfree` also counts the blocks
 * reserved for root (5% by default on ext4). */
function mockFreeSpace(byPath: Record<string, { bfree: number; bavail: number; blocks: number; bsize: number }>): void {
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
      "/small": { bfree: 10, bavail: 5, blocks: 100, bsize: 1_000_000 },
      "/big": { bfree: 90, bavail: 85, blocks: 100, bsize: 1_000_000 },
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
      return { bfree: 1, bavail: 1, blocks: 10, bsize: 1_000_000 } as any;
    });

    expect(await autoSelectRootFolderId("faulttype")).toBe(reachableId);
    expect(unreachableId).not.toBe(reachableId);
  });

  it("ranks folders by the space the server can actually use, not blocks reserved for root", async () => {
    const { autoSelectRootFolderId } = await import("../src/services/rootFolderSelect.js");
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/mostly-reserved', 'reservedtype')").run();
    const usableId = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/usable', 'reservedtype')").run()).lastInsertRowid
    );
    mockFreeSpace({
      "/mostly-reserved": { bfree: 60, bavail: 10, blocks: 100, bsize: 1_000_000 },
      "/usable": { bfree: 40, bavail: 40, blocks: 100, bsize: 1_000_000 },
    });

    expect(await autoSelectRootFolderId("reservedtype")).toBe(usableId);
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
    mockFreeSpace({ "/over-quota": { bfree: 5, bavail: 5, blocks: 100, bsize: 1_000_000 } }); // 95% used

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
    mockFreeSpace({ "/under-quota": { bfree: 50, bavail: 50, blocks: 100, bsize: 1_000_000 } }); // 50% used

    expect(await isRootFolderOverQuota(id)).toBe(false);
  });

  it("counts blocks reserved for root as used, since the server can't write into them", async () => {
    const { isRootFolderOverQuota } = await import("../src/services/rootFolderSelect.js");
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO root_folders (path, media_type, quota_percent, pause_grabs_at_quota) VALUES ('/reserved-quota', 'quotatype', 90, 1)"
          )
          .run()
      ).lastInsertRowid
    );
    // 85% used going by bfree, but 10 of its 15 free blocks are reserved for root: 95% is out of reach.
    mockFreeSpace({ "/reserved-quota": { bfree: 15, bavail: 5, blocks: 100, bsize: 1_000_000 } });

    expect(await isRootFolderOverQuota(id)).toBe(true);
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
