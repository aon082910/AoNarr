import type { ParsedRelease } from "./releaseParser.js";
import type { SearchResult } from "../types/index.js";

/**
 * Why a release in an interactive search would not be taken, as a list (Sonarr's `rejections[]`).
 * Each reason is permanent or temporary: a temporary one (a usenet post younger than the minimum age)
 * ends by itself, a permanent one does not. The automatic pick drops a release for the first reason it
 * meets and logs that one; the list shows all of them, so the admin sees what they are overriding.
 */

export type RejectionType = "permanent" | "temporary";

export interface DecisionRejection {
  code: string;
  reason: string;
  type: RejectionType;
}

/** Everything the checks found out about one release; null/false = that check passed (or does not apply). */
export interface ReleaseFacts {
  /** The release name is a hash, so there is no title to check it against. */
  hashName: boolean;
  blocklisted: boolean;
  /** No enabled download client takes the release's protocol. */
  noClientFor: string | null;
  /** releaseRejection(): multi-season pack, partial season, extras, disc image, sample, burned-in subtitles. */
  refusal: { code: string; reason: string } | null;
  /** availabilityRejectionDetail(): usenet retention, minimum age, indexer minimum seeders. */
  availability: { code: string; reason: string } | null;
  freeSpace: string | null;
  /** The release names another episode, season or date than the one searched for. */
  wrongTarget: string | null;
  /** A season pack that fails the pack guards. */
  pack: string | null;
  /** A type with no quality tiers (a ROM, an album, a book): the release names another title than the target. */
  name: string | null;
  /** The identity gate's verdict, only while the type's gate enforces. */
  identity: string | null;
  quality: string | null;
  notAnUpgrade: string | null;
  size: string | null;
  protocolOff: string | null;
  /** A custom format the profile marks "must not match". */
  formatRejected: string | null;
  belowMinimumScore: string | null;
}

export function emptyFacts(): ReleaseFacts {
  return {
    hashName: false,
    blocklisted: false,
    noClientFor: null,
    refusal: null,
    availability: null,
    freeSpace: null,
    wrongTarget: null,
    pack: null,
    name: null,
    identity: null,
    quality: null,
    notAnUpgrade: null,
    size: null,
    protocolOff: null,
    formatRejected: null,
    belowMinimumScore: null,
  };
}

/** The reasons for one release, most basic first. */
export function buildRejections(f: ReleaseFacts): DecisionRejection[] {
  const out: DecisionRejection[] = [];
  const add = (code: string, reason: string | null | undefined, type: RejectionType = "permanent") => {
    if (reason) out.push({ code, reason, type });
  };
  if (f.hashName) add("hash-name", "The release name is a hash, so there is no title to check it against");
  if (f.blocklisted) add("blocklisted", "This release is blocklisted for this item");
  if (f.noClientFor) add("no-client", `No enabled download client takes ${f.noClientFor} releases`);
  if (f.refusal) add(f.refusal.code, f.refusal.reason);
  if (f.availability) add(f.availability.code, capitalize(f.availability.reason), f.availability.code === "minimum-age" ? "temporary" : "permanent");
  add("free-space", f.freeSpace && capitalize(f.freeSpace));
  add("wrong-target", f.wrongTarget);
  add("season-pack", f.pack && capitalize(f.pack));
  add("name", f.name && capitalize(f.name));
  add("identity", f.identity);
  add("quality", f.quality);
  add("not-an-upgrade", f.notAnUpgrade);
  add("size", f.size);
  add("protocol-off", f.protocolOff);
  add("custom-format", f.formatRejected);
  add("minimum-score", f.belowMinimumScore);
  return out;
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export interface DecisionSummary {
  /** No reason at all. */
  approved: boolean;
  /** Reasons exist and all of them end by themselves. */
  temporarilyRejected: boolean;
  /** At least one permanent reason. */
  rejected: boolean;
}

export function summarize(rejections: DecisionRejection[]): DecisionSummary {
  const permanent = rejections.some((r) => r.type === "permanent");
  return { approved: rejections.length === 0, temporarilyRejected: rejections.length > 0 && !permanent, rejected: permanent };
}

/** How the release is packaged, for the list's Type column; null when the media type has no episodes. */
export function releaseTypeOf(parsed: Pick<ParsedRelease, "isFullSeason" | "episodeNumbers">, episodic: boolean): "single" | "season-pack" | "multi-episode" | null {
  if (!episodic) return null;
  if (parsed.isFullSeason) return "season-pack";
  if (parsed.episodeNumbers && parsed.episodeNumbers.length > 1) return "multi-episode";
  return "single";
}

/** Torznab's flags as words: freeleech, halfleech, double upload, plus the indexer's own tags. */
export function indexerFlagsOf(r: Pick<SearchResult, "downloadVolumeFactor" | "uploadVolumeFactor" | "indexerTags">): string[] {
  const flags: string[] = [];
  if (r.downloadVolumeFactor === 0) flags.push("freeleech");
  else if (r.downloadVolumeFactor != null && r.downloadVolumeFactor > 0 && r.downloadVolumeFactor < 1) flags.push("halfleech");
  if (r.uploadVolumeFactor != null && r.uploadVolumeFactor >= 2) flags.push("doubleupload");
  for (const tag of r.indexerTags ?? []) {
    const lower = tag.toLowerCase();
    if (!flags.includes(lower)) flags.push(lower);
  }
  return flags;
}

/** Minutes since the release was published; null when the date is missing or unreadable. */
export function ageMinutesOf(publishDate: string | null | undefined, now = Date.now()): number | null {
  if (!publishDate) return null;
  const at = Date.parse(publishDate);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60_000)) : null;
}
