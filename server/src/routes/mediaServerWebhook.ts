import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import { requireAdmin, safeEqual } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getSetting, setSetting } from "../services/settingsStore.js";
import { parseJellyfinEmbyPayload, parsePlexPayload, recordWatchEvent } from "../services/mediaServerWebhook.js";
import { log } from "../services/logger.js";

const upload = multer();

export const mediaServerWebhookTokenRouter = Router();
mediaServerWebhookTokenRouter.use(requireAdmin);

function ensureWebhookToken(): string {
  let token = getSetting("mediaServerWebhookToken");
  if (!token) {
    token = crypto.randomBytes(20).toString("hex");
    setSetting("mediaServerWebhookToken", token);
  }
  return token;
}

mediaServerWebhookTokenRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ token: ensureWebhookToken() });
  })
);

mediaServerWebhookTokenRouter.post(
  "/regenerate",
  asyncHandler(async (_req, res) => {
    const token = crypto.randomBytes(20).toString("hex");
    setSetting("mediaServerWebhookToken", token);
    res.json({ token });
  })
);

export const mediaServerWebhookRouter = Router();

/**
 * Public — no X-Api-Key/X-Session-Token, since Plex/Jellyfin/Emby's own webhook config can't send
 * custom headers. Gated instead by a dedicated token in the URL (`?token=`), same pattern as the
 * calendar feed, and exempted from the normal requireAuth middleware.
 *
 * Accepts either Plex's multipart `payload` field or a plain JSON body (Jellyfin/Emby webhook
 * plugins) — see services/mediaServerWebhook.ts for the exact fields read from each. Always
 * responds 200 once the token checks out, even when nothing matched, so the media server doesn't
 * treat an unrecognized-but-legitimate event as a delivery failure and keep retrying it.
 */
mediaServerWebhookRouter.post(
  "/",
  upload.any(),
  asyncHandler(async (req, res) => {
    const token = req.query.token as string | undefined;
    const expected = getSetting("mediaServerWebhookToken");
    if (!expected || !token || !safeEqual(token, expected)) throw new HttpError(401, "Invalid or missing webhook token");

    let signal = null;
    try {
      if (typeof req.body?.payload === "string") {
        signal = await parsePlexPayload(JSON.parse(req.body.payload));
      } else if (req.body && Object.keys(req.body).length > 0) {
        signal = parseJellyfinEmbyPayload(req.body);
      }
    } catch (err) {
      log.warn("[webhook] could not parse media server webhook body:", (err as Error).message);
    }

    if (signal) {
      const matched = await recordWatchEvent(signal);
      if (!matched) log.info(`[webhook] watch event for "${signal.filePath}" didn't match any library file`);
    }

    res.status(200).json({ received: true });
  })
);
