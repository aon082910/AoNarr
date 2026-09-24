import { Router } from "express";
import crypto from "node:crypto";
import { db } from "../db/index.js";
import { getSetting, setSetting } from "../services/settingsStore.js";
import { requireAdmin, safeEqual } from "../middleware/auth.js";
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

/** RFC 5545 DATE value (YYYYMMDD), or null when the stored date isn't a full calendar day —
 * providers store year-only/year-month release dates ("2027", "2026-11") as-is, and emitting those
 * as a DTSTART makes strict clients (Outlook) reject the whole subscription. */
function toIcsDate(dateStr: string | null | undefined): string | null {
  const day = String(dateStr ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.replace(/-/g, "") : null;
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
    if (!expected || !token || !safeEqual(token, expected)) throw new HttpError(401, "Invalid or missing calendar token");

    // Dates here are local calendar days while toISOString() is UTC — starting the window a day
    // early keeps tonight's releases in the feed after UTC has already rolled over to tomorrow.
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const episodes = (await db
      .prepare(
        `SELECT m.title AS "mediaTitle", e.season_number, e.episode_number, e.title AS "epTitle", e.air_date AS date
         FROM episodes e JOIN media_items m ON m.id = e.media_item_id
         WHERE e.air_date BETWEEN ? AND ? AND e.monitored = 1
         ORDER BY e.air_date`
      )
      .all(windowStart, future)) as any[];

    const subItems = (await db
      .prepare(
        `SELECT m.title AS "mediaTitle", s.title AS "subTitle", s.release_date AS date
         FROM sub_items s JOIN media_items m ON m.id = s.media_item_id
         WHERE s.release_date BETWEEN ? AND ? AND s.monitored = 1
         ORDER BY s.release_date`
      )
      .all(windowStart, future)) as any[];

    const singleShapeItems = (await db
      .prepare(
        `SELECT title AS "mediaTitle", release_date AS date
         FROM media_items
         WHERE release_date BETWEEN ? AND ? AND monitored = 1 AND release_date IS NOT NULL
         ORDER BY release_date`
      )
      .all(windowStart, future)) as any[];

    const customEvents = (await db
      .prepare(`SELECT title, date, note FROM custom_calendar_events WHERE date BETWEEN ? AND ? ORDER BY date`)
      .all(windowStart, future)) as any[];

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//AoNarr//Release Calendar//EN",
      "CALSCALE:GREGORIAN",
      "X-WR-CALNAME:AoNarr Releases",
    ];

    for (const ep of episodes) {
      const dtstart = toIcsDate(ep.date);
      if (!dtstart) continue;
      const summary = `${ep.mediaTitle} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}${ep.epTitle ? ` - ${ep.epTitle}` : ""}`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:episode-${ep.mediaTitle}-${ep.season_number}-${ep.episode_number}-${ep.date}@aonarr`,
        `DTSTART;VALUE=DATE:${dtstart}`,
        `SUMMARY:${icsEscape(summary)}`,
        "END:VEVENT"
      );
    }

    for (const sub of subItems) {
      const dtstart = toIcsDate(sub.date);
      if (!dtstart) continue;
      const summary = `${sub.mediaTitle} - ${sub.subTitle}`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:subitem-${sub.mediaTitle}-${sub.subTitle}-${sub.date}@aonarr`,
        `DTSTART;VALUE=DATE:${dtstart}`,
        `SUMMARY:${icsEscape(summary)}`,
        "END:VEVENT"
      );
    }

    for (const item of singleShapeItems) {
      const dtstart = toIcsDate(item.date);
      if (!dtstart) continue;
      lines.push(
        "BEGIN:VEVENT",
        `UID:media-${item.mediaTitle}-${item.date}@aonarr`,
        `DTSTART;VALUE=DATE:${dtstart}`,
        `SUMMARY:${icsEscape(item.mediaTitle)}`,
        "END:VEVENT"
      );
    }

    for (const ev of customEvents) {
      const dtstart = toIcsDate(ev.date);
      if (!dtstart) continue;
      lines.push(
        "BEGIN:VEVENT",
        `UID:custom-${ev.title}-${ev.date}@aonarr`,
        `DTSTART;VALUE=DATE:${dtstart}`,
        `SUMMARY:${icsEscape(ev.title)}`,
        ...(ev.note ? [`DESCRIPTION:${icsEscape(ev.note)}`] : []),
        "END:VEVENT"
      );
    }

    lines.push("END:VCALENDAR");

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", 'inline; filename="aonarr-releases.ics"');
    res.send(lines.join("\r\n"));
  })
);
