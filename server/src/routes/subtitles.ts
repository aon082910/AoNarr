import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { decryptIfSet, subtitleProviderFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { searchCustomSubtitles, searchSubtitles, type CustomSubtitleProviderConfig } from "../services/subtitleClient.js";
import { encryptValue } from "../services/encryption.js";

export const subtitlesRouter = Router();
subtitlesRouter.use(requireAdmin);

subtitlesRouter.get(
  "/providers",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM subtitle_providers").all();
    res.json(rows.map(subtitleProviderFromRow));
  })
);

subtitlesRouter.post(
  "/providers",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name) throw new HttpError(400, "name is required");
    const type = b.type ?? "opensubtitles";
    if (type === "opensubtitles" && !b.apiKey) throw new HttpError(400, "apiKey is required for OpenSubtitles");
    if (type === "custom" && !b.config?.searchUrlTemplate) {
      throw new HttpError(400, "config.searchUrlTemplate is required for a custom provider");
    }
    const result = await db
      .prepare(
        `INSERT INTO subtitle_providers (name, type, api_key, languages, enabled, config)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(b.name, type, b.apiKey ? encryptValue(b.apiKey) : null, b.languages ?? "eng", b.enabled ?? 1, b.config ? JSON.stringify(b.config) : null);
    const row = await db.prepare("SELECT * FROM subtitle_providers WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(subtitleProviderFromRow(row));
  })
);

/** Name/languages only — type is immutable after creation (same precedent as Import Lists' own
 * PATCH route, since switching a provider's type after the fact doesn't make sense: the config
 * shape underneath it is entirely different). Fixing a bad API key still needs delete-and-recreate
 * for now; the API key never round-trips back out of the encrypted column to prefill an edit form. */
subtitlesRouter.patch(
  "/providers/:id",
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM subtitle_providers WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "Subtitle provider not found");
    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(b.name);
    }
    if (b.languages !== undefined) {
      sets.push("languages = ?");
      values.push(b.languages);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE subtitle_providers SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM subtitle_providers WHERE id = ?").get(req.params.id);
    res.json(subtitleProviderFromRow(row));
  })
);

subtitlesRouter.delete(
  "/providers/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM subtitle_providers WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Subtitle provider not found");
    res.status(204).send();
  })
);

/** GET /api/subtitles/search?fileName=... */
subtitlesRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const fileName = req.query.fileName as string | undefined;
    if (!fileName) throw new HttpError(400, "fileName query param is required");

    const provider = (await db
      .prepare("SELECT * FROM subtitle_providers WHERE enabled = 1 LIMIT 1")
      .get()) as any;
    if (!provider) throw new HttpError(400, "No enabled subtitle provider configured");

    const parsedConfig = provider.config ? JSON.parse(provider.config) : {};
    const apiKey = decryptIfSet(provider.api_key);
    const results =
      provider.type === "custom"
        ? await searchCustomSubtitles(parsedConfig as CustomSubtitleProviderConfig, apiKey, fileName, provider.languages)
        : await searchSubtitles(apiKey!, fileName, provider.languages, {
            hearingImpaired: parsedConfig.hearingImpaired,
            foreignPartsOnly: parsedConfig.foreignPartsOnly,
          });
    res.json(results);
  })
);
