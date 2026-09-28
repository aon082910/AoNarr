import { describe, it, expect } from "vitest";
import { renderTemplate, providerIdVars, DEFAULT_SHAPE_TEMPLATES, DEFAULT_TRACK_TEMPLATE } from "../src/services/naming.js";

describe("renderTemplate", () => {
  it("substitutes plain tokens", () => {
    expect(renderTemplate("{title} ({year})", { title: "Movie", year: 2023 })).toBe("Movie (2023)");
  });

  it("zero-pads a numeric token when given a {token:00}-style placeholder", () => {
    expect(renderTemplate("S{season:00}E{episode:00}", { season: 2, episode: 5 })).toBe("S02E05");
    expect(renderTemplate("S{season:00}E{episode:00}", { season: 12, episode: 123 })).toBe("S12E123");
  });

  it("does not pad a non-numeric value even with a padded placeholder", () => {
    expect(renderTemplate("{episodeTitle:00}", { episodeTitle: "Pilot" })).toBe("Pilot");
  });

  it("renders an unknown token as an empty string rather than leaving the placeholder literal", () => {
    expect(renderTemplate("{title} - {missing}", { title: "Movie" })).toBe("Movie - ");
  });

  it("renders a token whose value is 0 (falsy but not undefined/null)", () => {
    expect(renderTemplate("Track {trackNumber:00}", { trackNumber: 0 })).toBe("Track 00");
  });

  it("leaves a null/undefined token blank without throwing", () => {
    expect(renderTemplate("{a}{b}", { a: null as unknown as string, b: undefined as unknown as string })).toBe("");
  });

  it("renders every default shape template with representative values", () => {
    expect(
      renderTemplate(DEFAULT_SHAPE_TEMPLATES.single, { title: "Movie", year: 2023 })
    ).toBe("Movie (2023)/Movie (2023)");

    expect(
      renderTemplate(DEFAULT_SHAPE_TEMPLATES.episodic, {
        parentTitle: "Show",
        season: 2,
        episode: 5,
        episodeTitle: "The One",
      })
    ).toBe("Show/Season 02/Show - S02E05 - The One");

    expect(
      renderTemplate(DEFAULT_SHAPE_TEMPLATES.collection, { parentTitle: "Artist", childTitle: "Album" })
    ).toBe("Artist/Album");
  });

  it("renders the default track template", () => {
    expect(renderTemplate(DEFAULT_TRACK_TEMPLATE, { trackNumber: 4, trackTitle: "Song Name" })).toBe(
      "04 - Song Name"
    );
  });
});

describe("providerIdVars", () => {
  it("exposes one {<provider>Id} token per id actually present", () => {
    const vars = providerIdVars({ type: "series", externalIds: JSON.stringify({ tmdb: "246", tvdb: "76185", imdb: "tt0417299" }) });
    expect(vars.tmdbId).toBe("246");
    expect(vars.tvdbId).toBe("76185");
    expect(vars.imdbId).toBe("tt0417299");
  });

  it("prefers the type's defaultProvider for the generic providerId/providerKey pair", () => {
    // series' defaultProvider is tmdb — even though tvdb is listed first in the JSON.
    const vars = providerIdVars({ type: "series", externalIds: JSON.stringify({ tvdb: "76185", tmdb: "246" }) });
    expect(vars.providerId).toBe("246");
    expect(vars.providerKey).toBe("tmdb");
  });

  it("falls back through metadataProviders order when defaultProvider's id is missing", () => {
    // series: defaultProvider tmdb, metadataProviders ["tmdb", "tvdb", "tvmaze", "trakt"] — no tmdb here.
    const vars = providerIdVars({ type: "series", externalIds: JSON.stringify({ tvdb: "76185" }) });
    expect(vars.providerId).toBe("76185");
    expect(vars.providerKey).toBe("tvdb");
  });

  it("falls back to any populated id when none of the type's known providers are present", () => {
    const vars = providerIdVars({ type: "series", externalIds: JSON.stringify({ trakt: "999" }) });
    expect(vars.providerId).toBe("999");
    expect(vars.providerKey).toBe("trakt");
  });

  it("renders no tokens at all when externalIds is empty, null, or unparsable", () => {
    expect(providerIdVars({ type: "movie", externalIds: null })).toEqual({});
    expect(providerIdVars({ type: "movie", externalIds: "{}" })).toEqual({});
    expect(providerIdVars({ type: "movie", externalIds: "not json" })).toEqual({});
  });

  it("plugs straight into renderTemplate for a real naming template", () => {
    const vars = { title: "Example Movie", year: 2023, ...providerIdVars({ type: "movie", externalIds: JSON.stringify({ tmdb: "12345", imdb: "tt1234567" }) }) };
    expect(renderTemplate("{title} ({year}) [tmdb-{tmdbId}] [imdbid-{imdbId}]", vars)).toBe("Example Movie (2023) [tmdb-12345] [imdbid-tt1234567]");
    expect(renderTemplate("{title} [{providerKey}-{providerId}]", vars)).toBe("Example Movie [tmdb-12345]");
  });
});
