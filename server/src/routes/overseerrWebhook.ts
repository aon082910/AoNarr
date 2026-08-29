import crypto from "node:crypto";
import { Router } from "express";
import { requireAdmin, safeEqual } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getSetting, setSetting } from "../services/settingsStore.js";
import { handleOverseerrWebhook } from "../services/overseerrWebhook.js";
import { log } from "../services/logger.js";

export const overseerrWebhookTokenRouter = Router();
overseerrWebhookTokenRouter.use(requireAdmin);

function ensureWebhookToken(): string {
  let token = getSetting("overseerrWebhookToken");
  if (!token) {
    token = crypto.randomBytes(20).toString("hex");
    setSetting("overseerrWebhookToken", token);
  }
  return token;
}

overseerrWebhookTokenRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ token: ensureWebhookToken() });
  })
);

overseerrWebhookTokenRouter.post(
  "/regenerate",
  asyncHandler(async (_req, res) => {
    const token = crypto.randomBytes(20).toString("hex");
    setSetting("overseerrWebhookToken", token);
    res.json({ token });
  })
);

export const overseerrWebhookRouter = Router();

/** Public — no X-Api-Key, since Overseerr/Jellyseerr's own webhook config can't send custom
 * headers either. Gated by a dedicated `?token=` query param, same pattern as the Plex/Jellyfin/
 * Emby webhook and the calendar feed; exempted from requireAuth (see middleware/auth.ts). Always
 * responds 200 once the token checks out, same reasoning as the media-server webhook — an
 * unrecognized-but-legitimate event shouldn't look like a delivery failure and get retried. */
overseerrWebhookRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const token = req.query.token as string | undefined;
    const expected = getSetting("overseerrWebhookToken");
    if (!expected || !token || !safeEqual(token, expected)) throw new HttpError(401, "Invalid or missing webhook token");

    try {
      const result = await handleOverseerrWebhook(req.body ?? {});
      res.json(result);
    } catch (err) {
      log.warn("[overseerrWebhook] failed to process webhook:", (err as Error).message);
      res.json({ added: false, reason: (err as Error).message });
    }
  })
);
