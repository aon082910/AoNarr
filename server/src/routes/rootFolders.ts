import path from "node:path";
import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { rootFolderFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { isValidMediaType } from "../services/mediaTypes.js";
import { deleteMediaItemCascade } from "./media.js";
import { auditActor, logAuditEvent } from "../services/audit.js";
import { startRootFolderMoveJob } from "../services/titleMove.js";
import { statfsAsync } from "../services/fsAsync.js";
import { assertWritableRootFolder, validateNewRootFolder } from "../services/rootFolderCheck.js";
import { isMonitorMode, isNewItemMode } from "../services/monitorModes.js";
import { checkedTagIdsColumn } from "../services/tagScope.js";

const ROOT_FOLDER_STATFS_TIMEOUT_MS = 5000;

export const rootFoldersRouter = Router();
rootFoldersRouter.use(requireAdmin);

rootFoldersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM root_folders").all();
    res.json(
      await Promise.all(
        rows.map(async (row) => {
          const folder = rootFolderFromRow(row);
          // statfsAsync: a dead mount shows as unknown free space for that folder instead of freezing the server.
          const stat = await statfsAsync(folder.path, ROOT_FOLDER_STATFS_TIMEOUT_MS).catch(() => null);
          if (!stat) return { ...folder, freeBytes: null, totalBytes: null, percentUsed: null };
          const freeBytes = stat.bavail * stat.bsize;
          const totalBytes = stat.blocks * stat.bsize;
          // Unrounded — rootFolderSelect.ts's isRootFolderOverQuota() compares this same percentage
          // against quotaPercent without rounding either, so the "over quota" badge here has to
          // match that unrounded comparison exactly (round only for display, in the frontend).
          const percentUsed = totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes) * 100 : null;
          return { ...folder, freeBytes, totalBytes, percentUsed };
        })
      )
    );
  })
);

rootFoldersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.path || !b.mediaType) throw new HttpError(400, "path and mediaType are required");
    if (!isValidMediaType(b.mediaType)) throw new HttpError(400, `Unknown media type "${b.mediaType}"`);
    if (b.readOnly !== undefined && typeof b.readOnly !== "boolean") throw new HttpError(400, "readOnly must be true or false");
    const readOnly = b.readOnly === true;
    const folderPath = await validateNewRootFolder(b.path, { readOnly });
    const result = await db.prepare("INSERT INTO root_folders (path, media_type, read_only) VALUES (?, ?, ?)").run(folderPath, b.mediaType, readOnly ? 1 : 0);
    const row = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(rootFolderFromRow(row));
  })
);

/** The largest value a Postgres INTEGER column holds. */
const MAX_INTEGER_COLUMN = 2_147_483_647;

/** A nullable limit from the request body: null turns it off; anything else must be a number from
 * 0 up to `max`, stored rounded since both columns are integers and Postgres rejects a fraction. */
function optionalWholeNumber(value: unknown, field: string, max: number): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw new HttpError(400, `${field} must be a number from 0 to ${max}, or null to turn it off`);
  }
  return Math.round(n);
}

rootFoldersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(typeof b.name === "string" && b.name.trim() ? b.name.trim() : null);
    }
    if (b.quotaPercent !== undefined) {
      sets.push("quota_percent = ?");
      values.push(optionalWholeNumber(b.quotaPercent, "quotaPercent", 100));
    }
    if (b.pauseGrabsAtQuota !== undefined) {
      sets.push("pause_grabs_at_quota = ?");
      values.push(b.pauseGrabsAtQuota ? 1 : 0);
    }
    if (b.readOnly !== undefined) {
      if (typeof b.readOnly !== "boolean") throw new HttpError(400, "readOnly must be true or false");
      // Making a library writable again is the moment to find out that its folder is not.
      if (!b.readOnly) {
        const current = (await db.prepare("SELECT path FROM root_folders WHERE id = ?").get(req.params.id)) as { path: string } | undefined;
        if (current) await assertWritableRootFolder(path.resolve(current.path), current.path);
      }
      sets.push("read_only = ?");
      values.push(b.readOnly ? 1 : 0);
    }
    if (b.minFreeSpaceGb !== undefined) {
      sets.push("min_free_space_gb = ?");
      values.push(optionalWholeNumber(b.minFreeSpaceGb, "minFreeSpaceGb", MAX_INTEGER_COLUMN));
    }
    // What is added into the folder starts from these (see services/rootFolderDefaults.ts); null clears one.
    for (const [field, column, table] of [
      ["defaultQualityProfileId", "default_quality_profile_id", "quality_profiles"],
      ["defaultMetadataProfileId", "default_metadata_profile_id", "metadata_profiles"],
    ] as const) {
      if (b[field] === undefined) continue;
      const id = b[field] === null || b[field] === "" ? null : Number(b[field]);
      if (id !== null && (!Number.isInteger(id) || !(await db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ?`).get(id)))) {
        throw new HttpError(400, `${field} must be an existing profile, or null`);
      }
      sets.push(`${column} = ?`);
      values.push(id);
    }
    if (b.defaultMonitor !== undefined) {
      if (b.defaultMonitor !== null && !isMonitorMode(b.defaultMonitor)) throw new HttpError(400, `Unknown defaultMonitor "${b.defaultMonitor}"`);
      sets.push("default_monitor = ?");
      values.push(b.defaultMonitor);
    }
    if (b.defaultMonitorNewItems !== undefined) {
      if (b.defaultMonitorNewItems !== null && !isNewItemMode(b.defaultMonitorNewItems)) throw new HttpError(400, "defaultMonitorNewItems must be all, none or new");
      sets.push("default_monitor_new_items = ?");
      values.push(b.defaultMonitorNewItems);
    }
    if (b.defaultTagIds !== undefined) {
      try {
        sets.push("default_tag_ids = ?");
        values.push((await checkedTagIdsColumn(b.defaultTagIds)) ?? null);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE root_folders SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Root folder not found");
    res.json(rootFolderFromRow(row));
  })
);

/**
 * Sonarr/Radarr's real "move root folder" action: physically relocates every media item currently in this folder to a
 * different one (the same media type: moving Movies into a Books folder makes no sense), rather than the PATCH route's
 * plain DB-pointer repoint, which would desync `root_folder_id` from where the files live on disk.
 *
 * Each title moves with its whole own folder (artwork, NFO, subtitles, extras; for Music and Audiobooks the artist's or
 * author's folder with its albums), see services/titleMove.ts. It runs as one tracked background job (the progress
 * widget), one title at a time; the request answers at once with the job's id. A title that cannot be moved stays
 * pointed at the source folder and is counted as failed.
 */
rootFoldersRouter.post(
  "/:id/move-to/:destinationId",
  asyncHandler(async (req, res) => {
    const source = (await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(req.params.id)) as any;
    if (!source) throw new HttpError(404, "Source root folder not found");
    const destination = (await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(req.params.destinationId)) as any;
    if (!destination) throw new HttpError(404, "Destination root folder not found");
    if (source.media_type !== destination.media_type) {
      throw new HttpError(400, `Can't move ${source.media_type} items into a ${destination.media_type} folder`);
    }
    if (source.id === destination.id) throw new HttpError(400, "Source and destination are the same folder");
    // A read-only library is one AoNarr never writes to: nothing is moved into it, and nothing is taken out of it.
    if (Number(destination.read_only)) throw new HttpError(400, "The destination is a read-only library: nothing is moved into it");
    if (Number(source.read_only)) throw new HttpError(400, "The source is a read-only library: its files are not moved out of it");

    const items = (await db.prepare("SELECT id, title FROM media_items WHERE root_folder_id = ?").all(source.id)) as {
      id: number;
      title: string;
    }[];
    if (items.length === 0) {
      res.json({ started: true, itemCount: 0 });
      return;
    }

    const actor = auditActor(req);
    const jobId = startRootFolderMoveJob(source, destination, items, ({ moved, failed }) => {
      logAuditEvent(actor.userId, actor.username, "root_folder_moved", `${source.path} → ${destination.path} (${moved} item(s)${failed > 0 ? `, ${failed} failed` : ""})`);
    });
    res.json({ started: true, itemCount: items.length, jobId });
  })
);

/**
 * What removing a root folder would do to the items that use it: they keep their rows but lose the folder, so every
 * import for them is skipped until they are given another. The Settings page shows the count before it asks.
 */
rootFoldersRouter.get(
  "/:id/impact",
  asyncHandler(async (req, res) => {
    const folder = await db.prepare("SELECT id FROM root_folders WHERE id = ?").get(req.params.id);
    if (!folder) throw new HttpError(404, "Root folder not found");
    const items = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE root_folder_id = ?").get(req.params.id)) as { c: number | string };
    const withFiles = (await db
      .prepare("SELECT COUNT(*) AS c FROM media_items WHERE root_folder_id = ? AND has_file = 1")
      .get(req.params.id)) as { c: number | string };
    // The folders the titles could be moved to first: the same type, writable.
    const mine = (await db.prepare("SELECT media_type FROM root_folders WHERE id = ?").get(req.params.id)) as { media_type: string };
    const others = (await db
      .prepare("SELECT id, path, name FROM root_folders WHERE media_type = ? AND id <> ? AND read_only = 0 ORDER BY id")
      .all(mine.media_type, req.params.id)) as { id: number; path: string; name: string | null }[];
    res.json({
      itemCount: Number(items.c),
      itemsWithFiles: Number(withFiles.c),
      otherFolders: others.map((o) => ({ id: Number(o.id), path: o.path, name: o.name })),
    });
  })
);

/**
 * Removes the folder row. A folder that still has titles is refused (409, code root_folder_in_use) unless `?force=1`:
 * the titles then keep their rows, untied from any folder. `?deleteMedia=1` opts into removing those titles too (the
 * same untrack-only-by-default / `?deleteFiles=1`-also-recycles-files behavior the single-item delete route has).
 */
rootFoldersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const folder = (await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(req.params.id)) as any;
    if (!folder) throw new HttpError(404, "Root folder not found");

    // Removing a folder that still has titles leaves them without a place to import into: say so, and move them first
    // or repeat with force=1 (or deleteMedia=1, which removes the titles too).
    if (req.query.deleteMedia !== "1" && req.query.force !== "1") {
      const inUse = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE root_folder_id = ?").get(req.params.id)) as { c: number | string };
      if (Number(inUse.c) > 0) {
        throw new HttpError(
          409,
          `${Number(inUse.c)} title(s) still use this root folder. Move them to another root folder first, or repeat with force=1 to leave them without a folder (or deleteMedia=1 to remove them).`,
          "root_folder_in_use"
        );
      }
    }

    let removedCount = 0;
    if (req.query.deleteMedia === "1") {
      const items = (await db.prepare("SELECT * FROM media_items WHERE root_folder_id = ?").all(req.params.id)) as any[];
      for (const item of items) {
        await deleteMediaItemCascade(item, req.query.deleteFiles === "1");
        removedCount++;
      }
    }

    await db.prepare("DELETE FROM root_folders WHERE id = ?").run(req.params.id);
    const actor = auditActor(req);
    logAuditEvent(
      actor.userId,
      actor.username,
      "root_folder_removed",
      `${folder.path}${removedCount > 0 ? ` — ${removedCount} media item(s) removed${req.query.deleteFiles === "1" ? " (files recycled)" : ""}` : ""}`
    );
    res.status(204).send();
  })
);
