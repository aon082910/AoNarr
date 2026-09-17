import { describe, it, expect } from "vitest";
import { parseNfo } from "../src/services/nfoParser.js";

describe("parseNfo", () => {
  it("parses a Kodi-style movie.nfo", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Dune</title>
  <year>2021</year>
  <plot>A noble family becomes embroiled in a war for control of a desert planet.</plot>
  <thumb aspect="poster">https://example.com/poster.jpg</thumb>
  <uniqueid type="tmdb">438631</uniqueid>
  <uniqueid type="imdb">tt1160419</uniqueid>
</movie>`;
    const result = await parseNfo(xml);
    expect(result.title).toBe("Dune");
    expect(result.year).toBe(2021);
    expect(result.overview).toContain("desert planet");
    expect(result.posterUrl).toBe("https://example.com/poster.jpg");
    expect(result.externalIds).toEqual({ tmdb: "438631", imdb: "tt1160419" });
  });

  it("falls back to <outline> when <plot> is absent, and derives year from <premiered>", async () => {
    const xml = `<movie><title>X</title><premiered>2019-05-01</premiered><outline>Short summary</outline></movie>`;
    const result = await parseNfo(xml);
    expect(result.year).toBe(2019);
    expect(result.overview).toBe("Short summary");
  });

  it("picks the poster-tagged thumb over other thumbs (e.g. fanart/banner) when more than one is present", async () => {
    const xml = `<movie>
  <title>X</title>
  <thumb aspect="fanart">https://example.com/fanart.jpg</thumb>
  <thumb aspect="poster">https://example.com/poster.jpg</thumb>
</movie>`;
    const result = await parseNfo(xml);
    expect(result.posterUrl).toBe("https://example.com/poster.jpg");
  });

  it("falls back to imdbid when there's no matching <uniqueid type=\"imdb\"> entry", async () => {
    const xml = `<movie><title>X</title><imdbid>tt0000001</imdbid></movie>`;
    const result = await parseNfo(xml);
    expect(result.externalIds.imdb).toBe("tt0000001");
  });

  it("recognizes tvshow.nfo and episodedetails.nfo root elements, not just movie.nfo", async () => {
    const show = await parseNfo(`<tvshow><title>A Show</title></tvshow>`);
    expect(show.title).toBe("A Show");
    const episode = await parseNfo(`<episodedetails><title>Pilot</title></episodedetails>`);
    expect(episode.title).toBe("Pilot");
  });

  it("returns an empty/null result for a root element it doesn't recognize, instead of throwing", async () => {
    const result = await parseNfo(`<somethingelse><title>X</title></somethingelse>`);
    expect(result).toEqual({ title: null, year: null, overview: null, posterUrl: null, externalIds: {} });
  });

  it("returns nulls for missing optional fields rather than throwing", async () => {
    const result = await parseNfo(`<movie><title>Bare</title></movie>`);
    expect(result.title).toBe("Bare");
    expect(result.year).toBeNull();
    expect(result.overview).toBeNull();
    expect(result.posterUrl).toBeNull();
    expect(result.externalIds).toEqual({});
  });
});
