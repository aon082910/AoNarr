import { Router } from "express";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { ensureVapidKeys, saveSubscription, removeSubscription } from "../services/push.js";
import { ensureWebPushConnection } from "../services/notificationConnections.js";
import { log } from "../services/logger.js";

export const pushRouter = Router();

pushRouter.get(
  "/vapid-public-key",
  asyncHandler(async (_req, res) => {
    res.json({ publicKey: ensureVapidKeys().publicKey });
  })
);

pushRouter.post(
  "/subscribe",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.endpoint || !b.keys?.p256dh || !b.keys?.auth) {
      throw new HttpError(400, "endpoint and keys.p256dh/keys.auth are required");
    }
    const userId = req.auth?.isAdmin ? null : req.auth?.user?.id ?? null;
    await saveSubscription(b.endpoint, b.keys.p256dh, b.keys.auth, userId);
    // Event notifications go out only through a web push connection; the first browser to subscribe makes one.
    if (userId === null) await ensureWebPushConnection().catch((err) => log.warn("[push] couldn't add the web push connection:", (err as Error).message));
    res.status(201).json({ subscribed: true });
  })
);

pushRouter.post(
  "/unsubscribe",
  asyncHandler(async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (!endpoint) throw new HttpError(400, "endpoint is required");
    await removeSubscription(endpoint);
    res.status(204).send();
  })
);
