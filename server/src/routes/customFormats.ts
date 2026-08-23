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
const VALID_SOURCES = new Set(["remux", "bluray", "webdl", "webrip", "hdtv", "dvd"]);
const VALID_RESOLUTIONS = new Set(["2160p", "1080p", "720p"]);
const VALID_FLAGS = new Set(["proper", "repack", "extended", "unrated", "directorscut", "imax"]);

/**
 * A custom format is a list of condition groups: title (patterns OR'd against the full title),
 * size (release size within [minMb, maxMb]), language (any of a set of detected language tags),
 * releaseGroup (patterns OR'd against the parsed trailing release-group tag), source (Remux/
 * Bluray/WEBDL/WEBRip/HDTV/DVD), resolution (2160p/1080p/720p), year (release year within
 * [minYear, maxYear]), or releaseFlags (proper/repack/extended/unrated/directorscut/imax). Across
 * groups, results are AND'd (every group must pass); a group can be negated for the opposite (e.g.
 * "must not contain x265", "must not be French").
 * Body: { name, mediaTypes?: string[], conditionGroups: [{ type?, patterns?, minMb?, maxMb?, languages?, sources?, resolutions?, minYear?, maxYear?, flags?, negate? }, ...] }
 * mediaTypes empty/omitted means the format applies to every library type (unrestricted).
 */
function validateAndNormalizeGroups(groups: any[]): any[] {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new HttpError(400, "a non-empty conditionGroups array is required");
  }
  for (const group of groups) {
    if (group.type === "size" || group.type === "year") {
      const [minKey, maxKey] = group.type === "size" ? ["minMb", "maxMb"] : ["minYear", "maxYear"];
      if (group[minKey] == null && group[maxKey] == null) {
        throw new HttpError(400, `a ${group.type} condition needs at least one of ${minKey}/${maxKey}`);
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
    } else if (group.type === "source") {
      if (!Array.isArray(group.sources) || group.sources.length === 0) {
        throw new HttpError(400, "a source condition needs a non-empty sources array");
      }
      for (const s of group.sources) {
        if (!VALID_SOURCES.has(String(s).toLowerCase())) throw new HttpError(400, `"${s}" is not a recognized source`);
      }
    } else if (group.type === "resolution") {
      if (!Array.isArray(group.resolutions) || group.resolutions.length === 0) {
        throw new HttpError(400, "a resolution condition needs a non-empty resolutions array");
      }
      for (const r of group.resolutions) {
        if (!VALID_RESOLUTIONS.has(String(r).toLowerCase())) throw new HttpError(400, `"${r}" is not a recognized resolution`);
      }
    } else if (group.type === "releaseFlags") {
      if (!Array.isArray(group.flags) || group.flags.length === 0) {
        throw new HttpError(400, "a releaseFlags condition needs a non-empty flags array");
      }
      for (const f of group.flags) {
        if (!VALID_FLAGS.has(String(f).toLowerCase())) throw new HttpError(400, `"${f}" is not a recognized release flag`);
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

  return groups.map((g: any) => {
    if (g.type === "size") return { type: "size", minMb: g.minMb ?? null, maxMb: g.maxMb ?? null, negate: !!g.negate };
    if (g.type === "year") return { type: "year", minYear: g.minYear ?? null, maxYear: g.maxYear ?? null, negate: !!g.negate };
    if (g.type === "language") return { type: "language", languages: g.languages.map((l: string) => l.toLowerCase()), negate: !!g.negate };
    if (g.type === "releaseGroup") return { type: "releaseGroup", patterns: g.patterns, negate: !!g.negate };
    if (g.type === "source") return { type: "source", sources: g.sources, negate: !!g.negate };
    if (g.type === "resolution") return { type: "resolution", resolutions: g.resolutions.map((r: string) => r.toLowerCase()), negate: !!g.negate };
    if (g.type === "releaseFlags") return { type: "releaseFlags", flags: g.flags.map((f: string) => f.toLowerCase()), negate: !!g.negate };
    return { type: "title", patterns: g.patterns, negate: !!g.negate };
  });
}

customFormatsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name) throw new HttpError(400, "name is required");
    const normalized = validateAndNormalizeGroups(b.conditionGroups);
    const mediaTypes = Array.isArray(b.mediaTypes) ? b.mediaTypes : [];

    const result = db
      .prepare("INSERT INTO custom_formats (name, patterns, media_types) VALUES (?, ?, ?)")
      .run(b.name, JSON.stringify(normalized), mediaTypes.length > 0 ? JSON.stringify(mediaTypes) : null);
    const row = db.prepare("SELECT * FROM custom_formats WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(customFormatFromRow(row));
  })
);

customFormatsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare("SELECT * FROM custom_formats WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "Custom format not found");
    const b = req.body ?? {};

    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(b.name);
    }
    if (b.conditionGroups !== undefined) {
      sets.push("patterns = ?");
      values.push(JSON.stringify(validateAndNormalizeGroups(b.conditionGroups)));
    }
    if (b.mediaTypes !== undefined) {
      const mediaTypes = Array.isArray(b.mediaTypes) ? b.mediaTypes : [];
      sets.push("media_types = ?");
      values.push(mediaTypes.length > 0 ? JSON.stringify(mediaTypes) : null);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      db.prepare(`UPDATE custom_formats SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = db.prepare("SELECT * FROM custom_formats WHERE id = ?").get(req.params.id);
    res.json(customFormatFromRow(row));
  })
);

interface TrashSpecification {
  implementation: string;
  negate?: boolean;
  fields?: { value?: string | number; min?: number; max?: number };
}

interface TrashCustomFormat {
  name: string;
  specifications?: TrashSpecification[];
}

/**
 * Imports a custom format exported from TRaSH-Guides (or copy-pasted straight from Radarr/
 * Sonarr's own custom format JSON export, since TRaSH publishes in that same shape) by mapping
 * each `specifications` entry to one of AoNarr's condition group types. Only
 * ReleaseTitleSpecification, ReleaseGroupSpecification, and SizeSpecification translate cleanly;
 * anything else (LanguageSpecification's numeric ids are Radarr/Sonarr's own internal language
 * table, IndexerFlagSpecification, etc.) is skipped and reported back rather than silently
 * dropped, since a format missing a condition would otherwise match more releases than intended.
 * Every mapped specification becomes its own AND'd group — a faithful translation of Radarr's
 * "required" specifications; it does not replicate their separate "at least one optional
 * specification must also match" OR-grouping, since AoNarr's model doesn't distinguish the two.
 */
customFormatsRouter.post(
  "/import-trash",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const trash: TrashCustomFormat = typeof b.json === "string" ? JSON.parse(b.json) : b.json;
    if (!trash?.name || !Array.isArray(trash.specifications)) {
      throw new HttpError(400, "Doesn't look like a TRaSH-Guides/Radarr/Sonarr custom format export");
    }

    const groups: any[] = [];
    const skipped: string[] = [];

    for (const spec of trash.specifications) {
      if (spec.implementation === "ReleaseTitleSpecification" && typeof spec.fields?.value === "string") {
        groups.push({ type: "title", patterns: [spec.fields.value], negate: !!spec.negate });
      } else if (spec.implementation === "ReleaseGroupSpecification" && typeof spec.fields?.value === "string") {
        groups.push({ type: "releaseGroup", patterns: [spec.fields.value], negate: !!spec.negate });
      } else if (spec.implementation === "SizeSpecification") {
        groups.push({
          type: "size",
          minMb: spec.fields?.min != null ? spec.fields.min * 1000 : null,
          maxMb: spec.fields?.max != null ? spec.fields.max * 1000 : null,
          negate: !!spec.negate,
        });
      } else {
        skipped.push(spec.implementation);
      }
    }

    if (groups.length === 0) {
      throw new HttpError(400, "None of this format's conditions are supported (only title/release-group/size specs translate)");
    }

    const result = db
      .prepare("INSERT INTO custom_formats (name, patterns) VALUES (?, ?)")
      .run(trash.name, JSON.stringify(groups));
    const row = db.prepare("SELECT * FROM custom_formats WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json({ format: customFormatFromRow(row), skipped });
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
