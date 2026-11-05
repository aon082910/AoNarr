import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

let exporter: typeof import("../src/services/metadataExport.js");
let parser: typeof import("../src/services/nfoParser.js");
let dir: string;

beforeAll(async () => {
  await setupTestDb();
  exporter = await import("../src/services/metadataExport.js");
  parser = await import("../src/services/nfoParser.js");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-musicnfo-"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const artist = {
  name: "Daft & Punk",
  overview: "French duo.",
  genres: ["Electronic", "House"],
  externalIds: { musicbrainz: "056e4f3e-d505-4dad-8ec1-d04f521cbb56", deezer: "27" },
  posterUrl: "https://img.example.com/artist.jpg",
};

const album = {
  title: "Discovery",
  artist: "Daft Punk",
  releaseDate: "2001-03-12",
  overview: "Second album.",
  genres: ["Electronic"],
  externalId: "2d8a8b6a-1111-4a6c-9c0c-aaaaaaaaaaaa",
  externalProvider: "musicbrainz",
  posterUrl: "/api/media/local-artwork/abc",
  tracks: [
    { position: 1, title: "One More Time", durationSeconds: 320 },
    { position: 2, title: "Aerodynamic", durationSeconds: null },
  ],
};

describe("artist.nfo and album.nfo", () => {
  it("writes the Kodi artist shape with the MusicBrainz id, genres and biography", () => {
    const xml = exporter.buildArtistNfo(artist);

    expect(xml).toContain("<artist>");
    expect(xml).toContain("<name>Daft &amp; Punk</name>");
    expect(xml).toContain("<musicBrainzArtistID>056e4f3e-d505-4dad-8ec1-d04f521cbb56</musicBrainzArtistID>");
    expect(xml).toContain("<genre>Electronic</genre>");
    expect(xml).toContain("<genre>House</genre>");
    expect(xml).toContain("<biography>French duo.</biography>");
    expect(xml).toContain('<uniqueid type="deezer">27</uniqueid>');
    expect(xml).not.toContain('<uniqueid type="musicbrainz">');
  });

  it("writes the album with year, release date, review, the track list and no AoNarr-internal poster path", () => {
    const xml = exporter.buildAlbumNfo(album);

    expect(xml).toContain("<album>");
    expect(xml).toContain("<title>Discovery</title>");
    expect(xml).toContain("<artist>Daft Punk</artist>");
    expect(xml).toContain("<musicBrainzReleaseGroupID>2d8a8b6a-1111-4a6c-9c0c-aaaaaaaaaaaa</musicBrainzReleaseGroupID>");
    expect(xml).toContain("<year>2001</year>");
    expect(xml).toContain("<releasedate>2001-03-12</releasedate>");
    expect(xml).toContain("<review>Second album.</review>");
    expect(xml).toContain("<position>1</position>");
    expect(xml).toContain("<duration>5:20</duration>");
    expect(xml.match(/<track>/g)).toHaveLength(2);
    expect(xml).not.toContain("local-artwork");
  });

  it("gives another provider's album id as a unique id instead", () => {
    const xml = exporter.buildAlbumNfo({ ...album, externalProvider: "deezer", externalId: "302127" });
    expect(xml).toContain('<uniqueid type="deezer">302127</uniqueid>');
    expect(xml).not.toContain("musicBrainzReleaseGroupID");
  });

  it("is read back by the NFO parser the scan uses, name and review included", async () => {
    const artistParsed = await parser.parseNfo(exporter.buildArtistNfo(artist));
    expect(artistParsed.title).toBe("Daft & Punk");
    expect(artistParsed.overview).toBe("French duo.");
    expect(artistParsed.genres).toEqual(["Electronic", "House"]);
    expect(artistParsed.posterUrl).toBe("https://img.example.com/artist.jpg");

    const albumParsed = await parser.parseNfo(exporter.buildAlbumNfo(album));
    expect(albumParsed.title).toBe("Discovery");
    expect(albumParsed.year).toBe(2001);
    expect(albumParsed.overview).toBe("Second album.");
  });

  it("calls its own artist and album files AoNarr-shaped, and another tool's richer ones not", () => {
    expect(exporter.isAonarrShapedNfo(exporter.buildArtistNfo(artist))).toBe(true);
    expect(exporter.isAonarrShapedNfo(exporter.buildAlbumNfo(album))).toBe(true);
    expect(exporter.isAonarrShapedNfo(`<album><title>X</title><albumArtistCredits><artist>Y</artist></albumArtistCredits></album>`)).toBe(false);
    expect(exporter.isAonarrShapedNfo(`<artist><name>X</name><born>1970</born></artist>`)).toBe(false);
    // <genre> is ours in a music file only: in a movie it is another tool's.
    expect(exporter.isAonarrShapedNfo(`<movie><title>X</title><genre>Crime</genre></movie>`)).toBe(false);
  });
});

describe("writeMusicNfo", () => {
  it("writes where there is none, keeps what is there, and refreshes only its own with overwrite", () => {
    const folder = fs.mkdtempSync(path.join(dir, "a-"));
    const xml = exporter.buildArtistNfo(artist);

    expect(exporter.writeMusicNfo(folder, "artist", xml)).toBe("written");
    expect(fs.readFileSync(path.join(folder, "artist.nfo"), "utf-8")).toBe(xml);
    expect(fs.readdirSync(folder)).toEqual(["artist.nfo"]); // no temporary file left

    const changed = exporter.buildArtistNfo({ ...artist, overview: "Changed." });
    expect(exporter.writeMusicNfo(folder, "artist", changed)).toBe("exists");
    expect(fs.readFileSync(path.join(folder, "artist.nfo"), "utf-8")).toBe(xml);

    expect(exporter.writeMusicNfo(folder, "artist", changed, { overwrite: true })).toBe("written");
    expect(fs.readFileSync(path.join(folder, "artist.nfo"), "utf-8")).toContain("Changed.");
  });

  it("never replaces an NFO from another tool, not even with overwrite", () => {
    const folder = fs.mkdtempSync(path.join(dir, "b-"));
    const theirs = `<album><title>Discovery</title><albumArtistCredits><artist>Daft Punk</artist></albumArtistCredits></album>`;
    fs.writeFileSync(path.join(folder, "album.nfo"), theirs);

    expect(exporter.writeMusicNfo(folder, "album", exporter.buildAlbumNfo(album), { overwrite: true })).toBe("richer");
    expect(fs.readFileSync(path.join(folder, "album.nfo"), "utf-8")).toBe(theirs);
  });

  it("reports a folder it cannot write into as failed, without throwing", () => {
    expect(exporter.writeMusicNfo(path.join(dir, "no", "such", "folder"), "album", exporter.buildAlbumNfo(album))).toBe("failed");
  });
});

describe("the video NFO writers report what they did and can fill gaps only", () => {
  const item = { type: "movie", title: "Film", year: 2020, overview: "A film.", posterUrl: null, externalIds: { tmdb: "1" } };

  it("writeNfoSidecar: written, then exists when asked for gaps only, richer when another tool's", () => {
    const folder = fs.mkdtempSync(path.join(dir, "m-"));
    const file = path.join(folder, "Film (2020).mkv");

    expect(exporter.writeNfoSidecar(file, item, { onlyIfMissing: true })).toBe("written");
    expect(exporter.writeNfoSidecar(file, { ...item, overview: "Changed." }, { onlyIfMissing: true })).toBe("exists");
    expect(fs.readFileSync(path.join(folder, "Film (2020).nfo"), "utf-8")).toContain("A film.");

    expect(exporter.writeNfoSidecar(file, { ...item, overview: "Changed." }, { keepRicher: true })).toBe("written");
    fs.writeFileSync(path.join(folder, "Film (2020).nfo"), `<movie><title>Film</title><actor><name>X</name></actor></movie>`);
    expect(exporter.writeNfoSidecar(file, item, { keepRicher: true })).toBe("richer");
    expect(fs.readdirSync(folder).filter((n) => n.startsWith(".aonarr-tmp-"))).toEqual([]);
  });

  it("writeEpisodeNfoSidecar and writeTvShowNfoIfMissing: gaps only, and a show NFO refreshed only with overwrite", () => {
    const folder = fs.mkdtempSync(path.join(dir, "s-"));
    const file = path.join(folder, "Show - S01E01.mkv");
    const episode = { showTitle: "Show", title: "One", season: 1, episode: 1, aired: null, overview: null };

    expect(exporter.writeEpisodeNfoSidecar(file, [episode], { onlyIfMissing: true })).toBe("written");
    expect(exporter.writeEpisodeNfoSidecar(file, [{ ...episode, title: "Changed" }], { onlyIfMissing: true })).toBe("exists");
    expect(exporter.writeEpisodeNfoSidecar(file, [{ ...episode, title: "Changed" }])).toBe("written");

    const show = { ...item, type: "series" };
    expect(exporter.writeTvShowNfoIfMissing(folder, show)).toBe("written");
    expect(exporter.writeTvShowNfoIfMissing(folder, { ...show, overview: "Changed." })).toBe("exists");
    expect(exporter.writeTvShowNfoIfMissing(folder, { ...show, overview: "Changed." }, { overwrite: true })).toBe("written");
    expect(fs.readFileSync(path.join(folder, "tvshow.nfo"), "utf-8")).toContain("Changed.");

    fs.writeFileSync(path.join(folder, "tvshow.nfo"), `<tvshow><title>Show</title><actor><name>X</name></actor></tvshow>`);
    expect(exporter.writeTvShowNfoIfMissing(folder, show, { overwrite: true })).toBe("richer");
  });
});
