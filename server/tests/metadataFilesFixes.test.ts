import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30f review fixes for the NFO and artwork files: M8 (temporary names), Low 4 (XML-forbidden characters), Low 1 (special-use addresses).

let atomic: typeof import("../src/services/atomicWrite.js");
let exporter: typeof import("../src/services/metadataExport.js");
let parser: typeof import("../src/services/nfoParser.js");
let art: typeof import("../src/services/artworkFiles.js");
let dir: string;

beforeAll(async () => {
  await setupTestDb();
  atomic = await import("../src/services/atomicWrite.js");
  exporter = await import("../src/services/metadataExport.js");
  parser = await import("../src/services/nfoParser.js");
  art = await import("../src/services/artworkFiles.js");
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-fixes-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const listing = () => fs.readdirSync(dir).sort();

describe("M8: a temporary name is never longer than the name it stands in for was allowed to be", () => {
  // 240 bytes: the longest name of this kind that fits a 255-byte file name limit with room for the extension.
  const longAscii = `${"a".repeat(236)}.jpg`;
  // 80 CJK characters are 240 bytes in UTF-8, and the .nfo makes 244.
  const longCjk = `${"映画".repeat(40)}.nfo`;

  it("sanity: the names used below really are that long, and the direct write the code used to make accepts them", () => {
    expect(Buffer.byteLength(longAscii)).toBe(240);
    expect(Buffer.byteLength(longCjk)).toBe(244);
    fs.writeFileSync(path.join(dir, longAscii), "x");
    fs.writeFileSync(path.join(dir, longCjk), "x");
  });

  it("writeFileAtomicSync writes a 240-byte name and a CJK name of 80 characters, and leaves no temporary file", () => {
    atomic.writeFileAtomicSync(path.join(dir, longAscii), Buffer.from("picture"));
    atomic.writeFileAtomicSync(path.join(dir, longCjk), "<movie/>");

    expect(listing().sort()).toEqual([longAscii, longCjk].sort());
    expect(fs.readFileSync(path.join(dir, longAscii), "utf-8")).toBe("picture");
    expect(fs.readFileSync(path.join(dir, longCjk), "utf-8")).toBe("<movie/>");
  });

  it("writeFileAtomic (the picture writer) does the same", async () => {
    await atomic.writeFileAtomic(path.join(dir, longAscii), Buffer.from("picture"));

    expect(listing()).toEqual([longAscii]);
  });

  it("keeps the importer's temp prefix, so its sweep of leftovers still finds a temp a killed run left behind", () => {
    const seen: string[] = [];
    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
      seen.push(path.basename(String(file)));
      return real(file, data as string, options as fs.WriteFileOptions);
    }) as typeof fs.writeFileSync);
    try {
      atomic.writeFileAtomicSync(path.join(dir, "poster.jpg"), Buffer.from("p"));
    } finally {
      spy.mockRestore();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\.aonarr-tmp-[0-9a-f]{12}\.jpg$/);
  });

  it("an NFO next to a media file with an 80-character CJK name is written (the direct write of before did that)", () => {
    const file = path.join(dir, `${"映画".repeat(40)}.mkv`);
    fs.writeFileSync(file, "x");

    const result = exporter.writeNfoSidecar(file, { type: "movie", title: "T", year: 2000, overview: null, posterUrl: null, externalIds: {} });

    expect(result).toBe("written");
    expect(fs.existsSync(path.join(dir, `${"映画".repeat(40)}.nfo`))).toBe(true);
  });

  it("a picture whose name is 240 bytes is written, through the whole artwork path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(jpeg(), { status: 200, headers: { "content-type": "image/jpeg" } })));
    const stem = "e".repeat(230); // "<episode>-thumb" style: 230 + ".jpg" = 234, plus a few more below

    const result = await art.writeArtworkFile(dir, `${stem}-thumb`, { url: "https://img.example.com/p.jpg" }, { overwrite: false });

    expect(result.outcome).toBe("written");
    expect(listing()).toEqual([`${stem}-thumb.jpg`]);
  });
});

describe("Low 4: XML 1.0 cannot carry every character, so the NFO does not", () => {
  const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const dirty = "Lives\u000B in\u0001 Paris￾.\uD800 Then \uDC00 left\u0000. Fine: é \u{1F3B5} & <b>";

  it("strips the forbidden characters from a biography, a review, a plot and a title, and keeps the rest", async () => {
    const outputs = [
      exporter.buildArtistNfo({ name: dirty, overview: dirty, genres: [dirty], externalIds: { musicbrainz: dirty }, posterUrl: null }),
      exporter.buildAlbumNfo({ title: dirty, artist: dirty, releaseDate: "2001-03-12", overview: dirty, genres: [dirty], externalId: null, externalProvider: null, posterUrl: null, tracks: [{ position: 1, title: dirty, durationSeconds: 5 }] }),
      exporter.buildNfo({ type: "movie", title: dirty, year: 2000, overview: dirty, posterUrl: null, externalIds: { tmdb: dirty } }),
      exporter.buildEpisodeNfo([{ showTitle: dirty, title: dirty, season: 1, episode: 1, aired: null, overview: dirty }]),
    ];

    for (const xml of outputs) {
      expect(FORBIDDEN.test(xml)).toBe(false);
      expect(xml).toContain("Lives in Paris.");
      expect(xml).toContain("é \u{1F3B5} &amp; &lt;b&gt;"); // a character XML allows, an astral pair and the escapes all survive
    }
  });

  it("still reads back through the NFO parser the scan uses", async () => {
    const parsed = await parser.parseNfo(exporter.buildArtistNfo({ name: "Name", overview: "Bio\u000B text", genres: [], externalIds: {}, posterUrl: null }));

    expect(parsed.overview).toBe("Bio text");
  });

  it("keeps tab, line feed and carriage return, which XML allows", () => {
    const xml = exporter.buildNfo({ type: "movie", title: "T", year: null, overview: "line one\nline two\tTabbed\r\nthree", posterUrl: null, externalIds: {} });

    expect(xml).toContain("line one\nline two\tTabbed\r\nthree");
  });
});

describe("Low 1: addresses no picture is fetched from", () => {
  const refused = [
    "192.0.0.192", "192.0.0.1", "192.0.2.7", "198.18.0.1", "198.19.255.255", "198.51.100.9", "203.0.113.5", "240.0.0.1", "255.255.255.255", "100.64.0.1", "224.0.0.1",
    // already refused before, still are
    "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.5", "169.254.169.254", "0.0.0.0", "localhost", "nas", "printer.local",
    "[::1]", "[::]", "[fe80::1]", "[fd00::5]",
    "[64:ff9b::7f00:1]", "[64:ff9b::a00:1]", "[64:ff9b:1::1]", "[2002:7f00:1::]", "[2002:c0a8:101::1]", "[::ffff:7f00:1]", "[::ffff:c000:2]", "[::ffff:192.168.1.1]", "[2001:db8::1]", "[ff02::1]",
  ];
  const allowed = ["8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "img.example.com", "image.tmdb.org", "[2606:4700:4700::1111]", "[64:ff9b::808:808]", "[2002:808:808::]", "[::ffff:808:808]"];

  it.each(refused)("refuses %s", (host) => {
    expect(art.isNonPublicHost(host)).toBe(true);
  });

  it.each(allowed)("accepts %s", (host) => {
    expect(art.isNonPublicHost(host)).toBe(false);
  });

  it("refuses the URL without asking the network, for a first address and for a redirect hop", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/hop")) return new Response(null, { status: 302, headers: { location: "http://198.18.0.1/secret.jpg" } });
      return new Response(jpeg(), { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const url of ["http://192.0.0.192/p.jpg", "http://198.18.0.1/p.jpg", "http://[64:ff9b::7f00:1]/p.jpg", "http://[2002:7f00:1::]/p.jpg", "http://[::ffff:7f00:1]/p.jpg", "http://203.0.113.5/p.jpg"]) {
      const result = await art.writeArtworkFile(dir, `p-${listing().length}`, { url }, { overwrite: false });
      expect(result.outcome, url).toBe("failed");
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const hop = await art.writeArtworkFile(dir, "hopped", { url: "https://img.example.com/hop" }, { overwrite: false });
    expect(hop.outcome).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1); // the public first hop only
    expect(listing()).toEqual([]);

    const ok = await art.writeArtworkFile(dir, "fine", { url: "https://img.example.com/ok.jpg" }, { overwrite: false });
    expect(ok.outcome).toBe("written");
  });

  it("leaves isLocalAddress, which routes the proxy and decides the certificate rules, as it was", async () => {
    const { isLocalAddress } = await import("../src/services/networkAddress.js");

    expect(isLocalAddress("192.0.0.192")).toBe(false);
    expect(isLocalAddress("198.18.0.1")).toBe(false);
    expect(isLocalAddress("203.0.113.5")).toBe(false);
  });
});
