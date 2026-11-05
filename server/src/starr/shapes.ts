import type { Request } from "express";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/errorHandler.js";
import { artworkUrlForClient } from "../services/urlBase.js";

/** Parts of a Starr resource that more than one route builds. */

export interface QualityName {
  id: number;
  name: string;
  source: string;
  resolution: number;
}

export interface QualityModel {
  quality: QualityName;
  revision: { version: number; real: number; isRepack: boolean };
}

/** "WEBDL-1080p" is source web at 1080; "Bluray-2160p", "HDTV-720p", "DVD" and the music and book names read the same way. The pre-release tiers are sources of their own (DVDSCR and REGIONAL are DVDs). */
function sourceAndResolution(name: string): { source: string; resolution: number } {
  const resolution = Number(/(\d{3,4})p/i.exec(name)?.[1] ?? 0);
  const lower = name.toLowerCase();
  let source = "unknown";
  if (lower.startsWith("webdl")) source = "web";
  else if (lower.startsWith("webrip")) source = "webRip";
  else if (lower.startsWith("bluray") || lower.startsWith("remux") || lower === "br-disk") source = "bluray";
  else if (lower.startsWith("hdtv") || lower.startsWith("sdtv")) source = "television";
  else if (lower.startsWith("raw")) source = "televisionRaw";
  else if (lower.startsWith("dvd") || lower === "regional") source = "dvd";
  else if (lower === "cam" || lower === "telesync" || lower === "telecine" || lower === "workprint") source = lower;
  return { source, resolution };
}

export interface QualityCatalog {
  byName: Map<string, { id: number; name: string; rank: number }>;
  /** Every quality, worst first. */
  ordered: { id: number; name: string; rank: number }[];
}

/** The catalog in the order a profile ranks it, worst first: the qualities it does not list (in global order), then those it does. */
export function orderedForProfile(catalog: QualityCatalog, order: string[] | null): QualityCatalog["ordered"] {
  if (!order || order.length === 0) return catalog.ordered;
  const listed = order.map((name) => catalog.byName.get(name)).filter((q): q is NonNullable<typeof q> => !!q);
  const listedNames = new Set(listed.map((q) => q.name));
  return [...catalog.ordered.filter((q) => !listedNames.has(q.name)), ...listed];
}

export async function loadQualityCatalog(): Promise<QualityCatalog> {
  const rows = (await db.prepare("SELECT id, name, rank FROM qualities ORDER BY rank").all()) as { id: number; name: string; rank: number }[];
  const ordered = rows.map((r) => ({ id: Number(r.id), name: String(r.name), rank: Number(r.rank) }));
  return { byName: new Map(ordered.map((q) => [q.name, q])), ordered };
}

export function qualityNameOf(catalog: QualityCatalog, name: string | null | undefined): QualityName {
  const known = name ? catalog.byName.get(name) : undefined;
  const label = name || "Unknown";
  return { id: known?.id ?? 0, name: label, ...sourceAndResolution(label) };
}

export function qualityModelOf(catalog: QualityCatalog, name: string | null | undefined): QualityModel {
  return { quality: qualityNameOf(catalog, name), revision: { version: 1, real: 0, isRepack: false } };
}

export function slugOf(title: string, fallback: string | number): string {
  const slug = String(title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || String(fallback);
}

export function isoOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  const text = String(value);
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** A date column as Starr writes a calendar date: YYYY-MM-DD. */
export function dayOrNull(value: unknown): string | null {
  const iso = isoOrNull(value);
  return iso ? iso.slice(0, 10) : null;
}

export function parseExternalIds(raw: unknown): Record<string, string> {
  if (!raw) return {};
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

export function numericId(value: string | undefined, label = "id"): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Invalid ${label}`);
  // No row has an id this large; the database would answer "out of range" instead of "not found".
  if (n > 2147483647) throw new HttpError(404, "NotFound");
  return n;
}

export function images(posterUrl: string | null | undefined, backdropUrl?: string | null): { coverType: string; url: string; remoteUrl: string }[] {
  const out: { coverType: string; url: string; remoteUrl: string }[] = [];
  // AoNarr's own proxied artwork is a root-relative path; under a URL base (URL_BASE) it carries the prefix.
  if (posterUrl) out.push({ coverType: "poster", url: artworkUrlForClient(posterUrl), remoteUrl: artworkUrlForClient(posterUrl) });
  if (backdropUrl) out.push({ coverType: "fanart", url: artworkUrlForClient(backdropUrl), remoteUrl: artworkUrlForClient(backdropUrl) });
  return out;
}

export interface PagingRequest {
  page: number;
  pageSize: number;
  offset: number;
  sortKey: string | null;
  sortDirection: "ascending" | "descending";
}

/** The last page a request may name: a larger offset is not a row the database can count to (SQLite: "datatype mismatch", Postgres: bigint out of range). */
const MAX_PAGE = 1_000_000;

export function pagingOf(req: Request, defaultSortKey: string | null, defaultDirection: "ascending" | "descending" = "descending"): PagingRequest {
  const asked = Math.floor(Number(req.query.page));
  // NaN, Infinity and text are "no page given"; a huge number is clamped (an empty page far past the end, as before for 5e9).
  const page = Number.isFinite(asked) ? Math.min(MAX_PAGE, Math.max(1, asked)) : 1;
  const pageSize = Math.min(1000, Math.max(1, Math.floor(Number(req.query.pageSize) || 10)));
  const direction = String(req.query.sortDirection ?? "").toLowerCase();
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    sortKey: typeof req.query.sortKey === "string" && req.query.sortKey ? req.query.sortKey : defaultSortKey,
    sortDirection: direction.startsWith("asc") ? "ascending" : direction.startsWith("desc") ? "descending" : defaultDirection,
  };
}

export function pagedBody<T>(paging: PagingRequest, records: T[], totalRecords: number) {
  return { page: paging.page, pageSize: paging.pageSize, sortKey: paging.sortKey, sortDirection: paging.sortDirection, totalRecords, records };
}

/** ?x=true / ?x=1 as a boolean; `fallback` when the parameter is not sent. */
export function flag(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || /^(true|1|yes)$/i.test(String(value));
}

export function idList(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === "" ? [] : String(value).split(",");
  return raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 0);
}

/** media_item_id to tag ids, for every item (the table is small next to the items it describes). */
export async function loadItemTags(): Promise<Map<number, number[]>> {
  const rows = (await db.prepare("SELECT media_item_id, tag_id FROM media_item_tags").all()) as { media_item_id: number; tag_id: number }[];
  const map = new Map<number, number[]>();
  for (const r of rows) {
    const list = map.get(Number(r.media_item_id)) ?? [];
    list.push(Number(r.tag_id));
    map.set(Number(r.media_item_id), list);
  }
  return map;
}

/** A validation failure in Starr's shape, for a caller (Prowlarr) that reads the field names. */
export function validationFailure(errors: { propertyName: string; errorMessage: string }[]): HttpError {
  return Object.assign(new HttpError(400, errors[0]?.errorMessage ?? "Validation failed"), {
    validation: errors.map((e) => ({ ...e, severity: "error", errorCode: "ValidationError" })),
  });
}

