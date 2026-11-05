import type { Quality, QualityProfile } from "../types.js";

/**
 * The ladder in the order a profile ranks it, worst to best. Mirrors the server (quality.ts orderedRank): a profile with
 * no order of its own ranks by the global order; with one, the qualities it lists keep its order and each one it leaves
 * out stands in front of the first listed quality that is higher on the global ladder (after the last when none is), in
 * global order among those of the same place.
 */
export function profileLadder(profile: Pick<QualityProfile, "qualityOrder">, qualities: Quality[]): string[] {
  const global = [...qualities].sort((a, b) => a.rank - b.rank).map((q) => q.name);
  const listed = (profile.qualityOrder ?? []).filter((name) => global.includes(name));
  if (listed.length === 0) return global;
  const globalRank = new Map(global.map((name, index) => [name, index]));
  const ladder = [...listed];
  for (const name of global) {
    if (ladder.includes(name)) continue;
    const before = ladder.findIndex((other) => (globalRank.get(other) as number) > (globalRank.get(name) as number));
    ladder.splice(before < 0 ? ladder.length : before, 0, name);
  }
  return ladder;
}

/** The profile's allowed qualities, worst to best, in the order it ranks them. */
export function allowedInProfileOrder(profile: Pick<QualityProfile, "qualityOrder" | "allowedQualities">, qualities: Quality[]): string[] {
  return profileLadder(profile, qualities).filter((name) => profile.allowedQualities.includes(name));
}

/** `names` with the one at `index` moved a place towards the worst (-1) or the best (1); null when it cannot move. */
export function moveWithin(names: string[], index: number, direction: -1 | 1): string[] | null {
  const target = index + direction;
  if (index < 0 || index >= names.length || target < 0 || target >= names.length) return null;
  const next = [...names];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Qualities nobody has to think about: a quality profile allows none of them unless its admin adds it. */
const OFF_BY_DEFAULT = new Set(["WORKPRINT", "CAM", "TELESYNC", "TELECINE", "REGIONAL", "DVDSCR", "BR-DISK", "Raw-HD"]);

const NOTES: Record<string, string> = {
  WORKPRINT: "An unfinished cut of a film, a pre-release copy.",
  CAM: "A recording of a cinema screen (CAM, HDCAM), a pre-release copy.",
  TELESYNC: "A cinema recording with the sound taken from a direct feed (TS, HDTS), a pre-release copy.",
  TELECINE: "A copy made from the film reel (TC, HDTC), a pre-release copy.",
  REGIONAL: "A DVD of a region that gets the film early (R5), a pre-release copy.",
  DVDSCR: "A screener sent out before release, a pre-release copy.",
  "BR-DISK": "An untouched Blu-ray disc image: not a file the importer can use. The \"reject raw disc images\" rule keeps it out until that is switched off.",
  "Raw-HD": "A raw HD capture (an MPEG-2 transport stream).",
  "DVD-R": "A DVD image. The \"reject raw disc images\" rule keeps it out until that is switched off.",
  SD: "Standard definition whose source cannot be told from the release name.",
};

/** Whether no profile allows this quality until its admin adds it (the pre-release copies, BR-DISK and Raw-HD). */
export function isOffByDefault(name: string): boolean {
  return OFF_BY_DEFAULT.has(name);
}

/** A line about what a quality is, for the Qualities list (nothing for the ones every profile knows). */
export function qualityNote(name: string): string | null {
  const note = NOTES[name];
  if (!note) return null;
  return OFF_BY_DEFAULT.has(name) ? `${note} Off by default: no quality profile allows it unless you tick it in the profile.` : note;
}
