import fs from "node:fs";
import path from "node:path";

export interface LocalArtwork {
  posterPath: string | null;
  backdropPath: string | null;
}

const POSTER_CANDIDATES = ["poster.jpg", "poster.jpeg", "poster.png", "folder.jpg", "folder.jpeg", "folder.png"];
const BACKDROP_CANDIDATES = ["fanart.jpg", "fanart.jpeg", "fanart.png", "backdrop.jpg", "backdrop.jpeg", "backdrop.png"];

function firstExisting(dir: string, candidates: string[]): string | null {
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolves local poster/backdrop art sitting in `dir`, next to whichever sidecar file this came
 * from — Kodi's own poster.jpg/folder.jpg and fanart.jpg/backdrop.jpg convention, plus (poster
 * only, since that's the only one an NFO's own <thumb> tag can name) a sidecar's own thumb value
 * when it's a relative filename rather than a real http(s) URL. `thumbValue` should be exactly
 * whatever ParsedNfo.posterUrl came back as — already a real remote URL is left alone entirely
 * (this never overrides a working Round 340 remote-thumb match, only fills in the cases that one
 * couldn't handle at all: a relative path, or no <thumb> tag whatsoever), a relative filename is
 * tried against `dir` first (an explicit reference should win over the bare-convention guess), and
 * the bare poster.jpg/folder.jpg convention is the fallback either way. There's no backdrop
 * equivalent of <thumb> in any real-world NFO writer, so backdrop is always the bare-file
 * convention alone.
 */
export function resolveLocalArtwork(dir: string, thumbValue: string | null | undefined): LocalArtwork {
  const isRemoteUrl = !!thumbValue && /^https?:\/\//i.test(thumbValue);
  let posterPath: string | null = null;
  if (thumbValue && !isRemoteUrl) {
    const candidate = path.join(dir, thumbValue);
    if (fs.existsSync(candidate)) posterPath = candidate;
  }
  if (!posterPath && !isRemoteUrl) posterPath = firstExisting(dir, POSTER_CANDIDATES);
  const backdropPath = firstExisting(dir, BACKDROP_CANDIDATES);
  return { posterPath, backdropPath };
}
