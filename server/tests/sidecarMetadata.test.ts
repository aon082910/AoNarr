import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  findShowSidecar,
  findEpisodeSidecar,
  findMovieSidecar,
  findMusicSidecars,
  findComicSidecar,
  findOpfSidecar,
  findFileSidecar,
} from "../src/services/sidecarMetadata.js";
import { getMediaTypeConfig } from "../src/services/mediaTypes.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-sidecar-"));
}

const TVSHOW_NFO = `<tvshow><title>Breaking Bad</title><uniqueid type="tmdb">1396</uniqueid></tvshow>`;
const EPISODE_NFO = `<episodedetails><title>Pilot</title><season>1</season><episode>1</episode></episodedetails>`;
const MOVIE_NFO = `<movie><title>Dune</title><year>2021</year></movie>`;

describe("findShowSidecar", () => {
  it("finds tvshow.nfo sitting directly in the file's own parent folder (flat layout)", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "tvshow.nfo"), TVSHOW_NFO);
    const result = await findShowSidecar(dir);
    expect(result?.title).toBe("Breaking Bad");
  });

  it("finds tvshow.nfo one level up when the file's parent is a Season NN folder", async () => {
    const showDir = tmpDir();
    const seasonDir = path.join(showDir, "Season 01");
    fs.mkdirSync(seasonDir);
    fs.writeFileSync(path.join(showDir, "tvshow.nfo"), TVSHOW_NFO);
    const result = await findShowSidecar(seasonDir);
    expect(result?.title).toBe("Breaking Bad");
  });

  it("also recognizes a compact 'S01' season folder name", async () => {
    const showDir = tmpDir();
    const seasonDir = path.join(showDir, "S01");
    fs.mkdirSync(seasonDir);
    fs.writeFileSync(path.join(showDir, "tvshow.nfo"), TVSHOW_NFO);
    const result = await findShowSidecar(seasonDir);
    expect(result?.title).toBe("Breaking Bad");
  });

  it("treats a 'Specials' folder as a season folder, finding the show's tvshow.nfo one level up", async () => {
    const showDir = tmpDir();
    const specialsDir = path.join(showDir, "Specials");
    fs.mkdirSync(specialsDir);
    fs.writeFileSync(path.join(showDir, "tvshow.nfo"), TVSHOW_NFO);
    const result = await findShowSidecar(specialsDir);
    expect(result?.title).toBe("Breaking Bad");
  });

  it("returns null when no tvshow.nfo exists at either level", async () => {
    const dir = tmpDir();
    expect(await findShowSidecar(dir)).toBeNull();
  });
});

describe("findEpisodeSidecar", () => {
  it("finds a same-basename .nfo next to the episode file", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "Breaking.Bad.S01E01.mkv");
    fs.writeFileSync(filePath, "fake video");
    fs.writeFileSync(path.join(dir, "Breaking.Bad.S01E01.nfo"), EPISODE_NFO);
    const result = await findEpisodeSidecar(filePath);
    expect(result?.title).toBe("Pilot");
    expect(result?.season).toBe(1);
    expect(result?.episode).toBe(1);
  });

  it("returns null when there's no matching .nfo", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "no-nfo.mkv");
    expect(await findEpisodeSidecar(filePath)).toBeNull();
  });
});

describe("findMovieSidecar", () => {
  it("prefers a same-basename .nfo over a bare movie.nfo", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "Dune (2021).mkv");
    fs.writeFileSync(filePath, "fake video");
    fs.writeFileSync(path.join(dir, "Dune (2021).nfo"), MOVIE_NFO);
    fs.writeFileSync(path.join(dir, "movie.nfo"), `<movie><title>Wrong Title</title></movie>`);
    const result = await findMovieSidecar(filePath);
    expect(result?.title).toBe("Dune");
  });

  it("falls back to movie.nfo when there's no same-basename .nfo", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "Dune (2021).mkv");
    fs.writeFileSync(filePath, "fake video");
    fs.writeFileSync(path.join(dir, "movie.nfo"), MOVIE_NFO);
    const result = await findMovieSidecar(filePath);
    expect(result?.title).toBe("Dune");
  });
});

describe("findMusicSidecars", () => {
  it("reads artist.nfo and album.nfo independently, from different folders", async () => {
    const artistDir = tmpDir();
    const albumDir = path.join(artistDir, "OK Computer");
    fs.mkdirSync(albumDir);
    fs.writeFileSync(path.join(artistDir, "artist.nfo"), `<artist><name>Radiohead</name></artist>`);
    fs.writeFileSync(path.join(albumDir, "album.nfo"), `<album><title>OK Computer</title><year>1997</year></album>`);
    const result = await findMusicSidecars(artistDir, albumDir);
    expect(result.artist?.title).toBe("Radiohead");
    expect(result.album?.title).toBe("OK Computer");
    expect(result.album?.year).toBe(1997);
  });

  it("returns null for whichever side has no sidecar, without failing the other", async () => {
    const artistDir = tmpDir();
    const albumDir = path.join(artistDir, "Some Album");
    fs.mkdirSync(albumDir);
    fs.writeFileSync(path.join(artistDir, "artist.nfo"), `<artist><name>Radiohead</name></artist>`);
    const result = await findMusicSidecars(artistDir, albumDir);
    expect(result.artist?.title).toBe("Radiohead");
    expect(result.album).toBeNull();
  });
});

describe("findComicSidecar", () => {
  it("finds ComicInfo.xml embedded in a .cbz, mapping Series to parentTitle", async () => {
    const dir = tmpDir();
    const zip = new AdmZip();
    zip.addFile(
      "ComicInfo.xml",
      Buffer.from(`<ComicInfo><Series>Spider-Man</Series><Title>Issue One</Title><Number>1</Number></ComicInfo>`, "utf-8")
    );
    const filePath = path.join(dir, "issue1.cbz");
    zip.writeZip(filePath);
    const result = await findComicSidecar(filePath);
    expect(result?.parentTitle).toBe("Spider-Man");
    expect(result?.title).toBe("Issue One");
  });

  it("falls back to an external ComicInfo.xml next to the file when nothing is embedded", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "issue1.cbr");
    fs.writeFileSync(filePath, "not a real archive");
    fs.writeFileSync(path.join(dir, "ComicInfo.xml"), `<ComicInfo><Series>Spider-Man</Series><Title>Issue One</Title></ComicInfo>`);
    const result = await findComicSidecar(filePath);
    expect(result?.parentTitle).toBe("Spider-Man");
  });

  it("returns null when neither the archive nor the folder has ComicInfo.xml", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "issue1.cbz");
    new AdmZip().writeZip(filePath);
    expect(await findComicSidecar(filePath)).toBeNull();
  });
});

describe("findOpfSidecar", () => {
  it("finds metadata.opf sitting in the same folder as the book file", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "book.epub");
    fs.writeFileSync(filePath, "fake epub");
    fs.writeFileSync(
      path.join(dir, "metadata.opf"),
      `<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Hobbit</dc:title><dc:creator>J.R.R. Tolkien</dc:creator></metadata></package>`
    );
    const result = await findOpfSidecar(filePath);
    expect(result?.title).toBe("The Hobbit");
    expect(result?.parentTitle).toBe("J.R.R. Tolkien");
  });

  it("returns null when there's no metadata.opf", async () => {
    const dir = tmpDir();
    expect(await findOpfSidecar(path.join(dir, "book.epub"))).toBeNull();
  });
});

describe("findFileSidecar", () => {
  it("dispatches to the right lookup per type's configured sidecarFormat", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "Dune (2021).mkv");
    fs.writeFileSync(filePath, "fake video");
    fs.writeFileSync(path.join(dir, "movie.nfo"), MOVIE_NFO);
    const result = await findFileSidecar(getMediaTypeConfig("movie"), filePath);
    expect(result?.title).toBe("Dune");
  });

  it("returns null outright for a type with no sidecarFormat configured (ROMs)", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "game.zip");
    fs.writeFileSync(filePath, "fake rom");
    const result = await findFileSidecar(getMediaTypeConfig("rom"), filePath);
    expect(result).toBeNull();
  });
});
