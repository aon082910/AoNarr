import { albumYear } from "./discography.js";
import { editionlessTitle } from "./nonVideoMatch.js";

/**
 * Which album a folder of a downloaded discography is. Lidarr identifies an album's files by their tags;
 * here a discography is told apart by its folders, which is how every discography is laid out: one folder
 * per album, named with the album's title and usually its year ("1974 - Queen II [FLAC]").
 */

export interface MatchableAlbum {
  id: number;
  title: string;
  releaseDate: string | null;
  /** Whether the grab was for this album. Matched all the same, so a folder of an album that is already in
   * the library is not mistaken for a wanted album of the same name. */
  target: boolean;
}

export interface AlbumFolder {
  /** Where it is; only used to tell folders apart. */
  path: string;
  /** Its name, as the release gave it. */
  name: string;
  /** How many audio files are in it (a tie-break between two folders of the same album). */
  files: number;
}

/** One disc of an album that lies in a folder of its own. */
export interface DiscFolder {
  path: string;
  disc: number;
}

export type FolderMatch =
  /** `by: "tags"`: the folder's name did not say which album it is, its files' tags did (discographyTags.ts). `discs`: the album's
   * discs lie in folders of their own, which the tags show to be one album; every one of those folders carries the same list,
   * in disc order, and the album is placed from all of them together. */
  | { kind: "album"; albumId: number; target: boolean; by?: "tags"; discs?: DiscFolder[] }
  | { kind: "unmatched"; reason: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "duplicate"; reason: string; albumId: number };

// Words an edition adds to the album's name without changing which album it is.
const EDITION_ONLY_WORDS = new Set([
  "remastered", "remaster", "remasters", "deluxe", "expanded", "edition", "anniversary", "bonus", "tracks", "track", "version", "mono",
  "stereo", "reissue", "reissued", "digipak", "limited", "special", "original", "japan", "japanese", "import", "explicit", "clean",
]);
// Words a rip adds: the format and the medium.
const RIP_WORDS = new Set([
  "hdcd", "sacd", "dsd", "flac", "mp3", "aac", "alac", "ogg", "opus", "wav", "ape", "m4a", "lossless", "cbr", "vbr", "web", "cd", "cds",
  "vinyl", "lp", "rip", "hires", "hi", "res", "24bit", "16bit", "320", "256", "192", "v0", "v2", "kbps", "khz", "disc", "disk",
]);
const EDITION_WORDS = new Set([...EDITION_ONLY_WORDS, ...RIP_WORDS]);
const DISC_WORD = /^(?:cd|disc|disk)\d*$/;
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
const YEAR = /^(?:19|20)\d{2}$/;

function foldedWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .map((word) => ROMAN[word] ?? word);
}

/** The words that identify an album title: its name without the articles, editions and rip tags. */
export function albumWords(title: string): string[] {
  return foldedWords(editionlessTitle(title)).filter((word) => word !== "the" && !EDITION_WORDS.has(word) && !DISC_WORD.test(word));
}

export function sameWords(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((word, i) => word === b[i]);
}

/** The candidate readings of a folder name: with and without the artist's name, and with the year the folder
 * carries taken off (an album can be called "1989" itself, so a year is only taken off when that matches). */
function folderReadings(name: string, artist: string): { words: string[]; years: number[] }[] {
  const text = name.replace(/_/g, " ");
  const years = Array.from(text.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g), (m) => Number(m[1]));
  const unbracketed = text.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ");
  const artistWords = albumWords(artist);
  const segments = unbracketed.split(/\s+[-–—~]\s+/);
  const withoutArtist = segments.filter((segment) => !sameWords(albumWords(segment), artistWords));
  // "Queen - Queen (1973)" is the artist and then a self-titled album: only the first is the artist's name.
  const firstArtist = segments.findIndex((segment) => sameWords(albumWords(segment), artistWords));
  const withoutFirstArtist = firstArtist < 0 ? [] : segments.filter((_, i) => i !== firstArtist);
  const readings: string[][] = [];
  for (const parts of [segments, withoutArtist, withoutFirstArtist]) {
    if (parts.length === 0) continue;
    const words = parts.flatMap((part) => albumWords(part));
    readings.push(words);
    // Each year the name carries, taken off once ("1974 Queen II"), and every year taken off.
    for (const word of new Set(words.filter((w) => YEAR.test(w)))) {
      const at = words.indexOf(word);
      readings.push([...words.slice(0, at), ...words.slice(at + 1)]);
    }
    readings.push(words.filter((w) => !YEAR.test(w)));
  }
  // Brackets can hold the album ("Artist - [Album]") when nothing else does.
  const inside = Array.from(text.matchAll(/[[(]([^\])]*)[\])]/g), (m) => albumWords(m[1])).filter((words) => words.length > 0 && !(words.length === 1 && YEAR.test(words[0])));
  if (inside.length > 0 && readings.every((words) => words.length === 0)) readings.push(...inside);
  return readings.map((words) => ({ words, years }));
}

/** How many edition and rip words a folder name carries: of two folders of one album, the plainer is the album. */
function extraWordCount(name: string): number {
  return foldedWords(name).filter((word) => EDITION_ONLY_WORDS.has(word) || DISC_WORD.test(word)).length;
}

/** Whether a folder name says it holds one disc of an album: "Album CD2", "Album [Disc 1]", "Album (disk 2)". */
function carriesDisc(name: string): boolean {
  return /(?<![a-z0-9])(?:cd|disc|disk)[\s._-]*\d+(?![0-9])/i.test(name);
}

/** 1 for a name that says lossless, 0 otherwise. */
function losslessRank(name: string): number {
  return /(?<![a-z])(?:flac|alac|ape|wav|dsd|lossless)(?![a-z])/i.test(name) ? 1 : 0;
}

/**
 * Tells each folder of a discography which album it holds. A folder holds an album when its name, taken
 * off the artist, the year, the format and the edition words, is the album's title. Two albums of one
 * title (self-titled records, several "Greatest Hits") are told apart by the year in the folder's name;
 * with none to go by the folder is ambiguous and left alone. When two folders hold one album, the plainer
 * one is taken (not "Deluxe Edition", "CD2") and then the one with more files.
 */
export function matchAlbumFolders(folders: AlbumFolder[], artist: string, albums: MatchableAlbum[]): Map<string, FolderMatch> {
  const result = new Map<string, FolderMatch>();
  const claimed = new Map<number, AlbumFolder>();
  /** Albums whose discs lie in folders of their own. */
  const discSplit = new Set<number>();
  const albumTokens = albums.map((album) => ({ album, words: albumWords(album.title) }));
  for (const folder of folders) {
    const readings = folderReadings(folder.name, artist);
    const years = readings[0]?.years ?? [];
    const matches = albumTokens.filter(({ words }) => words.length > 0 && readings.some((reading) => sameWords(reading.words, words)));
    if (matches.length === 0) {
      result.set(folder.path, { kind: "unmatched", reason: `"${folder.name}" is not the name of any album of this artist` });
      continue;
    }
    let chosen = matches;
    if (chosen.length > 1) {
      const byYear = chosen.filter(({ album }) => {
        const year = albumYear(album.releaseDate);
        return year != null && years.includes(year);
      });
      if (byYear.length === 1) chosen = byYear;
    }
    if (chosen.length > 1) {
      result.set(folder.path, { kind: "ambiguous", reason: `"${folder.name}" fits ${chosen.length} albums (${chosen.map(({ album }) => `"${album.title}"`).join(", ")}) and names no year to tell them apart` });
      continue;
    }
    const album = chosen[0].album;
    const earlier = claimed.get(album.id);
    if (earlier) {
      // Two folders for one album, one of them named for a disc ("Album CD1", "Album [Disc 2]"), are the album's discs
      // laid side by side, not two copies of it: taking one would file half the album as the whole of it.
      if (discSplit.has(album.id) || carriesDisc(folder.name) || carriesDisc(earlier.name)) {
        discSplit.add(album.id);
        for (const part of [folder, earlier]) {
          result.set(part.path, { kind: "ambiguous", reason: `"${part.name}" is one of several disc folders of "${album.title}", which are left for a manual import` });
        }
        continue;
      }
      // The plainer name, then the lossless rip, then the one with more files.
      const mine = [extraWordCount(folder.name), -losslessRank(folder.name), -folder.files, folder.path] as const;
      const theirs = [extraWordCount(earlier.name), -losslessRank(earlier.name), -earlier.files, earlier.path] as const;
      const better = mine[0] !== theirs[0] ? mine[0] < theirs[0] : mine[1] !== theirs[1] ? mine[1] < theirs[1] : mine[2] !== theirs[2] ? mine[2] < theirs[2] : mine[3] < theirs[3];
      if (!better) {
        result.set(folder.path, { kind: "duplicate", reason: `"${folder.name}" is another copy of "${album.title}"; "${earlier.name}" was taken`, albumId: album.id });
        continue;
      }
      result.set(earlier.path, { kind: "duplicate", reason: `"${earlier.name}" is another copy of "${album.title}"; "${folder.name}" was taken`, albumId: album.id });
    }
    claimed.set(album.id, folder);
    result.set(folder.path, { kind: "album", albumId: album.id, target: album.target });
  }
  return result;
}
