import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { tagFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { parseTagIds } from "../services/tagScope.js";
import { autoTagRulesUsingTag } from "../services/autoTag.js";

export const tagsRouter = Router();
tagsRouter.use(requireAdmin);

tagsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM tags ORDER BY name").all();
    res.json(rows.map(tagFromRow));
  })
);

tagsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const name = (req.body?.name ?? "").trim();
    if (!name) throw new HttpError(400, "name is required");
    await db.prepare(`INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = excluded.name`).run(name);
    const row = await db.prepare("SELECT * FROM tags WHERE name = ?").get(name);
    res.status(201).json(tagFromRow(row));
  })
);

tagsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const retentionDays = req.body?.retentionDays;
    await db
      .prepare("UPDATE tags SET retention_days = ? WHERE id = ?")
      .run(retentionDays === null || retentionDays === undefined ? null : Number(retentionDays), req.params.id);
    const row = await db.prepare("SELECT * FROM tags WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Tag not found");
    res.json(tagFromRow(row));
  })
);

/**
 * release_profiles.tag_ids/indexer_ids are JSON arrays with no foreign key. A profile scoped only
 * to a deleted tag/indexer would otherwise match nothing ever again while the Settings UI (which
 * only lists ids that still exist) shows it as unrestricted — drop the id, and clear the scope to
 * NULL ("every tag/indexer", matching what the UI shows) once nothing is left. With
 * `disableWhenEmptied` the profile is also switched off in that case: a rule meant for one indexer
 * must not start applying to all of them because that indexer was deleted.
 */
export async function removeReleaseProfileScopeId(
  column: "tag_ids" | "indexer_ids",
  id: number,
  options: { disableWhenEmptied?: boolean } = {}
): Promise<void> {
  const profiles = (await db.prepare(`SELECT id, ${column} AS ids FROM release_profiles WHERE ${column} IS NOT NULL`).all()) as {
    id: number;
    ids: string;
  }[];
  for (const p of profiles) {
    let ids: unknown;
    try {
      ids = JSON.parse(p.ids);
    } catch {
      continue;
    }
    if (!Array.isArray(ids)) continue;
    const remaining = ids.filter((x) => Number(x) !== id);
    if (remaining.length === ids.length) continue;
    await db
      .prepare(`UPDATE release_profiles SET ${column} = ? WHERE id = ?`)
      .run(remaining.length > 0 ? JSON.stringify(remaining) : null, p.id);
    if (remaining.length === 0 && options.disableWhenEmptied) {
      await db.prepare("UPDATE release_profiles SET enabled = 0 WHERE id = ?").run(p.id);
    }
  }
}

export interface TagUsage {
  delayProfiles: { id: number; label: string }[];
  releaseProfiles: { id: number; name: string }[];
  /** Indexers, download clients and import lists scoped to the tag, and root folders that give it to new titles. */
  indexers: { id: number; name: string }[];
  downloadClients: { id: number; name: string }[];
  importLists: { id: number; name: string }[];
  rootFolders: { id: number; name: string }[];
  /** Auto tagging rules that give the tag. */
  autoTagRules: { id: number; name: string }[];
  /** Items carrying the tag. Only a reason to refuse when the tag also sets a retention period. */
  items: number;
  retentionDays: number | null;
}

/** The rows of a table whose JSON `tag_ids`-style column lists the tag. */
async function rowsScopedToTag(table: string, column: string, labelColumn: string, tagId: number): Promise<{ id: number; name: string }[]> {
  const rows = (await db.prepare(`SELECT id, ${labelColumn} AS label, ${column} AS ids FROM ${table} WHERE ${column} IS NOT NULL`).all()) as {
    id: number;
    label: string | null;
    ids: string;
  }[];
  return rows
    .filter((r) => parseTagIds(r.ids).includes(tagId))
    .map((r) => ({ id: Number(r.id), name: r.label ?? `#${r.id}` }));
}

/** What would change if the tag went away. Starr refuses to delete a tag that is in use. */
export async function tagUsage(tagId: number): Promise<TagUsage> {
  const delayRows = (await db
    .prepare("SELECT id, usenet_delay_minutes, torrent_delay_minutes FROM delay_profiles WHERE tag_id = ?")
    .all(tagId)) as { id: number; usenet_delay_minutes: number; torrent_delay_minutes: number }[];
  const releaseRows = (await db.prepare("SELECT id, name, tag_ids FROM release_profiles WHERE tag_ids IS NOT NULL").all()) as {
    id: number;
    name: string;
    tag_ids: string;
  }[];
  const releaseProfiles = releaseRows.filter((p) => {
    try {
      const ids = JSON.parse(p.tag_ids);
      return Array.isArray(ids) && ids.some((x) => Number(x) === tagId);
    } catch {
      return false;
    }
  });
  const itemCount = Number(
    ((await db.prepare("SELECT COUNT(*) AS c FROM media_item_tags WHERE tag_id = ?").get(tagId)) as { c: number | string }).c
  );
  const tag = (await db.prepare("SELECT retention_days FROM tags WHERE id = ?").get(tagId)) as { retention_days: number | null } | undefined;
  return {
    delayProfiles: delayRows.map((p) => ({
      id: Number(p.id),
      label: `usenet ${p.usenet_delay_minutes} min / torrent ${p.torrent_delay_minutes} min`,
    })),
    releaseProfiles: releaseProfiles.map((p) => ({ id: Number(p.id), name: p.name })),
    indexers: await rowsScopedToTag("indexers", "tag_ids", "name", tagId),
    downloadClients: await rowsScopedToTag("download_clients", "tag_ids", "name", tagId),
    importLists: await rowsScopedToTag("import_lists", "tag_ids", "name", tagId),
    rootFolders: await rowsScopedToTag("root_folders", "default_tag_ids", "COALESCE(name, path)", tagId),
    autoTagRules: await autoTagRulesUsingTag(tagId),
    items: itemCount,
    retentionDays: tag?.retention_days == null ? null : Number(tag.retention_days),
  };
}

tagsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);

    // Deleting the tag would delete the delay profile scoped to it (ON DELETE CASCADE), widen a
    // release profile scoped only to it to every item, or drop a retention period from the items
    // that carry it. None of that is visible to whoever clicked delete, so the delete is refused.
    // The check and the delete share one transaction, so a profile created for the tag in between
    // cannot be removed by the cascade.
    const outcome = await db.transaction(async () => {
      if (!(await db.prepare("SELECT id FROM tags WHERE id = ?").get(id))) return { kind: "missing" as const };
      const usage = await tagUsage(id);
      const reasons: string[] = [];
      if (usage.delayProfiles.length > 0) reasons.push(`a delay profile (${usage.delayProfiles.map((p) => p.label).join("; ")})`);
      if (usage.releaseProfiles.length > 0) reasons.push(`release profile(s) ${usage.releaseProfiles.map((p) => `"${p.name}"`).join(", ")}`);
      if (usage.indexers.length > 0) reasons.push(`indexer(s) ${usage.indexers.map((p) => `"${p.name}"`).join(", ")}`);
      if (usage.downloadClients.length > 0) reasons.push(`download client(s) ${usage.downloadClients.map((p) => `"${p.name}"`).join(", ")}`);
      if (usage.importLists.length > 0) reasons.push(`import list(s) ${usage.importLists.map((p) => `"${p.name}"`).join(", ")}`);
      if (usage.rootFolders.length > 0) reasons.push(`root folder default(s) ${usage.rootFolders.map((p) => `"${p.name}"`).join(", ")}`);
      if (usage.autoTagRules.length > 0) reasons.push(`auto tagging rule(s) ${usage.autoTagRules.map((p) => `"${p.name}"`).join(", ")}`);
      if (usage.retentionDays != null && usage.items > 0) {
        reasons.push(
          usage.retentionDays < 0
            ? `a never-archive override on ${usage.items} item(s)`
            : `a ${usage.retentionDays}-day retention period on ${usage.items} item(s)`
        );
      }
      if (reasons.length > 0) return { kind: "inUse" as const, reasons, usage };
      await db.prepare("DELETE FROM tags WHERE id = ?").run(id);
      await removeReleaseProfileScopeId("tag_ids", id);
      return { kind: "deleted" as const };
    });

    if (outcome.kind === "missing") throw new HttpError(404, "Tag not found");
    if (outcome.kind === "inUse") {
      res.status(409).json({
        error: `This tag is in use by ${outcome.reasons.join(" and ")}. Remove or change that first, then delete the tag.`,
        usage: outcome.usage,
      });
      return;
    }
    res.status(204).send();
  })
);
