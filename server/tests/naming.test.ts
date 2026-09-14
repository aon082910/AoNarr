import { describe, it, expect } from "vitest";
import { renderTemplate, DEFAULT_SHAPE_TEMPLATES, DEFAULT_TRACK_TEMPLATE } from "../src/services/naming.js";

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
