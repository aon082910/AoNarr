import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let tmpDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-corruptcheck-"));
});

afterEach(async () => {
  const { setSetting } = await import("../src/services/settingsStore.js");
  setSetting("corruptMediaReviewEnabled", "0");
});

function goneFile(name: string): string {
  return path.join(tmpDir, name);
}

function realFile(name: string, content = "x"): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

async function insertMovie(filePath: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path, quality) VALUES ('movie', 'Movie', 'movie', 1, 1, 'unknown', ?, 'HD-1080p')`
        )
        .run(filePath)
    ).lastInsertRowid
  );
}

describe("checkForCorruptMedia — missing files", () => {
  it("flags a missing file as corrupt and recycles it (review disabled, the default)", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const id = await insertMovie(goneFile("missing-movie.mkv"));

    const result = await checkForCorruptMedia();

    expect(result.corrupt).toBeGreaterThanOrEqual(1);
    const row = (await db.prepare("SELECT has_file, path, quality FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(0);
    expect(row.path).toBeNull();
    expect(row.quality).toBeNull();
  });

  it("queues a missing file for review instead of recycling it when review is enabled", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    setSetting("corruptMediaReviewEnabled", "1");
    const filePath = goneFile("review-missing-movie.mkv");
    const id = await insertMovie(filePath);

    await checkForCorruptMedia();

    const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(1);
    expect(row.path).toBe(filePath);
    const reviewRow = (await db.prepare("SELECT * FROM corrupt_media_review WHERE table_name = 'media_items' AND row_id = ?").get(id)) as any;
    expect(reviewRow).toBeDefined();
    expect(reviewRow.reason).toBe("File is missing from disk");
  });

  it("does not queue a second review row for the same item on a repeated check", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    setSetting("corruptMediaReviewEnabled", "1");
    const id = await insertMovie(goneFile("repeated-review-movie.mkv"));

    await checkForCorruptMedia();
    await checkForCorruptMedia();

    const count = (await db.prepare("SELECT COUNT(*) AS c FROM corrupt_media_review WHERE table_name = 'media_items' AND row_id = ?").get(id)) as {
      c: number;
    };
    expect(Number(count.c)).toBe(1);
  });
});

describe("checkForCorruptMedia — non-probeable and skipped shapes", () => {
  it("never flags a non-probeable file type (e.g. an ebook) just because ffprobe can't read it", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const filePath = realFile("book.epub", "fake epub content");
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('book', 'Book', 'book', 1, 1, 'unknown', ?)`
          )
          .run(filePath)
      ).lastInsertRowid
    );

    await checkForCorruptMedia();

    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(1);
  });

  it("skips sub-items of a multiFilePerChild type (e.g. artist albums) entirely", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    const artistId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Artist', 'artist', 1, 0, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    const subId = Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Album', 1, 1, ?)")
          .run(artistId, goneFile("skipped-album"))
      ).lastInsertRowid
    );

    await checkForCorruptMedia();

    const row = (await db.prepare("SELECT has_file FROM sub_items WHERE id = ?").get(subId)) as any;
    expect(row.has_file).toBe(1);
  });
});

describe("checkForCorruptMedia — probeable file that ffprobe can't read", () => {
  it("flags a probeable file as corrupt after ffprobe fails (this environment has no ffprobe binary)", async () => {
    const { checkForCorruptMedia } = await import("../src/services/corruptMediaCheck.js");
    // A real, never-modified file so isStillBeingWritten's before/after size check reports "stable"
    // and the code proceeds past its false-positive guard into the genuine-failure path.
    const filePath = realFile("unprobeable-content.mkv", "not a real video file");
    const id = await insertMovie(filePath);

    const result = await checkForCorruptMedia();

    expect(result.corrupt).toBeGreaterThanOrEqual(1);
    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(0);
  }, 20000);
});

describe("isCorruptMediaReviewEnabled", () => {
  it("reflects the corruptMediaReviewEnabled setting", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { isCorruptMediaReviewEnabled } = await import("../src/services/corruptMediaCheck.js");
    expect(isCorruptMediaReviewEnabled()).toBe(false);

    setSetting("corruptMediaReviewEnabled", "1");
    expect(isCorruptMediaReviewEnabled()).toBe(true);
  });
});

describe("recycleAndMarkMissing", () => {
  it("clears file_path (not path) for an episode row", async () => {
    const { recycleAndMarkMissing } = await import("../src/services/corruptMediaCheck.js");
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Show', 'show', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    const epId = Number(
      (
        await db
          .prepare(
            "INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path, quality) VALUES (?, 1, 1, 1, 1, ?, 'HD-1080p')"
          )
          .run(showId, goneFile("ep-to-recycle.mkv"))
      ).lastInsertRowid
    );

    await recycleAndMarkMissing("episodes", epId, goneFile("ep-to-recycle.mkv"), "series", "Show — S01E01", showId);

    const row = (await db.prepare("SELECT has_file, file_path, quality FROM episodes WHERE id = ?").get(epId)) as any;
    expect(row.has_file).toBe(0);
    expect(row.file_path).toBeNull();
    expect(row.quality).toBeNull();
  });
});
