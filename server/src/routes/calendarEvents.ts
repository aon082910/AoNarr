import { Router } from "express";
import { db } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const calendarEventsRouter = Router();
calendarEventsRouter.use(requireAdmin);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

calendarEventsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = (await db.prepare("SELECT * FROM custom_calendar_events ORDER BY date").all()) as any[];
    res.json(rows.map((r) => ({ id: r.id, title: r.title, date: r.date, note: r.note, createdAt: r.created_at })));
  })
);

calendarEventsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.title || typeof b.title !== "string") throw new HttpError(400, "title is required");
    if (!b.date || !DATE_RE.test(b.date)) throw new HttpError(400, "date is required, as YYYY-MM-DD");

    const result = await db
      .prepare("INSERT INTO custom_calendar_events (title, date, note) VALUES (?, ?, ?)")
      .run(b.title.trim(), b.date, b.note || null);
    const row = (await db.prepare("SELECT * FROM custom_calendar_events WHERE id = ?").get(result.lastInsertRowid)) as any;
    res.status(201).json({ id: row.id, title: row.title, date: row.date, note: row.note, createdAt: row.created_at });
  })
);

calendarEventsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM custom_calendar_events WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Custom calendar event not found");
    res.status(204).send();
  })
);
