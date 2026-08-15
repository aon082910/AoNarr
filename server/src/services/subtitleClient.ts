export interface SubtitleSearchResult {
  language: string;
  releaseName: string;
  fileId: number | null;
  downloadUrl: string;
  provider: string;
}

/**
 * OpenSubtitles REST API v1 client. Requires an API key (free tier available at
 * opensubtitles.com/consumers). Query by file name; OpenSubtitles fuzzy-matches releases.
 */
export async function searchSubtitles(
  apiKey: string,
  fileName: string,
  languages: string
): Promise<SubtitleSearchResult[]> {
  const url = new URL("https://api.opensubtitles.com/api/v1/subtitles");
  url.searchParams.set("query", fileName);
  url.searchParams.set("languages", languages);

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
  }));
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
