import { Router } from "express";
import { MEDIA_TYPES } from "../services/mediaTypes.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const mediaTypesRouter = Router();

/** Publishes the library-type registry (label, shape, child label) so the web UI never hardcodes it. */
mediaTypesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(
      Object.values(MEDIA_TYPES).map((t) => ({
        key: t.key,
        label: t.label,
        shape: t.shape,
        childLabel: t.childLabel ?? null,
        hasMetadataSearch: t.metadataProviders.length > 0,
        multiFilePerChild: !!t.multiFilePerChild,
      }))
    );
  })
);
