import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import {
  metadataProfileFromRow,
  PRIMARY_ALBUM_TYPES,
  SECONDARY_ALBUM_TYPES,
  validateMetadataProfileInput,
} from "../services/metadataProfiles.js";
import { getSetting, setSetting } from "../services/settingsStore.js";

export const metadataProfilesRouter = Router();
metadataProfilesRouter.use(requireAdmin);

/** The release types a profile can list or drop, for the editor's checkboxes. */
metadataProfilesRouter.get(
  "/types",
  asyncHandler(async (_req, res) => {
    res.json({ primary: PRIMARY_ALBUM_TYPES, secondary: SECONDARY_ALBUM_TYPES });
  })
);

metadataProfilesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM metadata_profiles ORDER BY name").all();
    const defaultId = parseInt(getSetting("defaultMetadataProfileId") ?? "", 10);
    res.json(rows.map((row) => ({ ...metadataProfileFromRow(row), isDefault: Number.isFinite(defaultId) && defaultId === Number((row as any).id) })));
  })
);

function parseBody(body: any, forCreate: boolean) {
  try {
    return validateMetadataProfileInput(body ?? {}, forCreate);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

metadataProfilesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parseBody(req.body, true);
    if (await db.prepare("SELECT 1 AS ok FROM metadata_profiles WHERE name = ?").get(input.name)) {
      throw new HttpError(409, `A metadata profile named "${input.name}" already exists`);
    }
    const result = await db
      .prepare("INSERT INTO metadata_profiles (name, primary_types, excluded_secondary_types, skip_missing_date, skip_sets) VALUES (?, ?, ?, ?, ?)")
      .run(
        input.name,
        JSON.stringify(input.primaryTypes ?? ["album"]),
        JSON.stringify(input.excludedSecondaryTypes ?? []),
        input.skipMissingDate ? 1 : 0,
        input.skipSets ? 1 : 0
      );
    const row = await db.prepare("SELECT * FROM metadata_profiles WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(metadataProfileFromRow(row));
  })
);

metadataProfilesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM metadata_profiles WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "Metadata profile not found");
    const input = parseBody(req.body, false);
    if (input.name !== undefined && (await db.prepare("SELECT 1 AS ok FROM metadata_profiles WHERE name = ? AND id <> ?").get(input.name, req.params.id))) {
      throw new HttpError(409, `A metadata profile named "${input.name}" already exists`);
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) (sets.push("name = ?"), values.push(input.name));
    if (input.primaryTypes !== undefined) (sets.push("primary_types = ?"), values.push(JSON.stringify(input.primaryTypes)));
    if (input.excludedSecondaryTypes !== undefined) (sets.push("excluded_secondary_types = ?"), values.push(JSON.stringify(input.excludedSecondaryTypes)));
    if (input.skipMissingDate !== undefined) (sets.push("skip_missing_date = ?"), values.push(input.skipMissingDate ? 1 : 0));
    if (input.skipSets !== undefined) (sets.push("skip_sets = ?"), values.push(input.skipSets ? 1 : 0));
    if (sets.length > 0) await db.prepare(`UPDATE metadata_profiles SET ${sets.join(", ")} WHERE id = ?`).run(...values, req.params.id);
    const row = await db.prepare("SELECT * FROM metadata_profiles WHERE id = ?").get(req.params.id);
    res.json(metadataProfileFromRow(row));
  })
);

/** Makes a profile the instance default (items and root folders that name none use it); `id: null` clears it. */
metadataProfilesRouter.post(
  "/default",
  asyncHandler(async (req, res) => {
    const id = req.body?.id;
    if (id === null || id === undefined || id === "") {
      setSetting("defaultMetadataProfileId", "");
      res.json({ defaultMetadataProfileId: null });
      return;
    }
    if (!(await db.prepare("SELECT 1 AS ok FROM metadata_profiles WHERE id = ?").get(Number(id)))) throw new HttpError(404, "Metadata profile not found");
    setSetting("defaultMetadataProfileId", String(Number(id)));
    res.json({ defaultMetadataProfileId: Number(id) });
  })
);

metadataProfilesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT id FROM metadata_profiles WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Metadata profile not found");
    const used = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE metadata_profile_id = ?").get(req.params.id)) as { c: number };
    const roots = (await db.prepare("SELECT COUNT(*) AS c FROM root_folders WHERE default_metadata_profile_id = ?").get(req.params.id)) as { c: number };
    if (Number(used.c) > 0 || Number(roots.c) > 0) {
      throw new HttpError(409, `This profile is used by ${Number(used.c)} title(s) and ${Number(roots.c)} root folder(s); move them to another profile first`);
    }
    await db.prepare("DELETE FROM metadata_profiles WHERE id = ?").run(req.params.id);
    if (parseInt(getSetting("defaultMetadataProfileId") ?? "", 10) === Number((row as any).id)) setSetting("defaultMetadataProfileId", "");
    res.status(204).send();
  })
);
