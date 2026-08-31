import crypto from "node:crypto";
import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getSetting, setSetting } from "../services/settingsStore.js";

/**
 * Plex's actual sign-in flow (the "PIN" OAuth-style flow every third-party Plex client uses)
 * instead of asking an admin to dig a token out of Plex's own XML API responses by hand — those
 * tokens found that way are frequently temporary/session-scoped, while a token issued through this
 * flow is the same durable, real third-party token Plex's own apps get.
 */
export const plexAuthRouter = Router();
plexAuthRouter.use(requireAdmin);

const PLEX_PRODUCT = "AoNarr";

/** A stable per-instance identifier Plex's API requires on every call in this flow — generated
 * once and reused, not regenerated per sign-in attempt (Plex ties a PIN to the client identifier
 * that created it). */
function ensureClientIdentifier(): string {
  let id = getSetting("plexClientIdentifier");
  if (!id) {
    id = crypto.randomUUID();
    setSetting("plexClientIdentifier", id);
  }
  return id;
}

function plexHeaders(clientId: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Plex-Product": PLEX_PRODUCT,
    "X-Plex-Client-Identifier": clientId,
  };
}

/** Starts a sign-in attempt: Plex issues a short numeric code plus a PIN id. The admin is shown a
 * link to app.plex.tv carrying that code, signs in there with their real Plex account, and the
 * frontend polls the second route below until Plex reports the PIN claimed. */
plexAuthRouter.post(
  "/pin",
  asyncHandler(async (_req, res) => {
    const clientId = ensureClientIdentifier();
    const plexRes = await fetch("https://plex.tv/api/v2/pins", {
      method: "POST",
      headers: plexHeaders(clientId),
      body: JSON.stringify({ strong: true }),
    });
    if (!plexRes.ok) throw new HttpError(502, `Plex PIN request failed: HTTP ${plexRes.status}`);
    const body: any = await plexRes.json();
    res.json({
      pinId: body.id,
      code: body.code,
      clientId,
      authUrl: `https://app.plex.tv/auth#?clientID=${encodeURIComponent(clientId)}&code=${encodeURIComponent(
        body.code
      )}&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(PLEX_PRODUCT)}`,
    });
  })
);

/** Polled by the frontend every couple seconds — returns claimed: false until the admin finishes
 * signing in on plex.tv, at which point Plex attaches a real authToken to the PIN. Once claimed,
 * that token is saved as this instance's Plex token immediately (same setting the manual-token
 * flow writes to) so the caller doesn't need a separate "save" step. */
plexAuthRouter.get(
  "/pin/:id",
  asyncHandler(async (req, res) => {
    const clientId = getSetting("plexClientIdentifier");
    if (!clientId) throw new HttpError(400, "No sign-in attempt in progress — start one first");

    const plexRes = await fetch(`https://plex.tv/api/v2/pins/${req.params.id}`, {
      headers: plexHeaders(clientId),
    });
    if (!plexRes.ok) throw new HttpError(502, `Plex PIN check failed: HTTP ${plexRes.status}`);
    const body: any = await plexRes.json();

    if (!body.authToken) {
      res.json({ claimed: false });
      return;
    }

    setSetting("mediaServerType", "plex");
    setSetting("mediaServerToken", body.authToken);
    res.json({ claimed: true });
  })
);
