import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

describe("placeAlbumFiles — multi-disc albums (CD1/CD2 subfolders)", () => {
  beforeAll(async () => {
    ({ db } = await setupTestDb());
  });

  it("collects every disc's tracks, offsets filename-based track matching per disc, and points file_path at the shared album folder", async () => {
    const { placeAlbumFiles } = await import("../src/services/importer.js");
    const { setSetting } = await import("../src/services/settingsStore.js");

    // Keeps the destination folder name predictable (the album's own folder name) rather than
    // going through the naming template, which isn't what this test is about.
    setSetting("namingEnabledArtist", "0");

    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-root-"));
    const rootFolderId = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'artist')").run(rootPath)).lastInsertRowid
    );
    const mediaItemId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status)
             VALUES ('artist', 'Test Artist', 'test artist', ?, 1, 0, 'unknown')`
          )
          .run(rootFolderId)
      ).lastInsertRowid
    );
    const subItemId = Number(
      (
        await db
          .prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Test Album [2CD]', 1, 0)`)
          .run(mediaItemId)
      ).lastInsertRowid
    );

    // Disc 1: tracks 1-3. Disc 2: tracks 4-5, continuing the album's numbering — the same
    // "offset by the previous medium's count" shape fetchAlbumTracksMusicbrainz produces, while
    // each disc's own filenames restart at "01".
    for (const n of [1, 2, 3, 4, 5]) {
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, ?, ?)").run(subItemId, n, `Track ${n}`);
    }

    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-download-"));
    const albumDir = path.join(downloadDir, "Test Album [2CD]");
    const cd1 = path.join(albumDir, "CD1");
    const cd2 = path.join(albumDir, "CD2");
    fs.mkdirSync(cd1, { recursive: true });
    fs.mkdirSync(cd2, { recursive: true });
    fs.writeFileSync(path.join(cd1, "01 - One.mp3"), "fake");
    fs.writeFileSync(path.join(cd1, "02 - Two.mp3"), "fake");
    fs.writeFileSync(path.join(cd1, "03 - Three.mp3"), "fake");
    fs.writeFileSync(path.join(cd2, "01 - Four.mp3"), "fake");
    fs.writeFileSync(path.join(cd2, "02 - Five.mp3"), "fake");

    const result = await placeAlbumFiles({
      itemId: mediaItemId,
      subItemId,
      anchorFile: path.join(cd1, "01 - One.mp3"),
      quality: null,
    });

    // All 5 files across both discs were moved, not just CD1's 3.
    expect(result.fileCount).toBe(5);
    expect(fs.readdirSync(result.destFolder)).toHaveLength(5);

    const subRow = (await db.prepare("SELECT has_file, file_path FROM sub_items WHERE id = ?").get(subItemId)) as any;
    expect(subRow.has_file).toBe(1);
    expect(subRow.file_path).toBe(result.destFolder);

    const trackRows = (await db
      .prepare("SELECT track_number, has_file, file_path FROM tracks WHERE sub_item_id = ? ORDER BY track_number")
      .all(subItemId)) as any[];
    expect(trackRows.every((t) => t.has_file === 1 && t.file_path)).toBe(true);

    // The real correctness check: CD2's own "02 - Five.mp3" (leading number 2) must resolve to
    // album track 5 (offset by disc 1's 3 tracks), not collide with disc 1's real track 2 — before
    // the fix, both CD1's "02 - Two.mp3" and CD2's "02 - Five.mp3" would match track_number=2 by
    // literal leading number, leaving track 2 pointing at the wrong file and track 5 unmatched.
    const track2 = trackRows.find((t) => t.track_number === 2)!;
    const track5 = trackRows.find((t) => t.track_number === 5)!;
    expect(path.basename(track2.file_path)).toBe("02 - Two.mp3");
    expect(path.basename(track5.file_path)).toBe("02 - Five.mp3");

    // Nothing left behind in either disc subfolder — lets the caller's cleanup delete the whole
    // (now-empty) multi-disc download folder.
    expect(fs.readdirSync(cd1)).toHaveLength(0);
    expect(fs.readdirSync(cd2)).toHaveLength(0);
  });
});

describe("Scan & Import — multi-disc albums already organized on disk (CD1/CD2 subfolders)", () => {
  it("groups both discs under one album sub_item, points file_path at the shared album folder, and doesn't let a later disc's track collide with an earlier disc's", async () => {
    const { scanAndImportLibrary } = await import("../src/services/libraryScan.js");

    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-scanroot-"));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'artist')").run(rootPath);

    const albumDir = path.join(rootPath, "Scan Artist", "Scan Album [2CD]");
    const cd1 = path.join(albumDir, "CD1");
    const cd2 = path.join(albumDir, "CD2");
    fs.mkdirSync(cd1, { recursive: true });
    fs.mkdirSync(cd2, { recursive: true });
    fs.writeFileSync(path.join(cd1, "01 - One.mp3"), "fake");
    fs.writeFileSync(path.join(cd1, "02 - Two.mp3"), "fake");
    fs.writeFileSync(path.join(cd2, "01 - Three.mp3"), "fake");

    await scanAndImportLibrary("artist");

    const mediaRow = (await db.prepare("SELECT id FROM media_items WHERE type = 'artist' AND title = ?").get("Scan Artist")) as any;
    expect(mediaRow).toBeDefined();

    const subRows = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").all(mediaRow.id)) as any[];
    // Both discs' files must land under ONE album sub_item, not two separate ones.
    expect(subRows).toHaveLength(1);
    expect(subRows[0].file_path).toBe(albumDir); // the shared album folder, not CD1 specifically

    const trackRows = (await db
      .prepare("SELECT track_number, file_path FROM tracks WHERE sub_item_id = ? ORDER BY track_number")
      .all(subRows[0].id)) as any[];
    expect(trackRows).toHaveLength(3);
    // Every row got its own track_number — before the fix, CD2's "01 - Three.mp3" would collide
    // with (and silently overwrite) CD1's real track 1 by literal leading number, leaving only 2
    // rows total and CD1's own track 1 pointing at CD2's file instead of its own.
    expect(new Set(trackRows.map((t) => t.track_number)).size).toBe(3);
    const cd1TrackCount = trackRows.filter((t) => t.file_path.includes(`${path.sep}CD1${path.sep}`)).length;
    const cd2TrackCount = trackRows.filter((t) => t.file_path.includes(`${path.sep}CD2${path.sep}`)).length;
    expect(cd1TrackCount).toBe(2);
    expect(cd2TrackCount).toBe(1);
  });
});
