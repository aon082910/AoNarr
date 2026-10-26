import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { delayProfileFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { resetSearchBackoff } from "../services/searchBackoff.js";
import { normalizePreferredProtocol } from "../services/releaseRanking.js";

export const delayProfilesRouter = Router();
delayProfilesRouter.use(requireAdmin);

/** The delay/order columns are INTEGER NOT NULL: Postgres rejects a fractional or non-numeric value. */
function nonNegativeInteger(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 2147483647) throw new HttpError(400, `${field} must be a number of 0 or more`);
  return Math.round(n);
}

/** "none", "usenet" or "torrent": anything else is a mistake worth refusing, not a quiet "none". */
function preferredProtocol(value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (value !== "none" && value !== "usenet" && value !== "torrent") throw new HttpError(400, "preferredProtocol must be none, usenet or torrent");
  return normalizePreferredProtocol(value);
}

/** A whole number, negative allowed (a format score); undefined when not sent. */
function wholeScore(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || Math.abs(n) > 2147483647) throw new HttpError(400, `${field} must be a whole number`);
  return n;
}

delayProfilesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM delay_profiles ORDER BY order_index, id").all();
    res.json(rows.map(delayProfileFromRow));
  })
);

delayProfilesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const usenetDelay = b.usenetDelayMinutes == null ? 0 : nonNegativeInteger(b.usenetDelayMinutes, "usenetDelayMinutes");
    const torrentDelay = b.torrentDelayMinutes == null ? 0 : nonNegativeInteger(b.torrentDelayMinutes, "torrentDelayMinutes");
    if (b.tagId != null) {
      const existing = await db.prepare("SELECT id FROM delay_profiles WHERE tag_id = ?").get(b.tagId);
      if (existing) throw new HttpError(400, "A delay profile for this tag already exists");
    } else {
      const existingDefault = await db.prepare("SELECT id FROM delay_profiles WHERE tag_id IS NULL").get();
      if (existingDefault) throw new HttpError(400, "A default (no-tag) delay profile already exists");
    }
    const maxOrder = (await db.prepare("SELECT MAX(order_index) AS m FROM delay_profiles").get()) as { m: number | null };
    const result = await db
      .prepare(
        `INSERT INTO delay_profiles (tag_id, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality, order_index, preferred_protocol, bypass_if_above_format_score, minimum_bypass_format_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        b.tagId ?? null,
        b.enableUsenet === false ? 0 : 1,
        b.enableTorrent === false ? 0 : 1,
        usenetDelay,
        torrentDelay,
        b.bypassIfHighestQuality ? 1 : 0,
        (maxOrder.m ?? -1) + 1,
        preferredProtocol(b.preferredProtocol),
        b.bypassIfAboveFormatScore ? 1 : 0,
        wholeScore(b.minimumBypassFormatScore, "minimumBypassFormatScore") ?? 0
      );
    const row = await db.prepare("SELECT * FROM delay_profiles WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(delayProfileFromRow(row));
  })
);

delayProfilesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const map: Record<string, string> = {
      enableUsenet: "enable_usenet",
      enableTorrent: "enable_torrent",
      usenetDelayMinutes: "usenet_delay_minutes",
      torrentDelayMinutes: "torrent_delay_minutes",
      bypassIfHighestQuality: "bypass_if_highest_quality",
      orderIndex: "order_index",
    };
    const booleanKeys = new Set(["enableUsenet", "enableTorrent", "bypassIfHighestQuality"]);
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, col] of Object.entries(map)) {
      if (b[key] !== undefined) {
        sets.push(`${col} = ?`);
        values.push(booleanKeys.has(key) ? (b[key] ? 1 : 0) : nonNegativeInteger(b[key], key));
      }
    }
    if (b.bypassIfAboveFormatScore !== undefined) {
      sets.push("bypass_if_above_format_score = ?");
      values.push(b.bypassIfAboveFormatScore ? 1 : 0);
    }
    if (b.minimumBypassFormatScore !== undefined) {
      sets.push("minimum_bypass_format_score = ?");
      values.push(wholeScore(b.minimumBypassFormatScore, "minimumBypassFormatScore") ?? 0);
    }
    if (b.preferredProtocol !== undefined) {
      sets.push("preferred_protocol = ?");
      values.push(preferredProtocol(b.preferredProtocol));
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE delay_profiles SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      // What can be grabbed has changed: targets the searches kept finding nothing for are searched again.
      await resetSearchBackoff();
    }
    const row = await db.prepare("SELECT * FROM delay_profiles WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Delay profile not found");
    res.json(delayProfileFromRow(row));
  })
);

delayProfilesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM delay_profiles WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Delay profile not found");
    await resetSearchBackoff();
    res.status(204).send();
  })
);
