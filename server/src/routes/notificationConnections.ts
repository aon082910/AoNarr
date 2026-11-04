import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { auditActor, logAuditEvent } from "../services/audit.js";
import {
  CONNECTION_KINDS,
  ConnectionInputError,
  EVENT_KEYS,
  OPT_IN_EVENTS,
  connectionToApi,
  createNotificationConnection,
  deleteNotificationConnection,
  getNotificationConnection,
  listNotificationConnections,
  updateNotificationConnection,
} from "../services/notificationConnections.js";
import { NOTIFICATION_TEMPLATES, testNotificationConnection } from "../services/notifications.js";
import { getSetting } from "../services/settingsStore.js";

/**
 * Notification connections (Sonarr/Radarr's Settings > Connect): any number of named destinations, each of one kind,
 * each with its own events and tags. Secrets are never returned: a field that is set shows as "********", and sending
 * that back unchanged on an edit keeps what is stored.
 */
export const notificationConnectionsRouter = Router();
notificationConnectionsRouter.use(requireAdmin);

/** A request the caller got wrong is a 400 with the message, not a 500. */
async function checked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ConnectionInputError) throw new HttpError(400, err.message);
    throw err;
  }
}

function connectionId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, "Notification connection not found");
  return id;
}

/** What the page needs to draw its forms: the kinds and their fields, the events, and each message template with its
 * default text, the tokens it takes and the text the admin saved over it. */
notificationConnectionsRouter.get(
  "/meta",
  asyncHandler(async (_req, res) => {
    res.json({
      kinds: CONNECTION_KINDS,
      events: EVENT_KEYS.map((key) => ({ key, optIn: OPT_IN_EVENTS.has(key) })),
      templates: NOTIFICATION_TEMPLATES.map((t) => ({ ...t, value: getSetting(t.key) ?? "" })),
    });
  })
);

notificationConnectionsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json((await listNotificationConnections()).map(connectionToApi));
  })
);

notificationConnectionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const created = await checked(() => createNotificationConnection(req.body ?? {}));
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "notification_connection_added", `${created.name} (${created.kind})`);
    res.status(201).json(connectionToApi(created));
  })
);

notificationConnectionsRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const updated = await checked(() => updateNotificationConnection(connectionId(req.params.id), req.body ?? {}));
    if (!updated) throw new HttpError(404, "Notification connection not found");
    res.json(connectionToApi(updated));
  })
);

notificationConnectionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = connectionId(req.params.id);
    const existing = await getNotificationConnection(id);
    if (!existing || !(await deleteNotificationConnection(id))) throw new HttpError(404, "Notification connection not found");
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "notification_connection_removed", `${existing.name} (${existing.kind})`);
    res.status(204).send();
  })
);

/** Sends the fixed test message to this one connection, whatever its events and tags say. A failure comes back as
 * { ok: false, error } with a message that carries neither a secret nor a full URL. */
notificationConnectionsRouter.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    const conn = await getNotificationConnection(connectionId(req.params.id));
    if (!conn) throw new HttpError(404, "Notification connection not found");
    try {
      await testNotificationConnection(conn);
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  })
);
