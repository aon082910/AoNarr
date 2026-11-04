import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { isDiscographyTitle, parseReleaseTitle, withoutDiscographyWord } from "./releaseParser.js";

/**
 * Discography grabs (Lidarr's ParsedAlbumInfo.Discography). A release named "Artist - Discography
 * (1973-1995)" holds many of an artist's albums; one grab of it satisfies all the wanted ones it
 * covers, and the importer files each album's folder under that album. This file decides which
 * albums a release covers and whether it is worth grabbing; the search, queue and import sides call it.
 */

/** Whether discography releases are grabbed at all (Settings, default on). */
export function discographyGrabsEnabled(): boolean {
  return getSetting("discographyGrabs") !== "0";
}

/** An automatic search takes a discography only when it would add at least this many missing albums:
 * for fewer, the album's own release is the better download. A release picked by hand has no minimum. */
export const MIN_WANTED_FOR_AUTOMATIC_DISCOGRAPHY = 2;

/** And at least this share of the albums it covers: two missing albums do not call for a discography of forty. */
export const MIN_WANTED_SHARE_FOR_AUTOMATIC_DISCOGRAPHY = 0.25;

export interface DiscographyAlbum {
  id: number;
  title: string;
  releaseDate: string | null;
  monitored: boolean;
  hasFile: boolean;
}

/** The year an album's release date ("2011-05-03", "2011-05", "2011") is in, or null. */
export function albumYear(releaseDate: string | null | undefined): number | null {
  const m = String(releaseDate ?? "").trim().match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/** The albums a discography of these years covers: all of the artist's when it names none, else the
 * ones dated inside the range (an album with no date is in none). Lidarr's ParsingService.GetAlbums. */
export function albumsCoveredBy(years: { from: number | null; to: number | null } | undefined, albums: DiscographyAlbum[]): DiscographyAlbum[] {
  if (!years || years.from == null) return albums;
  return albums.filter((album) => {
    const year = albumYear(album.releaseDate);
    return year != null && year >= years.from! && (years.to == null || year <= years.to);
  });
}

export type DiscographyVerdict =
  | { ok: true; covered: DiscographyAlbum[]; wanted: DiscographyAlbum[] }
  | { ok: false; reason: string; covered: DiscographyAlbum[]; wanted: DiscographyAlbum[]; isAlbum?: true };

export interface DiscographyJudgeOptions {
  /** Fewest missing albums the release must add. */
  minWanted: number;
  /** The share of the albums it covers that must be missing (0 to 1): a discography of forty albums is not taken for two. */
  minShare?: number;
  /** Whether an album's release date is still ahead (scheduler.isNotYetReleased). */
  isUnreleased: (releaseDate: string | null) => boolean;
}

/** An album that is wanted from a discography: monitored, out, and without files. */
export function isWantedAlbum(album: DiscographyAlbum, isUnreleased: (releaseDate: string | null) => boolean): boolean {
  return album.monitored && !album.hasFile && !isUnreleased(album.releaseDate);
}

/**
 * Whether a discography release is worth grabbing for this artist: it covers albums, none of them
 * unreleased (Lidarr's DiscographySpecification: a grab would file an album that is not out), and
 * enough of them are wanted. `wanted` is what the grab is recorded against.
 */
export function judgeDiscography(releaseTitle: string, albums: DiscographyAlbum[], options: DiscographyJudgeOptions): DiscographyVerdict {
  const parsed = parseReleaseTitle(releaseTitle);
  if (!parsed.discography) return { ok: false, reason: "It is not a discography", covered: [], wanted: [] };
  // An album that has the word in its own title ("Discography: The Complete Singles Collection") is that album.
  const named = albums.find((album) => isDiscographyTitle(album.title) && compactName(releaseTitle).includes(compactName(withoutDiscographyWord(album.title))) && compactName(withoutDiscographyWord(album.title)).length >= 6);
  if (named) return { ok: false, reason: `It is the album "${named.title}", not a discography`, covered: [], wanted: [], isAlbum: true };
  const covered = albumsCoveredBy(parsed.discography, albums);
  const wanted = covered.filter((album) => isWantedAlbum(album, options.isUnreleased));
  const years = parsed.discography.from != null ? ` for ${parsed.discography.from}-${parsed.discography.to ?? "now"}` : "";
  if (covered.length === 0) {
    return { ok: false, reason: `None of this artist's albums${years ? ` are in the years it spans (${parsed.discography.from}-${parsed.discography.to ?? "now"})` : " are known"}`, covered, wanted };
  }
  const unreleased = covered.find((album) => options.isUnreleased(album.releaseDate));
  if (unreleased) {
    return { ok: false, reason: `It would include "${unreleased.title}", which is not out yet`, covered, wanted };
  }
  if (wanted.length < options.minWanted) {
    return {
      ok: false,
      reason:
        wanted.length === 0
          ? `It covers no album that is missing${years}`
          : `It would add only ${wanted.length} missing album${wanted.length === 1 ? "" : "s"}; a discography is taken for at least ${options.minWanted}`,
      covered,
      wanted,
    };
  }
  if (options.minShare && wanted.length < Math.ceil(covered.length * options.minShare)) {
    return {
      ok: false,
      reason: `It would add only ${wanted.length} missing album${wanted.length === 1 ? "" : "s"} of the ${covered.length} it covers; the albums are better searched one by one`,
      covered,
      wanted,
    };
  }
  return { ok: true, covered, wanted };
}

/** The artist's albums, as a discography is judged against them. */
export async function discographyAlbumsOf(mediaItemId: number): Promise<DiscographyAlbum[]> {
  const rows = (await db
    .prepare("SELECT id, title, release_date, monitored, has_file FROM sub_items WHERE media_item_id = ? ORDER BY release_date, id")
    .all(mediaItemId)) as { id: number; title: string; release_date: string | null; monitored: number; has_file: number }[];
  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    releaseDate: row.release_date,
    monitored: !!Number(row.monitored),
    hasFile: !!Number(row.has_file),
  }));
}

/** Whether a release name is a discography at all. */
export function isDiscographyRelease(releaseTitle: string): boolean {
  return isDiscographyTitle(releaseTitle) && !!parseReleaseTitle(releaseTitle).discography;
}

// Words of a discography's name that say what it is, not whose it is.
const NOT_THE_ARTIST = new Set(["the", "flac", "mp3", "aac", "alac", "ogg", "opus", "wav", "ape", "dsd", "m4a", "lossless", "cbr", "vbr", "web", "cd", "vinyl", "complete", "full", "studio", "albums", "collection", "official", "remastered"]);
const YEAR_SPAN_STRIP = /\b(?:19|20)\d{2}\s*(?:-|–|—|~|to)\s*(?:(?:19|20)\d{2}|\d{2}|present|now|current)\b/gi;

function nameWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !NOT_THE_ARTIST.has(word));
}

/**
 * Whether a discography release is the named artist's: once the discography word, the years and the format
 * tags are taken off, a segment of its name (they are split by " - ") is the artist and nothing else. "Queen
 * Latifah - Discography" is not Queen's; "Queen - Discography (1973-1995) [FLAC]" and "Queen Discography" are.
 */
export function releaseNamesArtist(releaseTitle: string, artist: string): boolean {
  const wanted = nameWords(artist).join(" ");
  const wantedCompact = compactName(artist);
  if (!wanted && !wantedCompact) return false;
  const cleaned = withoutDiscographyWord(releaseTitle.replace(/_/g, " ").replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " "))
    .replace(YEAR_SPAN_STRIP, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ");
  const segments = [cleaned, ...cleaned.split(/\s+[-–—~:]\s+/)];
  // The artist's name as the indexer wrote it: "P!nk" as "Pink", "R.E.M." as "REM", "AC/DC" as "ACDC".
  return segments.some((segment) => (wanted !== "" && nameWords(segment).join(" ") === wanted) || (wantedCompact !== "" && compactName(segment) === wantedCompact));
}

// Symbols an artist's name uses for a letter ("P!nk", "Ke$ha").
const LETTER_SYMBOLS: Record<string, string> = { "!": "i", $: "s", "@": "a", "€": "e" };

/** A name with the punctuation, spaces and a leading "The" taken out, for the spellings words cannot compare. */
function compactName(text: string): string {
  const folded = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[!$@€]/g, (c) => LETTER_SYMBOLS[c] ?? c)
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return folded.length > 3 && folded.startsWith("the") ? folded.slice(3) : folded;
}

/** The sub-items a queue row covers when it is a discography: empty for every other row. */
export async function queueTargetIds(queueId: number): Promise<number[]> {
  const rows = (await db.prepare("SELECT sub_item_id FROM queue_targets WHERE queue_id = ? ORDER BY sub_item_id").all(queueId)) as { sub_item_id: number }[];
  return rows.map((row) => Number(row.sub_item_id));
}
