import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { customFormatFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const customFormatsRouter = Router();
customFormatsRouter.use(requireAdmin);

customFormatsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db.prepare("SELECT * FROM custom_formats ORDER BY name").all();
    res.json(rows.map(customFormatFromRow));
  })
);

const VALID_PATTERN_LANGUAGES = new Set([
  "multi", "vostfr", "vff", "vfq", "french", "german", "italian", "spanish", "dutch",
  "russian", "korean", "japanese", "danish", "swedish", "norwegian", "polish", "portuguese", "english",
]);

/**
 * A custom format is a list of condition groups: title (patterns OR'd against the full title),
 * size (release size within [minMb, maxMb]), language (any of a set of detected language tags),
 * or releaseGroup (patterns OR'd against the parsed trailing release-group tag). Across groups,
 * results are AND'd (every group must pass); a group can be negated for the opposite (e.g. "must
 * not contain x265", "must not be French").
 * Body: { name, conditionGroups: [{ type?, patterns?, minMb?, maxMb?, languages?, negate? }, ...] }
 */
customFormatsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const groups = b.conditionGroups;
    if (!b.name || !Array.isArray(groups) || groups.length === 0) {
      throw new HttpError(400, "name and a non-empty conditionGroups array are required");
    }
    for (const group of groups) {
      if (group.type === "size") {
        if (group.minMb == null && group.maxMb == null) {
          throw new HttpError(400, "a size condition needs at least one of minMb/maxMb");
        }
      } else if (group.type === "language") {
        if (!Array.isArray(group.languages) || group.languages.length === 0) {
          throw new HttpError(400, "a language condition needs a non-empty languages array");
        }
        for (const lang of group.languages) {
          if (!VALID_PATTERN_LANGUAGES.has(String(lang).toLowerCase())) {
            throw new HttpError(400, `"${lang}" is not a recognized language tag`);
          }
        }
      } else {
        // "title" and "releaseGroup" both validate as a non-empty regex-pattern array
        if (!Array.isArray(group.patterns) || group.patterns.length === 0) {
          throw new HttpError(400, "each title/releaseGroup condition group needs a non-empty patterns array");
        }
        for (const p of group.patterns) {
          try {
            new RegExp(p);
          } catch {
            throw new HttpError(400, `"${p}" is not a valid regular expression`);
          }
        }
      }
    }

    const normalized = groups.map((g: any) => {
      if (g.type === "size") return { type: "size", minMb: g.minMb ?? null, maxMb: g.maxMb ?? null, negate: !!g.negate };
      if (g.type === "language") return { type: "language", languages: g.languages.map((l: string) => l.toLowerCase()), negate: !!g.negate };
      if (g.type === "releaseGroup") return { type: "releaseGroup", patterns: g.patterns, negate: !!g.negate };
      return { type: "title", patterns: g.patterns, negate: !!g.negate };
    });
    const result = db
      .prepare("INSERT INTO custom_formats (name, patterns) VALUES (?, ?)")
      .run(b.name, JSON.stringify(normalized));
    const row = db.prepare("SELECT * FROM custom_formats WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(customFormatFromRow(row));
  })
);

customFormatsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = db.prepare("DELETE FROM custom_formats WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Custom format not found");
    res.status(204).send();
  })
);

/** GET/PUT the score a quality profile assigns to every custom format (0 for any unset). */
customFormatsRouter.get(
  "/scores/:qualityProfileId",
  asyncHandler(async (req, res) => {
    const formats = db.prepare("SELECT * FROM custom_formats ORDER BY name").all() as any[];
    const scoreRows = db
      .prepare("SELECT custom_format_id, score FROM quality_profile_format_scores WHERE quality_profile_id = ?")
      .all(req.params.qualityProfileId) as { custom_format_id: number; score: number }[];
    const scoreMap = new Map(scoreRows.map((r) => [r.custom_format_id, r.score]));

    res.json(
      formats.map((f) => ({ ...customFormatFromRow(f), score: scoreMap.get(f.id) ?? 0 }))
    );
  })
);

customFormatsRouter.put(
  "/scores/:qualityProfileId/:customFormatId",
  asyncHandler(async (req, res) => {
    const score = Number(req.body?.score ?? 0);
    db.prepare(
      `INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score)
       VALUES (?, ?, ?)
       ON CONFLICT(quality_profile_id, custom_format_id) DO UPDATE SET score = excluded.score`
    ).run(req.params.qualityProfileId, req.params.customFormatId, score);
    res.json({ qualityProfileId: Number(req.params.qualityProfileId), customFormatId: Number(req.params.customFormatId), score });
  })
);
