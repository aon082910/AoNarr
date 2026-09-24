import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { releaseProfileFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const releaseProfilesRouter = Router();
releaseProfilesRouter.use(requireAdmin);

function normalizeTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
}

function normalizePreferred(value: unknown): { term: string; score: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => ({ term: String(v?.term ?? "").trim(), score: Number(v?.score) || 0 }))
    .filter((v) => v.term.length > 0);
}

releaseProfilesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM release_profiles ORDER BY name").all();
    res.json(rows.map(releaseProfileFromRow));
  })
);

releaseProfilesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name) throw new HttpError(400, "name is required");
    const mediaTypes = Array.isArray(b.mediaTypes) ? b.mediaTypes : [];
    const indexerIds = Array.isArray(b.indexerIds) ? b.indexerIds.map(Number) : [];
    const tagIds = Array.isArray(b.tagIds) ? b.tagIds.map(Number) : [];

    const result = await db
      .prepare(
        `INSERT INTO release_profiles (name, enabled, must_contain, must_not_contain, preferred, media_types, indexer_ids, tag_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        b.name,
        b.enabled === false ? 0 : 1,
        JSON.stringify(normalizeTerms(b.mustContain)),
        JSON.stringify(normalizeTerms(b.mustNotContain)),
        JSON.stringify(normalizePreferred(b.preferred)),
        mediaTypes.length > 0 ? JSON.stringify(mediaTypes) : null,
        indexerIds.length > 0 ? JSON.stringify(indexerIds) : null,
        tagIds.length > 0 ? JSON.stringify(tagIds) : null
      );
    const row = await db.prepare("SELECT * FROM release_profiles WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(releaseProfileFromRow(row));
  })
);

releaseProfilesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM release_profiles WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "Release profile not found");
    const b = req.body ?? {};

    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(b.name);
    }
    if (b.enabled !== undefined) {
      sets.push("enabled = ?");
      values.push(b.enabled ? 1 : 0);
    }
    if (b.mustContain !== undefined) {
      sets.push("must_contain = ?");
      values.push(JSON.stringify(normalizeTerms(b.mustContain)));
    }
    if (b.mustNotContain !== undefined) {
      sets.push("must_not_contain = ?");
      values.push(JSON.stringify(normalizeTerms(b.mustNotContain)));
    }
    if (b.preferred !== undefined) {
      sets.push("preferred = ?");
      values.push(JSON.stringify(normalizePreferred(b.preferred)));
    }
    if (b.mediaTypes !== undefined) {
      const mediaTypes = Array.isArray(b.mediaTypes) ? b.mediaTypes : [];
      sets.push("media_types = ?");
      values.push(mediaTypes.length > 0 ? JSON.stringify(mediaTypes) : null);
    }
    if (b.indexerIds !== undefined) {
      const indexerIds = Array.isArray(b.indexerIds) ? b.indexerIds.map(Number) : [];
      sets.push("indexer_ids = ?");
      values.push(indexerIds.length > 0 ? JSON.stringify(indexerIds) : null);
    }
    if (b.tagIds !== undefined) {
      const tagIds = Array.isArray(b.tagIds) ? b.tagIds.map(Number) : [];
      sets.push("tag_ids = ?");
      values.push(tagIds.length > 0 ? JSON.stringify(tagIds) : null);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE release_profiles SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM release_profiles WHERE id = ?").get(req.params.id);
    res.json(releaseProfileFromRow(row));
  })
);

releaseProfilesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM release_profiles WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Release profile not found");
    res.status(204).send();
  })
);
