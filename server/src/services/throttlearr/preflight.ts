import { db } from "../../db/index.js";
import type { ParsedRelease } from "../releaseParser.js";
import { parseReleaseTitle } from "../releaseParser.js";
import { usesQualityTiers } from "../quality.js";
import { releaseRuntimeMinutes, runtimeContextFor, type RuntimeContext } from "../releaseRuntime.js";
import { nzbVerdict, parseNzb } from "./nzbInspect.js";
import { getThrottlearrSettings, type ThrottlearrSettings } from "./settings.js";

/**
 * Throttlearr's pre-flight checks: a release that can never end in a usable import is refused before it takes a
 * slot, a download or a place in the queue. Two stages:
 *
 *  1. By name and indexer size, in `chooseBestResult` next to the other release rejections, so a refused release is
 *     skipped and the next best one is tried in the same search (no failed download, no blocklist round trip).
 *  2. By the NZB's own file list, when the download client adapter has fetched it (`inspectNzb` in AddOptions).
 *     A refusal there is a normal refused release: it is blocklisted and the search goes on.
 *
 * All of it runs only while Throttlearr is on and its `preflight` switches are, and only for media that has
 * qualities (films and series); music, books and ROMs are never judged here.
 */

export type PreflightCode = "junk-name" | "size-floor";

export interface PreflightRejection {
  code: PreflightCode;
  reason: string;
}

// ---- 1. names ---------------------------------------------------------------------------------------------------------

/** Where the title ends and the release tags begin: the year, an episode marker, a resolution or a source. A word like
 * "sample" or "trailer" counts as junk only after this point, so a film called "The Trailer" is not refused. */
const BOUNDARY = /(?:^|[^a-z0-9])(?:(?:19|20)\d{2}|s\d{1,2}e\d{1,3}|(?:2160|1080|720|480)p|blu-?ray|web-?dl|web-?rip|hdtv|dvd-?rip|brrip)(?![a-z0-9])/i;
const JUNK_AFTER_TITLE: { re: RegExp; label: string }[] = [
  { re: /(?:^|[^a-z0-9])sample(?![a-z0-9])/i, label: "a sample clip" },
  { re: /(?:^|[^a-z0-9])(?:trailer|teaser)s?(?![a-z0-9])/i, label: "a trailer" },
  { re: /(?:^|[^a-z0-9])featurettes?(?![a-z0-9])/i, label: "a featurette" },
  { re: /(?:^|[^a-z0-9])behind[ ._-]the[ ._-]scenes(?![a-z0-9])/i, label: "behind-the-scenes extras" },
];
const JUNK_ANYWHERE: { re: RegExp; label: string }[] = [
  { re: /\.nfo(?![a-z0-9])/i, label: "an .nfo text file" },
  { re: /\(incomplete\)|\[incomplete\]|^incomplete[ ._-]/i, label: "marked incomplete" },
  { re: /(?<![a-z0-9])passworded(?![a-z0-9])/i, label: "passworded" },
  // A file name, not a release: an archive, an installer or a disc image as the whole name. "[NO.RAR]" ends in a bracket.
  { re: /\.(?:iso|exe|scr|zip|rar)$/i, label: "a file, not a release" },
];

/** Why the name says this is not the film or episode, or null. */
export function junkNameRejection(title: string): PreflightRejection | null {
  for (const j of JUNK_ANYWHERE) {
    if (j.re.test(title)) return { code: "junk-name", reason: `Its name says it is ${j.label}` };
  }
  const boundary = BOUNDARY.exec(title);
  if (!boundary) return null;
  const tags = title.slice(boundary.index + boundary[0].length);
  for (const j of JUNK_AFTER_TITLE) {
    if (j.re.test(tags)) return { code: "junk-name", reason: `Its name says it is ${j.label}` };
  }
  return null;
}

// ---- 2. size ----------------------------------------------------------------------------------------------------------

/** The least a release of this resolution can weigh per minute of video and still be worth having. Far under what any
 * real encode uses (a 1080p HEVC film is 6 MB/min and up), so it refuses the 146 MB "1080p" film and nothing honest. */
export function sizeFloorMbPerMinute(resolution: string | null): number {
  switch (resolution) {
    case "2160p":
      return 8;
    case "1080p":
      return 3;
    case "720p":
      return 2;
    default:
      return 1;
  }
}

/** The least bytes a release may hold, from its resolution and the minutes of video it covers. */
export function sizeFloorBytes(resolution: string | null, runtimeMinutes: number): number {
  return Math.round(sizeFloorMbPerMinute(resolution) * Math.max(1, runtimeMinutes) * 1_000_000);
}

/** The runtime facts the checks need, or null when pre-flight is off for this search. */
export interface PreflightContext {
  settings: ThrottlearrSettings;
  runtime: RuntimeContext | null;
}

export async function preflightContextFor(mediaItemId: number | null, mediaType: string): Promise<PreflightContext | null> {
  const settings = getThrottlearrSettings();
  if (!settings.enabled || !settings.preflight.enabled || !usesQualityTiers(mediaType)) return null;
  const runtime = settings.preflight.sizeFloor || settings.preflight.inspectNzb ? await runtimeContextFor(mediaItemId, mediaType, { always: true }) : null;
  return { settings, runtime };
}

/** Pure: the verdict on one search result, by its name and the size its indexer reports (null: unknown, never judged). */
export function preflightRejection(
  ctx: PreflightContext,
  release: { title: string },
  parsed: Pick<ParsedRelease, "resolution" | "isFullSeason" | "seasonNumber" | "episodeNumbers" | "episodeRange">,
  size: number | null
): PreflightRejection | null {
  const p = ctx.settings.preflight;
  if (p.junkNames) {
    const junk = junkNameRejection(release.title);
    if (junk) return junk;
  }
  if (p.sizeFloor && size != null && size > 0 && ctx.runtime) {
    const floor = sizeFloorBytes(parsed.resolution, releaseRuntimeMinutes(parsed, ctx.runtime));
    if (size < floor) {
      return { code: "size-floor", reason: `It is ${Math.round(size / 1e6)} MB for ${parsed.resolution ?? "its quality"}, under the ${Math.round(floor / 1e6)} MB floor` };
    }
  }
  return null;
}

// ---- 3. the NZB itself ------------------------------------------------------------------------------------------------

/** Never inspect more than this much text; a real NZB of a large release is a few megabytes. */
const MAX_INSPECT_CHARS = 64 * 1024 * 1024;

/** Samples under this are never a whole film or episode, whatever the floor says. */
export const SAMPLE_MAX_BYTES = 70 * 1_000_000;

/**
 * The inspector handed to a download client adapter with the release: given the NZB's bytes it returns the reason to
 * refuse it, or null. Built from the release's own title and what it covers, so the size rule is the floor for its
 * quality and runtime.
 */
export async function nzbInspectorFor(
  settings: ThrottlearrSettings,
  release: { title: string; protocol: string },
  mediaItemId: number | null,
  mediaType: string
): Promise<((nzb: Buffer) => string | null) | undefined> {
  if (!settings.enabled || !settings.preflight.enabled || !settings.preflight.inspectNzb) return undefined;
  if (release.protocol !== "usenet" || !usesQualityTiers(mediaType)) return undefined;
  const parsed = parseReleaseTitle(release.title);
  const runtime = await runtimeContextFor(mediaItemId, mediaType, { always: true });
  const floor = settings.preflight.sizeFloor && runtime ? sizeFloorBytes(parsed.resolution, releaseRuntimeMinutes(parsed, runtime)) : 0;
  const minPayloadBytes = Math.max(SAMPLE_MAX_BYTES, floor);
  return (nzb: Buffer) => {
    if (nzb.length > MAX_INSPECT_CHARS) return null; // too big to read here: left to the client
    const verdict = nzbVerdict(parseNzb(nzb.toString("utf-8")), { minPayloadBytes });
    return verdict ? verdict.reason : null;
  };
}

/** Looks up a media item's type for the release worker, which holds only the queue row. */
export async function mediaTypeOf(mediaItemId: number): Promise<string | null> {
  const row = (await db.prepare("SELECT type FROM media_items WHERE id = ?").get(mediaItemId)) as { type: string } | undefined;
  return row?.type ?? null;
}
