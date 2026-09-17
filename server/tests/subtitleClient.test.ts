import { describe, it, expect, afterEach, vi } from "vitest";
import {
  searchSubtitles,
  pickBestSubtitle,
  pickBestSubtitleForLanguage,
  downloadSubtitleContent,
  searchCustomSubtitles,
  downloadSubtitleFromUrl,
  type SubtitleSearchResult,
} from "../src/services/subtitleClient.js";

// subtitleClient.ts has no db/config/logger import at all — genuinely pure aside from global
// fetch, so static top-level imports are safe and no setupTestDb() is needed.

afterEach(() => {
  vi.unstubAllGlobals();
});

function result(overrides: Partial<SubtitleSearchResult> = {}): SubtitleSearchResult {
  return {
    language: "eng",
    releaseName: "Some.Release.1080p",
    fileId: 1,
    downloadUrl: "https://example.com/sub.srt",
    provider: "opensubtitles",
    ...overrides,
  };
}

describe("searchSubtitles", () => {
  it("builds the request URL with query/languages and the Api-Key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await searchSubtitles("test-key", "Movie.2024.1080p.mkv", "en,fr");

    const [calledUrl, calledOptions] = fetchMock.mock.calls[0];
    const url = new URL(calledUrl as string);
    expect(url.origin + url.pathname).toBe("https://api.opensubtitles.com/api/v1/subtitles");
    expect(url.searchParams.get("query")).toBe("Movie.2024.1080p.mkv");
    expect(url.searchParams.get("languages")).toBe("en,fr");
    expect(url.searchParams.has("hearing_impaired")).toBe(false);
    expect(url.searchParams.has("foreign_parts_only")).toBe(false);
    expect((calledOptions as any).headers["Api-Key"]).toBe("test-key");
  });

  it("includes hearing_impaired/foreign_parts_only params only when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await searchSubtitles("key", "file.mkv", "en", { hearingImpaired: "exclude", foreignPartsOnly: "only" });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("hearing_impaired")).toBe("exclude");
    expect(url.searchParams.get("foreign_parts_only")).toBe("only");
  });

  it("throws with the HTTP status on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(searchSubtitles("bad-key", "file.mkv", "en")).rejects.toThrow("OpenSubtitles search failed: HTTP 401");
  });

  it("maps OpenSubtitles' response shape into SubtitleSearchResult[]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              attributes: {
                language: "eng",
                release: "Movie.2024.1080p.WEB-DL",
                files: [{ file_id: 555 }],
                url: "https://opensubtitles.com/sub/555",
                hearing_impaired: true,
                foreign_parts_only: false,
                moviehash_match: true,
                download_count: 4200,
              },
            },
          ],
        }),
      })
    );

    const results = await searchSubtitles("key", "file.mkv", "en");

    expect(results).toEqual([
      {
        language: "eng",
        releaseName: "Movie.2024.1080p.WEB-DL",
        fileId: 555,
        downloadUrl: "https://opensubtitles.com/sub/555",
        provider: "opensubtitles",
        hearingImpaired: true,
        foreignPartsOnly: false,
        movieHashMatch: true,
        downloadCount: 4200,
      },
    ]);
  });

  it("falls back to feature_details.title, then the queried file name, for releaseName", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { attributes: { feature_details: { title: "Feature Title" } } },
          { attributes: {} },
        ],
      }),
    }));

    const results = await searchSubtitles("key", "queried-file-name.mkv", "en");

    expect(results[0].releaseName).toBe("Feature Title");
    expect(results[1].releaseName).toBe("queried-file-name.mkv");
  });

  it("returns an empty array when the response has no data field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    await expect(searchSubtitles("key", "file.mkv", "en")).resolves.toEqual([]);
  });
});

describe("pickBestSubtitle", () => {
  it("returns undefined when there are no candidates with a usable file", () => {
    expect(pickBestSubtitle([])).toBeUndefined();
    expect(pickBestSubtitle([result({ fileId: null, provider: "opensubtitles" })])).toBeUndefined();
  });

  it("includes a 'custom' provider result even though its fileId is null", () => {
    const custom = result({ fileId: null, provider: "custom" });
    expect(pickBestSubtitle([custom])).toBe(custom);
  });

  it("prefers a movie-hash match over a much more downloaded non-hash-match result", () => {
    const popular = result({ downloadCount: 99999, movieHashMatch: false });
    const hashMatch = result({ downloadCount: 1, movieHashMatch: true });

    expect(pickBestSubtitle([popular, hashMatch])).toBe(hashMatch);
  });

  it("falls back to the most-downloaded result when there's no hash match", () => {
    const low = result({ downloadCount: 10 });
    const high = result({ downloadCount: 500 });
    const mid = result({ downloadCount: 100 });

    expect(pickBestSubtitle([low, high, mid])).toBe(high);
  });

  it("treats a missing downloadCount as 0 when ranking", () => {
    const noCount = result({ downloadCount: undefined });
    const withCount = result({ downloadCount: 1 });

    expect(pickBestSubtitle([noCount, withCount])).toBe(withCount);
  });

  it("does not mutate the input array", () => {
    const a = result({ downloadCount: 1 });
    const b = result({ downloadCount: 500 });
    const input = [a, b];

    pickBestSubtitle(input);

    expect(input).toEqual([a, b]); // order preserved — the ranking sort must never reorder the caller's own array
  });
});

describe("pickBestSubtitleForLanguage", () => {
  it("only considers results in the requested language", () => {
    const wrongLanguageButPopular = result({ language: "fre", downloadCount: 99999 });
    const rightLanguage = result({ language: "eng", downloadCount: 1 });

    expect(pickBestSubtitleForLanguage([wrongLanguageButPopular, rightLanguage], "eng")).toBe(rightLanguage);
  });

  it("returns undefined when no result matches the requested language", () => {
    expect(pickBestSubtitleForLanguage([result({ language: "fre" })], "eng")).toBeUndefined();
  });
});

describe("downloadSubtitleContent", () => {
  it("posts the file_id, then fetches and returns the signed link's content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ link: "https://cdn.example.com/signed/sub.srt" }) })
      .mockResolvedValueOnce({ ok: true, text: async () => "1\n00:00:01,000 --> 00:00:02,000\nHello" });
    vi.stubGlobal("fetch", fetchMock);

    const content = await downloadSubtitleContent("test-key", 555);

    expect(content).toBe("1\n00:00:01,000 --> 00:00:02,000\nHello");
    const [handoffUrl, handoffOptions] = fetchMock.mock.calls[0];
    expect(handoffUrl).toBe("https://api.opensubtitles.com/api/v1/download");
    expect((handoffOptions as any).method).toBe("POST");
    expect(JSON.parse((handoffOptions as any).body)).toEqual({ file_id: 555 });
    expect(fetchMock.mock.calls[1][0]).toBe("https://cdn.example.com/signed/sub.srt");
  });

  it("throws with the HTTP status when the handoff request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));

    await expect(downloadSubtitleContent("key", 1)).rejects.toThrow("OpenSubtitles download handoff failed: HTTP 429");
  });

  it("throws when the handoff response has no link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    await expect(downloadSubtitleContent("key", 1)).rejects.toThrow("OpenSubtitles download response had no link");
  });

  it("throws with the HTTP status when the signed-link file download fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ link: "https://cdn.example.com/signed/sub.srt" }) })
      .mockResolvedValueOnce({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadSubtitleContent("key", 1)).rejects.toThrow("OpenSubtitles file download failed: HTTP 404");
  });
});

describe("searchCustomSubtitles", () => {
  const config = {
    searchUrlTemplate: "https://provider.example.com/search?q={query}&lang={languages}",
    resultsPath: "data.results",
    downloadUrlField: "download.url",
    languageField: "lang",
    releaseField: "title",
  };

  it("substitutes {query} and {languages} (URL-encoded) into the template", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { results: [] } }) });
    vi.stubGlobal("fetch", fetchMock);

    await searchCustomSubtitles(config, null, "Movie Title (2024).mkv", "en fr");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://provider.example.com/search?q=Movie%20Title%20(2024).mkv&lang=en%20fr"
    );
  });

  it("sends a Bearer authorization header only when an apiKey is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { results: [] } }) });
    vi.stubGlobal("fetch", fetchMock);

    await searchCustomSubtitles(config, "secret-token", "file.mkv", "en");
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe("Bearer secret-token");

    fetchMock.mockClear();
    await searchCustomSubtitles(config, null, "file.mkv", "en");
    expect((fetchMock.mock.calls[0][1] as any).headers).toEqual({});
  });

  it("throws with the HTTP status on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(searchCustomSubtitles(config, null, "file.mkv", "en")).rejects.toThrow("Custom subtitle provider returned HTTP 503");
  });

  it("resolves the results array via the configured dot path and maps each field by dot path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            results: [{ lang: "eng", title: "Custom Release Name", download: { url: "https://provider.example.com/dl/1.srt" } }],
          },
        }),
      })
    );

    const results = await searchCustomSubtitles(config, null, "file.mkv", "en");

    expect(results).toEqual([
      {
        language: "eng",
        releaseName: "Custom Release Name",
        fileId: null,
        downloadUrl: "https://provider.example.com/dl/1.srt",
        provider: "custom",
      },
    ]);
  });

  it("treats the response body itself as the results array when resultsPath is omitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ download: { url: "https://provider.example.com/dl/2.srt" } }],
      })
    );

    const results = await searchCustomSubtitles({ ...config, resultsPath: undefined }, null, "file.mkv", "en");

    expect(results).toHaveLength(1);
    expect(results[0].downloadUrl).toBe("https://provider.example.com/dl/2.srt");
  });

  it("throws when the configured resultsPath does not resolve to an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { results: "not an array" } }) }));

    await expect(searchCustomSubtitles(config, null, "file.mkv", "en")).rejects.toThrow(
      'Custom subtitle provider: resultsPath "data.results" did not resolve to an array'
    );
  });

  it("defaults language to 'unknown' and releaseName to the queried file name when those fields aren't configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { results: [{ download: { url: "https://provider.example.com/dl/3.srt" } }] } }),
      })
    );

    const results = await searchCustomSubtitles(
      { searchUrlTemplate: config.searchUrlTemplate, resultsPath: "data.results", downloadUrlField: "download.url" },
      null,
      "fallback-name.mkv",
      "en"
    );

    expect(results[0]).toMatchObject({ language: "unknown", releaseName: "fallback-name.mkv" });
  });

  it("skips an item whose downloadUrlField doesn't resolve to a value, without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            results: [
              { lang: "eng", title: "Missing URL" }, // no `download` key at all
              { lang: "fre", title: "Has URL", download: { url: "https://provider.example.com/dl/4.srt" } },
            ],
          },
        }),
      })
    );

    const results = await searchCustomSubtitles(config, null, "file.mkv", "en");

    expect(results).toHaveLength(1);
    expect(results[0].releaseName).toBe("Has URL");
  });
});

describe("downloadSubtitleFromUrl", () => {
  it("fetches the given URL and returns its text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "subtitle content" }));

    await expect(downloadSubtitleFromUrl("https://example.com/sub.srt")).resolves.toBe("subtitle content");
  });

  it("throws with the HTTP status on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 410 }));

    await expect(downloadSubtitleFromUrl("https://example.com/gone.srt")).rejects.toThrow("Subtitle file download failed: HTTP 410");
  });
});
