export interface SubtitleSearchResult {
  language: string;
  releaseName: string;
  fileId: number | null;
  downloadUrl: string;
  provider: string;
  /** Only ever populated for OpenSubtitles results — "custom" providers have no equivalent
   * concept AoNarr can generically read via a dot-path field mapping. */
  hearingImpaired?: boolean;
  foreignPartsOnly?: boolean;
  movieHashMatch?: boolean;
  downloadCount?: number;
}

/** "" (no preference — don't filter, OpenSubtitles' own default) / "exclude" / "only". Maps
 * directly to OpenSubtitles' own `hearing_impaired`/`foreign_parts_only` query param values. */
export type SubtitleFilterPref = "" | "exclude" | "only";

export interface SubtitleSearchOptions {
  hearingImpaired?: SubtitleFilterPref;
  /** "Forced" subtitles (foreign-dialogue-only) — OpenSubtitles calls this foreign_parts_only. */
  foreignPartsOnly?: SubtitleFilterPref;
}

/**
 * OpenSubtitles REST API v1 client. Requires an API key (free tier available at
 * opensubtitles.com/consumers). Query by file name; OpenSubtitles fuzzy-matches releases.
 */
export async function searchSubtitles(
  apiKey: string,
  fileName: string,
  languages: string,
  options: SubtitleSearchOptions = {}
): Promise<SubtitleSearchResult[]> {
  const url = new URL("https://api.opensubtitles.com/api/v1/subtitles");
  url.searchParams.set("query", fileName);
  url.searchParams.set("languages", languages);
  if (options.hearingImpaired) url.searchParams.set("hearing_impaired", options.hearingImpaired);
  if (options.foreignPartsOnly) url.searchParams.set("foreign_parts_only", options.foreignPartsOnly);

  const res = await fetch(url.toString(), {
    headers: { "Api-Key": apiKey, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`OpenSubtitles search failed: HTTP ${res.status}`);
  }
  const body: any = await res.json();
  const data: any[] = body?.data ?? [];

  return data.map((d) => ({
    language: d.attributes?.language ?? "unknown",
    releaseName: d.attributes?.release ?? d.attributes?.feature_details?.title ?? fileName,
    fileId: d.attributes?.files?.[0]?.file_id ?? null,
    downloadUrl: d.attributes?.url ?? "",
    provider: "opensubtitles",
    hearingImpaired: !!d.attributes?.hearing_impaired,
    foreignPartsOnly: !!d.attributes?.foreign_parts_only,
    movieHashMatch: !!d.attributes?.moviehash_match,
    downloadCount: Number(d.attributes?.download_count ?? 0),
  }));
}

/**
 * Picks the best candidate from a set of OpenSubtitles results: an exact moviehash match is
 * always the most reliable signal available (the file itself matched byte-for-byte against a
 * known release), so it wins outright regardless of popularity; otherwise the most-downloaded
 * result is used as a popularity/trust proxy, since OpenSubtitles' v1 API doesn't expose a single
 * normalized "confidence" score the way a hash match does. Falls back to the first result with a
 * fileId (the old behavior) when neither signal is available (e.g. a "custom" provider result,
 * which never carries these fields).
 */
export function pickBestSubtitle(results: SubtitleSearchResult[]): SubtitleSearchResult | undefined {
  const withFile = results.filter((r) => r.fileId !== null || r.provider === "custom");
  if (withFile.length === 0) return undefined;
  const hashMatch = withFile.find((r) => r.movieHashMatch);
  if (hashMatch) return hashMatch;
  return [...withFile].sort((a, b) => (b.downloadCount ?? 0) - (a.downloadCount ?? 0))[0];
}

/** Same ranking as pickBestSubtitle, scoped to one language — a multi-language search (the
 * common case: a provider configured for "eng,fre,spa") returns every language's results mixed
 * into one list, so picking a single overall "best" would silently drop every language but one. */
export function pickBestSubtitleForLanguage(results: SubtitleSearchResult[], language: string): SubtitleSearchResult | undefined {
  return pickBestSubtitle(results.filter((r) => r.language === language));
}

/**
 * OpenSubtitles' download endpoint is a two-step handoff: this POST exchanges a file_id (from
 * a search result) for a short-lived signed link, which is then fetched for the actual content.
 */
export async function downloadSubtitleContent(apiKey: string, fileId: number): Promise<string> {
  const res = await fetch("https://api.opensubtitles.com/api/v1/download", {
    method: "POST",
    headers: { "Api-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) {
    throw new Error(`OpenSubtitles download handoff failed: HTTP ${res.status}`);
  }
  const body: any = await res.json();
  const link = body?.link;
  if (!link) throw new Error("OpenSubtitles download response had no link");

  const fileRes = await fetch(link);
  if (!fileRes.ok) throw new Error(`OpenSubtitles file download failed: HTTP ${fileRes.status}`);
  return fileRes.text();
}

export interface CustomSubtitleProviderConfig {
  /** URL template — `{query}` (URL-encoded) and `{languages}` are substituted before the request. */
  searchUrlTemplate: string;
  /** Dot path to the results array in the JSON response; omit if the response body itself is the array. */
  resultsPath?: string;
  /** Dot path (within each result) to a directly-downloadable subtitle file URL. */
  downloadUrlField: string;
  languageField?: string;
  releaseField?: string;
}

function getByDotPath(obj: any, dotPath: string | null | undefined): any {
  if (!dotPath) return obj;
  return dotPath.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Generic JSON subtitle-search adapter, mirroring the DDL indexer's field-mapping approach: the
 * admin points this at any subtitle API that returns JSON and a directly-downloadable file URL
 * per result, and supplies the field mapping — AoNarr doesn't need to know anything about the
 * specific provider ahead of time. Deliberately excludes scraping-based sites (no public API,
 * against their terms of service) — same reasoning as the DDL indexer only ever calling a
 * user-supplied API endpoint rather than shipping site-specific scrapers.
 */
export async function searchCustomSubtitles(
  config: CustomSubtitleProviderConfig,
  apiKey: string | null,
  fileName: string,
  languages: string
): Promise<SubtitleSearchResult[]> {
  const url = config.searchUrlTemplate
    .replace("{query}", encodeURIComponent(fileName))
    .replace("{languages}", encodeURIComponent(languages));

  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`Custom subtitle provider returned HTTP ${res.status}`);
  const body = await res.json();

  const items = getByDotPath(body, config.resultsPath);
  if (!Array.isArray(items)) {
    throw new Error(`Custom subtitle provider: resultsPath "${config.resultsPath ?? ""}" did not resolve to an array`);
  }

  const results: SubtitleSearchResult[] = [];
  for (const item of items) {
    const downloadUrl = getByDotPath(item, config.downloadUrlField);
    if (!downloadUrl) continue;
    results.push({
      language: config.languageField ? String(getByDotPath(item, config.languageField) ?? "unknown") : "unknown",
      releaseName: config.releaseField ? String(getByDotPath(item, config.releaseField) ?? fileName) : fileName,
      fileId: null,
      downloadUrl: String(downloadUrl),
      provider: "custom",
    });
  }
  return results;
}

/** Fetches subtitle text directly from a result's `downloadUrl` — used for provider types (like
 * "custom") where the search result already points straight at the file, no separate handoff step. */
export async function downloadSubtitleFromUrl(downloadUrl: string): Promise<string> {
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Subtitle file download failed: HTTP ${res.status}`);
  return res.text();
}
