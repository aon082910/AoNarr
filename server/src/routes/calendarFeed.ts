import { Router } from "express";
import crypto from "node:crypto";
import { db } from "../db/client.js";
import { getSetting, setSetting } from "../services/settingsStore.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const calendarTokenRouter = Router();
calendarTokenRouter.use(requireAdmin);

function ensureCalendarToken(): string {
  let token = getSetting("calendarToken");
  if (!token) {
    token = crypto.randomBytes(20).toString("hex");
    setSetting("calendarToken", token);
  }
  return token;
}

calendarTokenRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ token: ensureCalendarToken() });
  })
);

calendarTokenRouter.post(
  "/regenerate",
  asyncHandler(async (_req, res) => {
    const token = crypto.randomBytes(20).toString("hex");
    setSetting("calendarToken", token);
    res.json({ token });
  })
);

function icsEscape(text: string): string {
  return text.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
}

function toIcsDate(dateStr: string): string {
  return dateStr.replace(/-/g, "");
}

export const calendarFeedRouter = Router();

/**
 * Public .ics feed — no X-Api-Key/X-Session-Token, since calendar apps (Google/Apple/Outlook)
 * subscribe via a plain URL with no custom headers. Gated instead by a dedicated token
 * (`?token=`), separate from the admin API key, so the feed URL can be shared with a calendar app
 * without handing out full API access; exempted from the normal requireAuth middleware.
 */
calendarFeedRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const token = req.query.token as string | undefined;
    const expected = getSetting("calendarToken");
    if (!expected || !token || token !== expected) throw new HttpError(401, "Invalid or missing calendar token");

    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const episodes = db
      .prepare(
        `SELECT m.title AS mediaTitle, e.season_number, e.episode_number, e.title AS epTitle, e.air_date AS date
         FROM episodes e JOIN media_items m ON m.id = e.media_item_id
         WHERE e.air_date BETWEEN ? AND ? AND e.monitored = 1
         ORDER BY e.air_date`
      )
      .all(today, future) as any[];

    const subItems = db
      .prepare(
        `SELECT m.title AS mediaTitle, s.title AS subTitle, s.release_date AS date
         FROM sub_items s JOIN media_items m ON m.id = s.media_item_id
         WHERE s.release_date BETWEEN ? AND ? AND s.monitored = 1
         ORDER BY s.release_date`
      )
      .all(today, future) as any[];

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//AoNarr//Release Calendar//EN",
      "CALSCALE:GREGORIAN",
      "X-WR-CALNAME:AoNarr Releases",
    ];

    for (const ep of episodes) {
      if (!ep.date) continue;
      const summary = `${ep.mediaTitle} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}${ep.epTitle ? ` - ${ep.epTitle}` : ""}`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:episode-${ep.mediaTitle}-${ep.season_number}-${ep.episode_number}-${ep.date}@aonarr`,
        `DTSTART;VALUE=DATE:${toIcsDate(ep.date)}`,
        `SUMMARY:${icsEscape(summary)}`,
        "END:VEVENT"
      );
    }

    for (const sub of subItems) {
      if (!sub.date) continue;
      const summary = `${sub.mediaTitle} - ${sub.subTitle}`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:subitem-${sub.mediaTitle}-${sub.subTitle}-${sub.date}@aonarr`,
        `DTSTART;VALUE=DATE:${toIcsDate(sub.date)}`,
        `SUMMARY:${icsEscape(summary)}`,
        "END:VEVENT"
      );
    }

    lines.push("END:VCALENDAR");

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", 'inline; filename="aonarr-releases.ics"');
    res.send(lines.join("\r\n"));
  })
);
