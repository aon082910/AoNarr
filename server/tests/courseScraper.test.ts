import { describe, it, expect, afterEach, vi } from "vitest";
import { scrapeCoursePage } from "../src/services/courseScraper.js";

// courseScraper.ts has no db/config/logger import at all — genuinely pure aside from global fetch,
// so static top-level imports are safe and no setupTestDb() is needed.

function mockHtmlResponse(html: string, ok = true, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok, status, text: async () => html })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scrapeCoursePage — URL validation", () => {
  it("rejects a string that isn't a valid URL at all", async () => {
    await expect(scrapeCoursePage("not a url")).rejects.toThrow("Not a valid URL");
  });

  it("rejects a non-http(s) protocol", async () => {
    await expect(scrapeCoursePage("ftp://example.com/course")).rejects.toThrow("Only http(s) URLs are supported");
  });
});

describe("scrapeCoursePage — network handling", () => {
  it("throws a friendly error when the fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(scrapeCoursePage("https://example.com/course")).rejects.toThrow(/Couldn't reach that URL/);
  });

  it("throws with the HTTP status when the response isn't ok", async () => {
    mockHtmlResponse("<html></html>", false, 404);

    await expect(scrapeCoursePage("https://example.com/course")).rejects.toThrow("Failed to fetch course page: HTTP 404");
  });
});

describe("scrapeCoursePage — title extraction", () => {
  it("throws when neither an og:title nor a <title> tag is present", async () => {
    mockHtmlResponse("<html><body>No head metadata here</body></html>");

    await expect(scrapeCoursePage("https://example.com/course")).rejects.toThrow(/Couldn't find a title/);
  });

  it("prefers og:title over the <title> tag when both are present", async () => {
    mockHtmlResponse(`<html><head>
      <title>Plain Title - Some Site</title>
      <meta property="og:title" content="OG Title Wins">
    </head></html>`);

    const result = await scrapeCoursePage("https://example.com/course");

    expect(result.title).toBe("OG Title Wins");
  });

  it("falls back to the <title> tag when og:title is absent", async () => {
    mockHtmlResponse(`<html><head><title>Fallback Title</title></head></html>`);

    const result = await scrapeCoursePage("https://example.com/course");

    expect(result.title).toBe("Fallback Title");
  });

  it("decodes HTML entities (named and numeric) in the title", async () => {
    mockHtmlResponse(`<html><head>
      <meta property="og:title" content="Intro to AI &amp; ML &#x2014; Part &#39;1&#39;">
    </head></html>`);

    const result = await scrapeCoursePage("https://example.com/course");

    expect(result.title).toBe("Intro to AI & ML — Part '1'");
  });

  it("strips a trailing '| edX' site suffix only for edx.org URLs", async () => {
    mockHtmlResponse(`<html><head><meta property="og:title" content="Deep Learning | edX"></head></html>`);

    const result = await scrapeCoursePage("https://www.edx.org/course/deep-learning");

    expect(result.title).toBe("Deep Learning");
  });

  it("leaves a similarly-shaped suffix alone for a non-edX hostname", async () => {
    mockHtmlResponse(`<html><head><meta property="og:title" content="Deep Learning | Coursera"></head></html>`);

    const result = await scrapeCoursePage("https://www.coursera.org/learn/deep-learning");

    expect(result.title).toBe("Deep Learning | Coursera");
  });
});

describe("scrapeCoursePage — meta tag parsing robustness", () => {
  it("matches a meta tag with content before the property attribute", async () => {
    mockHtmlResponse(`<html><head><meta content="Reordered Title" property="og:title"></head></html>`);

    const result = await scrapeCoursePage("https://example.com/course");

    expect(result.title).toBe("Reordered Title");
  });

  it("does not cut a double-quoted content value short at an internal apostrophe", async () => {
    mockHtmlResponse(`<html><head><meta property="og:title" content="Everything you'll need to know"></head></html>`);

    const result = await scrapeCoursePage("https://example.com/course");

    expect(result.title).toBe("Everything you'll need to know");
  });

  it("supports single-quoted attribute values", async () => {
    mockHtmlResponse(`<html><head><meta property='og:title' content='Single Quoted Title'></head></html>`);

    const result = await scrapeCoursePage("https://example.com/course");

    expect(result.title).toBe("Single Quoted Title");
  });
});

describe("scrapeCoursePage — description, image, and external ids", () => {
  it("extracts og:description and og:image, and preserves the original URL verbatim in externalIds", async () => {
    mockHtmlResponse(`<html><head>
      <meta property="og:title" content="Full Course">
      <meta property="og:description" content="Learn &amp; grow.">
      <meta property="og:image" content="https://cdn.example.com/thumb.jpg">
    </head></html>`);
    const inputUrl = "https://example.com/course?ref=share&utm=x";

    const result = await scrapeCoursePage(inputUrl);

    expect(result.overview).toBe("Learn & grow.");
    expect(result.posterUrl).toBe("https://cdn.example.com/thumb.jpg");
    expect(result.externalIds).toEqual({ url: inputUrl });
  });

  it("returns null for overview/posterUrl when their meta tags are absent", async () => {
    mockHtmlResponse(`<html><head><meta property="og:title" content="Bare Course"></head></html>`);

    const result = await scrapeCoursePage("https://example.com/course");

    expect(result.overview).toBeNull();
    expect(result.posterUrl).toBeNull();
  });
});
