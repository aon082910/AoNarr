import crypto from "node:crypto";
import { Router } from "express";
import { db } from "../db/index.js";
import { requireAdmin, safeEqual } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getSetting, setSetting } from "../services/settingsStore.js";
import { streamFileWithRangeSupport, CONTENT_TYPES } from "../services/rangeStream.js";
import { getMediaTypeConfig } from "../services/mediaTypes.js";

/**
 * OPDS (Open Publication Distribution System) catalog — lets an e-reader app that already speaks
 * OPDS (KOReader, Moon+ Reader, Marvin, etc.) browse and download straight from AoNarr's own
 * library, the way a Calibre server or BookOrbit would, without a separate app. Scoped to the four
 * "collection"-shape book/comic types — a movie/show library has nothing an OPDS reader would do
 * anything useful with.
 */
const OPDS_TYPES = ["author", "audiobook", "comic", "manga"] as const;

// ---------------------------------------------------------------------------
// Token management — admin-gated, same shape as the calendar feed's token.
// ---------------------------------------------------------------------------

export const opdsTokenRouter = Router();
opdsTokenRouter.use(requireAdmin);

function ensureOpdsToken(): string {
  let token = getSetting("opdsToken");
  if (!token) {
    token = crypto.randomBytes(20).toString("hex");
    setSetting("opdsToken", token);
  }
  return token;
}

opdsTokenRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ token: ensureOpdsToken() });
  })
);

opdsTokenRouter.post(
  "/regenerate",
  asyncHandler(async (_req, res) => {
    const token = crypto.randomBytes(20).toString("hex");
    setSetting("opdsToken", token);
    res.json({ token });
  })
);

// ---------------------------------------------------------------------------
// Public, token-gated catalog feed — mounted separately at /api/opds (no requireAuth; see
// middleware/auth.ts's /opds exemption, the same pattern the .ics calendar feed and IPTV M3U/
// stream routes already use).
// ---------------------------------------------------------------------------

export const opdsPublicRouter = Router();

function checkToken(req: any): void {
  const token = req.query.token as string | undefined;
  const expected = getSetting("opdsToken");
  if (!expected || !token || !safeEqual(token, expected)) throw new HttpError(401, "Invalid or missing OPDS token");
}

function escapeXml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const NAV_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation";
const ACQ_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";

function feedHeader(id: string, title: string, selfHref: string, startHref: string, kind: "navigation" | "acquisition"): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">`,
    `  <id>${escapeXml(id)}</id>`,
    `  <title>${escapeXml(title)}</title>`,
    `  <updated>${new Date(0).toISOString()}</updated>`,
    `  <link rel="self" href="${escapeXml(selfHref)}" type="${kind === "navigation" ? NAV_TYPE : ACQ_TYPE}"/>`,
    `  <link rel="start" href="${escapeXml(startHref)}" type="${NAV_TYPE}"/>`,
  ].join("\n");
}

function navEntry(id: string, title: string, href: string, summary?: string): string {
  return [
    `  <entry>`,
    `    <title>${escapeXml(title)}</title>`,
    `    <id>${escapeXml(id)}</id>`,
    `    <updated>${new Date(0).toISOString()}</updated>`,
    `    <link rel="subsection" href="${escapeXml(href)}" type="${NAV_TYPE}"/>`,
    summary ? `    <content type="text">${escapeXml(summary)}</content>` : null,
    `  </entry>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function acqEntry(opts: {
  id: string;
  title: string;
  author?: string | null;
  downloadHref: string;
  mimeType: string;
  posterUrl?: string | null;
  summary?: string | null;
}): string {
  return [
    `  <entry>`,
    `    <title>${escapeXml(opts.title)}</title>`,
    `    <id>${escapeXml(opts.id)}</id>`,
    `    <updated>${new Date(0).toISOString()}</updated>`,
    opts.author ? `    <author><name>${escapeXml(opts.author)}</name></author>` : null,
    opts.summary ? `    <summary>${escapeXml(opts.summary)}</summary>` : null,
    `    <link rel="http://opds-spec.org/acquisition" href="${escapeXml(opts.downloadHref)}" type="${escapeXml(opts.mimeType)}"/>`,
    opts.posterUrl ? `    <link rel="http://opds-spec.org/image" href="${escapeXml(opts.posterUrl)}" type="image/jpeg"/>` : null,
    `  </entry>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function sendFeed(res: any, xml: string): void {
  res.set("Content-Type", "application/atom+xml; charset=utf-8").send(`${xml}\n</feed>`);
}

function origin(req: any): string {
  return `${req.protocol}://${req.get("host")}`;
}

/** Root — one navigation entry per book/comic/audiobook/manga type. */
opdsPublicRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    checkToken(req);
    const token = req.query.token as string;
    const base = origin(req);
    let xml = feedHeader("urn:aonarr:root", "AoNarr Library", `${base}/api/opds?token=${token}`, `${base}/api/opds?token=${token}`, "navigation");
    for (const type of OPDS_TYPES) {
      const label = getMediaTypeConfig(type).label;
      xml += `\n${navEntry(`urn:aonarr:type:${type}`, label, `${base}/api/opds/type/${type}?token=${token}`, `Browse ${label} by ${getMediaTypeConfig(type).shape === "collection" ? "author/creator" : "title"}`)}`;
    }
    sendFeed(res, xml);
  })
);

/** One navigation entry per parent item (author, comic volume, manga title, ...) of a type. */
opdsPublicRouter.get(
  "/type/:type",
  asyncHandler(async (req, res) => {
    checkToken(req);
    const type = req.params.type;
    if (!(OPDS_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Not an OPDS-eligible library type");
    const token = req.query.token as string;
    const base = origin(req);
    const label = getMediaTypeConfig(type).label;

    const items = (await db.prepare("SELECT id, title FROM media_items WHERE type = ? ORDER BY sort_title").all(type)) as {
      id: number;
      title: string;
    }[];

    let xml = feedHeader(
      `urn:aonarr:type:${type}`,
      label,
      `${base}/api/opds/type/${type}?token=${token}`,
      `${base}/api/opds?token=${token}`,
      "navigation"
    );
    for (const item of items) {
      xml += `\n${navEntry(`urn:aonarr:item:${item.id}`, item.title, `${base}/api/opds/item/${item.id}?token=${token}`)}`;
    }
    sendFeed(res, xml);
  })
);

/** Acquisition entries — every downloadable book/issue/chapter under one parent item. A
 * multiFilePerChild type (Audiobooks) has no single file per sub_item (its file_path is the whole
 * album folder — see importer.ts's placeAlbumFiles), so those expose each individual track as its
 * own acquisition entry instead, via the track download route below. */
opdsPublicRouter.get(
  "/item/:id",
  asyncHandler(async (req, res) => {
    checkToken(req);
    const token = req.query.token as string;
    const base = origin(req);

    const parent = (await db.prepare("SELECT id, title, type FROM media_items WHERE id = ?").get(req.params.id)) as any;
    if (!parent) throw new HttpError(404, "Item not found");
    const typeConfig = getMediaTypeConfig(parent.type);

    let xml = feedHeader(
      `urn:aonarr:item:${parent.id}`,
      parent.title,
      `${base}/api/opds/item/${parent.id}?token=${token}`,
      `${base}/api/opds?token=${token}`,
      "acquisition"
    );

    if (typeConfig.multiFilePerChild) {
      const subItems = (await db
        .prepare("SELECT id, title FROM sub_items WHERE media_item_id = ? AND has_file = 1 ORDER BY title")
        .all(parent.id)) as { id: number; title: string }[];
      for (const sub of subItems) {
        const tracks = (await db
          .prepare("SELECT id, track_number, title, file_path FROM tracks WHERE sub_item_id = ? AND has_file = 1 ORDER BY track_number")
          .all(sub.id)) as { id: number; track_number: number; title: string; file_path: string }[];
        for (const t of tracks) {
          const ext = t.file_path.slice(t.file_path.lastIndexOf(".")).toLowerCase();
          xml += `\n${acqEntry({
            id: `urn:aonarr:track:${t.id}`,
            title: `${sub.title} — ${String(t.track_number).padStart(2, "0")}. ${t.title}`,
            author: parent.title,
            downloadHref: `${base}/api/opds/download/track/${t.id}?token=${token}`,
            mimeType: mimeTypeFor(ext),
          })}`;
        }
      }
    } else {
      const subItems = (await db
        .prepare("SELECT id, title, file_path, poster_url, release_date FROM sub_items WHERE media_item_id = ? AND has_file = 1 ORDER BY title")
        .all(parent.id)) as { id: number; title: string; file_path: string; poster_url: string | null; release_date: string | null }[];
      for (const sub of subItems) {
        const ext = sub.file_path.slice(sub.file_path.lastIndexOf(".")).toLowerCase();
        xml += `\n${acqEntry({
          id: `urn:aonarr:subitem:${sub.id}`,
          title: sub.title,
          author: parent.title,
          downloadHref: `${base}/api/opds/download/subitem/${sub.id}?token=${token}`,
          mimeType: mimeTypeFor(ext),
          posterUrl: sub.poster_url,
        })}`;
      }
    }

    sendFeed(res, xml);
  })
);

function mimeTypeFor(ext: string): string {
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

opdsPublicRouter.get(
  "/download/subitem/:id",
  asyncHandler(async (req, res) => {
    checkToken(req);
    const row = (await db.prepare("SELECT file_path FROM sub_items WHERE id = ?").get(req.params.id)) as { file_path: string } | undefined;
    if (!row?.file_path) throw new HttpError(404, "No file for this item");
    streamFileWithRangeSupport(req, res, row.file_path);
  })
);

opdsPublicRouter.get(
  "/download/track/:id",
  asyncHandler(async (req, res) => {
    checkToken(req);
    const row = (await db.prepare("SELECT file_path FROM tracks WHERE id = ?").get(req.params.id)) as { file_path: string } | undefined;
    if (!row?.file_path) throw new HttpError(404, "No file for this track");
    streamFileWithRangeSupport(req, res, row.file_path);
  })
);
