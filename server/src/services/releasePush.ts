import crypto from "node:crypto";
import { db } from "../db/index.js";
import { log } from "./logger.js";
import { describeLink } from "./linkRedaction.js";
import { judgeOneRelease, type OneReleaseJudgement } from "./rssSync.js";
import type { SearchResult } from "../types/index.js";

/**
 * A release handed to AoNarr by another program (Starr's `POST /release/push`, which autobrr and scripts use, and the native
 * `POST /api/releases/push`). The release is checked, turned into the same SearchResult an indexer's feed gives, and judged
 * and grabbed by the one-release step of the RSS sync (rssSync.ts judgeOneRelease): it must name something the library wants,
 * and passes every rule a search or a feed release passes (blocklist, profile, formats, delay profile, upgrade rules).
 *
 * The link is only ever handed to a download client adapter, never fetched here. It is an http(s) address or a magnet link,
 * and is not written to the log: it can carry an indexer key or a tracker passkey (see describeLink).
 */

export interface PushIssue {
  propertyName: string;
  errorMessage: string;
}

/** The body was not a release: what is wrong with it, by the name Starr's validation uses for each field. */
export class ReleasePushInvalid extends Error {
  constructor(readonly issues: PushIssue[]) {
    super(issues.map((i) => `${i.propertyName}: ${i.errorMessage}`).join("; "));
  }
}

export interface PushedRelease {
  release: SearchResult;
  /** Stable for a link: the same release pushed twice has the same guid. */
  guid: string;
}

const MAX_LINK_LENGTH = 8192;
/** Seeders and leechers are kept as 32-bit integers. */
const MAX_COUNT = 2_147_483_647;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isAllowedLink(link: string, kind: "download" | "magnet"): boolean {
  if (link.length > MAX_LINK_LENGTH) return false;
  if (kind === "magnet") return /^magnet:\?/i.test(link);
  if (/^magnet:\?/i.test(link)) return true;
  try {
    const url = new URL(link);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Checks the body of a push the way Starr's validator does (title, link, protocol and publish date are required). */
export async function parseReleasePush(body: unknown): Promise<PushedRelease> {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const issues: PushIssue[] = [];
  const bad = (propertyName: string, errorMessage: string) => issues.push({ propertyName, errorMessage });

  const title = text(b.title);
  if (!title) bad("Title", "Title must not be empty");
  else if (title.length > 1000) bad("Title", "Title is too long");

  const download = text(b.downloadUrl);
  const magnet = text(b.magnetUrl);
  if (!download && !magnet) bad("DownloadUrl", "DownloadUrl or MagnetUrl must be given");
  if (download && !isAllowedLink(download, "download")) bad("DownloadUrl", "DownloadUrl must be an http(s) address or a magnet link");
  if (magnet && !isAllowedLink(magnet, "magnet")) bad("MagnetUrl", "MagnetUrl must be a magnet link");

  const protocolText = text(b.protocol).toLowerCase();
  const protocol = protocolText === "torrent" || protocolText === "usenet" ? protocolText : null;
  if (!protocol) bad("Protocol", "Protocol must be Torrent or Usenet");
  else if (protocol === "usenet" && (magnet || /^magnet:/i.test(download))) bad("MagnetUrl", "A magnet link is for a Torrent");

  const published = text(b.publishDate);
  const publishedAt = published ? Date.parse(published) : NaN;
  if (!published) bad("PublishDate", "PublishDate must be given");
  else if (!Number.isFinite(publishedAt)) bad("PublishDate", "PublishDate is not a date");

  let size = 0;
  if (b.size !== undefined && b.size !== null && b.size !== "") {
    size = Number(b.size);
    if (!Number.isFinite(size) || size < 0) bad("Size", "Size must be a number of bytes, zero or more");
    // The queue keeps the size as a 64-bit integer: a larger one would pass the quality checks and fail only after the client has the download.
    else if (size > Number.MAX_SAFE_INTEGER) bad("Size", `Size must be at most ${Number.MAX_SAFE_INTEGER} bytes`);
  }
  const count = (key: "seeders" | "leechers"): number | null => {
    const raw = b[key];
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    const name = key === "seeders" ? "Seeders" : "Leechers";
    if (!Number.isInteger(n) || n < 0) {
      bad(name, `${name} must be a whole number, zero or more`);
      return null;
    }
    if (n > MAX_COUNT) {
      bad(name, `${name} must be at most ${MAX_COUNT}`);
      return null;
    }
    return n;
  };
  const seeders = count("seeders");
  const leechers = count("leechers");
  if (issues.length > 0) throw new ReleasePushInvalid(issues);

  // The indexer, when the sender names one: by name (Starr's `indexer`) or by AoNarr's id. A name AoNarr does not know is kept
  // as the label of the release; the release then belongs to no indexer, so no indexer's tags or client apply to it.
  const indexers = (await db.prepare("SELECT id, name FROM indexers").all()) as { id: number; name: string }[];
  const named = text(b.indexer);
  const wantedId = Number(b.indexerId);
  const known = Number.isInteger(wantedId) && wantedId > 0 ? indexers.find((i) => Number(i.id) === wantedId) : indexers.find((i) => named && i.name.toLowerCase() === named.toLowerCase());

  const link = download || magnet;
  const release: SearchResult = {
    indexerId: known ? Number(known.id) : null,
    indexerName: known?.name ?? (named ? named.slice(0, 200) : "pushed"),
    title,
    size: Math.round(size),
    seeders,
    leechers,
    publishDate: new Date(publishedAt).toISOString(),
    downloadUrl: link,
    protocol: protocol!,
    category: null,
    magnetUrl: magnet || null,
  };
  return { release, guid: `PushedRelease-${crypto.createHash("sha1").update(link).digest("hex").slice(0, 20)}` };
}

export interface PushOutcome {
  pushed: PushedRelease;
  judgement: OneReleaseJudgement;
}

/** Validates and judges one pushed release (grabbing it when it passes). `types` limits the titles it may name. */
export async function pushRelease(body: unknown, options: { types?: string[] } = {}): Promise<PushOutcome> {
  const pushed = await parseReleasePush(body);
  const judgement = await judgeOneRelease(pushed.release, { source: "push", types: options.types });
  log.info(`[push] "${pushed.release.title}" (${describeLink(pushed.release.downloadUrl)}): ${judgement.outcome}${judgement.reasons[0] ? `, ${judgement.reasons[0]}` : ""}`);
  return { pushed, judgement };
}
