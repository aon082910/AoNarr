import { parseStringPromise } from "xml2js";

export interface ParsedNfo {
  title: string | null;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
}

function firstText(value: unknown): string | null {
  if (Array.isArray(value)) return firstText(value[0]);
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && "_" in (value as any)) return firstText((value as any)._);
  return null;
}

/**
 * Parses a Kodi/Jellyfin-style .nfo sidecar file (movie.nfo, tvshow.nfo, etc.) into the same
 * shape AddMedia's metadata search returns, so an NFO import can prefill the same form fields
 * instead of requiring a live provider lookup.
 */
export async function parseNfo(xml: string): Promise<ParsedNfo> {
  const parsed = await parseStringPromise(xml, { explicitArray: true, mergeAttrs: true });
  const root = parsed?.movie ?? parsed?.tvshow ?? parsed?.episodedetails ?? parsed?.musicalbum ?? parsed?.album ?? null;
  if (!root) {
    return { title: null, year: null, overview: null, posterUrl: null, externalIds: {} };
  }

  const title = firstText(root.title);
  const yearText = firstText(root.year) ?? (firstText(root.premiered) ?? firstText(root.releasedate))?.slice(0, 4);
  const year = yearText ? parseInt(yearText, 10) : null;
  const overview = firstText(root.plot) ?? firstText(root.outline);

  let posterUrl: string | null = null;
  if (Array.isArray(root.thumb)) {
    const posterThumb = root.thumb.find((t: any) => !t.aspect || firstText(t.aspect) === "poster") ?? root.thumb[0];
    posterUrl = firstText(posterThumb);
  }

  const externalIds: Record<string, string> = {};
  const uniqueIds = Array.isArray(root.uniqueid) ? root.uniqueid : root.uniqueid ? [root.uniqueid] : [];
  for (const entry of uniqueIds) {
    const type = firstText(entry?.type);
    const value = firstText(entry);
    if (type && value) externalIds[type] = value;
  }
  const imdbId = firstText(root.imdbid ?? root.imdb_id);
  if (imdbId && !externalIds.imdb) externalIds.imdb = imdbId;

  return {
    title,
    year: year && !Number.isNaN(year) ? year : null,
    overview,
    posterUrl,
    externalIds,
  };
}
