import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";

// An NZB can arrive gzip-compressed or as UTF-16/UTF-8 with a byte order mark. validateNzb hands on plain UTF-8 XML, and
// every adapter that takes an NZB (SABnzbd, NZBGet, Blackhole) sends that, not the bytes the indexer gave.
let dc: typeof import("../src/services/downloadClient.js");

beforeAll(async () => {
  await setupTestDb();
  dc = await import("../src/services/downloadClient.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Names, quotes, an en dash, CJK and an emoji (a surrogate pair in UTF-16) so that a wrong decoding shows. */
const NZB_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">\n' +
  '<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">\n' +
  '<file poster="Pöster &lt;p@x&gt;" date="1" subject="Süd – 映画 😀 &quot;file&quot; (1/1)">\n' +
  "<groups><group>alt.binaries.test</group></groups>\n" +
  '<segments><segment bytes="1" number="1">id@x</segment></segments>\n' +
  "</file>\n</nzb>\n";
const NZB_ERROR_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<error code="100" description="Invalid API Key"/>\n';

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_LE = Buffer.from([0xff, 0xfe]);
const BOM_BE = Buffer.from([0xfe, 0xff]);

const utf8 = (text: string) => Buffer.from(text, "utf-8");
const utf8Bom = (text: string) => Buffer.concat([BOM_UTF8, utf8(text)]);
const utf16le = (text: string) => Buffer.concat([BOM_LE, Buffer.from(text, "utf16le")]);
const utf16be = (text: string) => {
  const body = Buffer.from(text, "utf16le");
  body.swap16();
  return Buffer.concat([BOM_BE, body]);
};
const gzip = (bytes: Buffer) => zlib.gzipSync(bytes);

/** How an NZB can reach AoNarr, each with the same document in it. */
const ENCODINGS: [string, (text: string) => Buffer][] = [
  ["gzip-compressed UTF-8", (text) => gzip(utf8(text))],
  ["UTF-16LE with a byte order mark", utf16le],
  ["UTF-16BE with a byte order mark", utf16be],
  ["UTF-8 with a byte order mark", utf8Bom],
  ["gzip-compressed UTF-16LE with a byte order mark", (text) => gzip(utf16le(text))],
];

describe("normalizeNzb / validateNzb — the NZB comes back as plain UTF-8 XML", () => {
  it.each(ENCODINGS)("accepts %s and returns the plain text", (_label, encode) => {
    const out = dc.validateNzb(encode(NZB_XML));

    expect(out.toString("utf-8")).toBe(NZB_XML);
    expect(out.equals(utf8(NZB_XML))).toBe(true);
    // No byte order mark is left to hide the opening "<".
    expect(out[0]).toBe("<".charCodeAt(0));
  });

  it("returns an ordinary NZB unchanged", () => {
    const plain = utf8(NZB_XML);

    const out = dc.validateNzb(plain);

    expect(out.equals(plain)).toBe(true);
    expect(out).toBe(plain);
    expect(dc.normalizeNzb(plain)).toBe(plain);
  });

  it("accepts a large gzip-compressed NZB that is well under the limit", () => {
    const filler = '<file poster="p" date="1" subject="s"><segments><segment bytes="1" number="1">id@x</segment></segments></file>\n'.repeat(50_000);
    const big = `<?xml version="1.0"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">\n${filler}</nzb>\n`;
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);

    const out = dc.validateNzb(gzip(utf8(big)));

    expect(out.length).toBe(Buffer.byteLength(big));
    expect(out.toString("utf-8")).toBe(big);
  });

  it("does not decode a document that has no byte order mark as UTF-16", () => {
    // Plain UTF-8 that merely contains the characters; nothing may be mangled.
    const out = dc.normalizeNzb(utf8(NZB_XML));
    expect(out.toString("utf-8")).toContain("Süd – 映画 😀");
  });

  describe.each(ENCODINGS)("an indexer error document sent as %s", (_label, encode) => {
    it("is still reported as the indexer's error, naming its code and description", () => {
      expect(() => dc.validateNzb(encode(NZB_ERROR_XML))).toThrow(/^Failed to fetch release: the indexer answered the NZB download with an error 100: Invalid API Key$/);
    });

    it("refuses an HTML page and an NZB that lists no files, as a release failure", () => {
      expect(() => dc.validateNzb(encode("<html><body>Please log in</body></html>"))).toThrow(/^Failed to fetch release: the indexer's answer to the NZB download is not an NZB file$/);
      expect(() => dc.validateNzb(encode('<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"></nzb>'))).toThrow(/^Failed to fetch release: the NZB the indexer returned lists no files$/);
    });
  });

  describe("a gzip file that cannot be read", () => {
    it("throws a release failure for a damaged body", () => {
      const damaged = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0xff]), Buffer.from("this is not deflate data at all")]);

      expect(() => dc.validateNzb(damaged)).toThrow(/^Failed to fetch release: .*gzip/);
      expect(() => dc.normalizeNzb(damaged)).toThrow(/^Failed to fetch release: .*gzip/);
    });

    it("throws a release failure for a truncated body", () => {
      const whole = gzip(utf8(NZB_XML));
      const truncated = whole.subarray(0, Math.floor(whole.length / 2));

      expect(() => dc.validateNzb(truncated)).toThrow(/^Failed to fetch release: .*gzip/);
    });

    it("throws a release failure, and does not inflate it all, for a gzip bomb over 128 MiB", () => {
      const limit = 128 * 1024 * 1024;
      const bomb = zlib.gzipSync(Buffer.alloc(limit + 1024 * 1024, 0x61), { level: 9 });
      // The fixture really is small on the wire, which is what makes it a bomb.
      expect(bomb.length).toBeLessThan(1024 * 1024);

      // Without the limit this would inflate fine and fail later as "not an NZB file"; the gzip message shows the limit stopped it.
      expect(() => dc.validateNzb(bomb)).toThrow(/^Failed to fetch release: .*gzip/);
    });
  });
});

/** An NZB document whose XML prolog is `prolog` (UTF-16 files usually say so in it). */
const nzbWithProlog = (prolog: string) => NZB_XML.replace(/^<\?xml[^>]*\?>/, prolog);
const UTF16_ENCODERS: [string, (text: string) => Buffer][] = [
  ["UTF-16LE", utf16le],
  ["UTF-16BE", utf16be],
  ["gzip-compressed UTF-16LE", (text) => gzip(utf16le(text))],
];

describe("normalizeNzb — a UTF-16 prolog is rewritten to utf-8 after the conversion", () => {
  it.each(UTF16_ENCODERS)("%s: encoding=\"UTF-16\" becomes encoding=\"utf-8\" and nothing else changes", (_label, encode) => {
    const prolog = '<?xml version="1.0" encoding="UTF-16"?>';

    const out = dc.validateNzb(encode(nzbWithProlog(prolog))).toString("utf-8");

    expect(out.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE nzb')).toBe(true);
    expect(out).toBe(nzbWithProlog('<?xml version="1.0" encoding="utf-8"?>'));
    expect(out).not.toMatch(/utf-16/i);
  });

  it.each([
    ['encoding="UTF-16"', 'encoding="utf-8"'],
    ['encoding="utf-16"', 'encoding="utf-8"'],
    ['encoding="utf-16le"', 'encoding="utf-8"'],
    ['encoding="UTF-16LE"', 'encoding="utf-8"'],
    ['encoding="UTF-16BE"', 'encoding="utf-8"'],
    ['encoding="utf16"', 'encoding="utf-8"'],
    ["encoding='UTF-16'", "encoding='utf-8'"],
    ["encoding='utf-16be'", "encoding='utf-8'"],
    ['encoding = "UTF-16"', 'encoding = "utf-8"'],
  ])("rewrites %s in a UTF-16LE and a UTF-16BE file alike", (declared, rewritten) => {
    for (const encode of [utf16le, utf16be]) {
      const out = dc.normalizeNzb(encode(nzbWithProlog(`<?xml version="1.0" ${declared} standalone="yes"?>`))).toString("utf-8");

      expect(out.split("\n")[0]).toBe(`<?xml version="1.0" ${rewritten} standalone="yes"?>`);
    }
  });

  it("leaves a prolog without an encoding alone", () => {
    for (const encode of [utf16le, utf16be]) {
      const out = dc.normalizeNzb(encode(nzbWithProlog('<?xml version="1.0"?>'))).toString("utf-8");

      expect(out).toBe(nzbWithProlog('<?xml version="1.0"?>'));
    }
  });

  it.each(['encoding="UTF-8"', 'encoding="ISO-8859-1"', 'encoding="windows-1252"', "encoding='us-ascii'"])("leaves %s alone", (declared) => {
    for (const encode of [utf16le, utf16be]) {
      const text = nzbWithProlog(`<?xml version="1.0" ${declared}?>`);

      expect(dc.normalizeNzb(encode(text)).toString("utf-8")).toBe(text);
    }
  });

  it("rewrites the prolog only, not the same words further down in the document", () => {
    const text = nzbWithProlog('<?xml version="1.0" encoding="UTF-16"?>').replace('subject="', 'subject="saved as encoding=\'UTF-16\' ');

    const out = dc.normalizeNzb(utf16le(text)).toString("utf-8");

    expect(out.split("\n")[0]).toBe('<?xml version="1.0" encoding="utf-8"?>');
    expect(out).toContain("saved as encoding='UTF-16' ");
    expect(out.match(/utf-16/gi)).toHaveLength(1);
  });

  it("does not touch a plain UTF-8 NZB, whatever its prolog says", () => {
    const text = nzbWithProlog('<?xml version="1.0" encoding="UTF-16"?>');
    const plain = utf8(text);

    expect(dc.normalizeNzb(plain)).toBe(plain);
    expect(dc.normalizeNzb(utf8Bom(text)).toString("utf-8")).toBe(text);
    expect(dc.normalizeNzb(gzip(plain)).toString("utf-8")).toBe(text);
  });

  it("keeps the non-ASCII text of the document intact while it rewrites the prolog", () => {
    const out = dc.validateNzb(utf16be(nzbWithProlog('<?xml version="1.0" encoding="UTF-16"?>')));

    expect(out.toString("utf-8")).toContain("Süd – 映画 😀");
  });

  // Only the start of the document can hold the prolog: the pattern looks at the first 2048 characters (Round 30b, L3).
  describe("only the first 2048 characters are searched for the prolog", () => {
    const LATE_PROLOG = '<?xml version="1.0" encoding="UTF-16"?>';

    it.each([
      ["UTF-16LE", utf16le],
      ["UTF-16BE", utf16be],
    ])("%s: a prolog-looking text after the first 2048 characters is left as it is", (_label, encode) => {
      const text = nzbWithProlog('<?xml version="1.0"?>').replace("<groups>", `<groups><!-- ${"x".repeat(2100)} ${LATE_PROLOG} -->`);
      expect(text.indexOf(LATE_PROLOG)).toBeGreaterThan(2048);

      const out = dc.normalizeNzb(encode(text)).toString("utf-8");

      expect(out).toBe(text);
      expect(out).toContain(LATE_PROLOG);
    });

    it.each([
      ["UTF-16LE", utf16le],
      ["UTF-16BE", utf16be],
    ])("%s: a prolog that sits inside the first 2048 characters is still rewritten, and a later copy of it is not", (_label, encode) => {
      // Padding before the prolog keeps it well past the start, but still inside the window.
      const text = `${" ".repeat(1500)}${LATE_PROLOG}\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><!-- ${"y".repeat(1000)} ${LATE_PROLOG} --><file subject="s"/></nzb>`;
      expect(text.indexOf(LATE_PROLOG)).toBeLessThan(2048 - LATE_PROLOG.length);

      const out = dc.normalizeNzb(encode(text)).toString("utf-8");

      const rewritten = '<?xml version="1.0" encoding="utf-8"?>'; // one character shorter than the original
      expect(out.slice(1500, 1500 + rewritten.length)).toBe(rewritten);
      expect(out.match(/encoding="UTF-16"/g)).toHaveLength(1); // the copy in the comment
      expect(out.slice(1500 + rewritten.length)).toBe(text.slice(1500 + LATE_PROLOG.length));
    });

    it("keeps everything after the window byte for byte, non-ASCII text across the cut included", () => {
      const text = nzbWithProlog('<?xml version="1.0" encoding="UTF-16"?>').replace("<groups>", `<groups><!-- ${"é映😀".repeat(900)} -->`);
      expect(text.length).toBeGreaterThan(2048);

      const out = dc.normalizeNzb(utf16le(text)).toString("utf-8");

      expect(out).toBe(text.replace('encoding="UTF-16"', 'encoding="utf-8"'));
    });

    it("finishes at once on a big hostile document that is nothing but prolog beginnings", () => {
      // Without a window, each of the 800,000 "<?xml " starts would scan to the end of a 4.8-million-character document.
      const hostile = "<?xml ".repeat(800_000);
      const bytes = utf16le(hostile);

      const started = performance.now();
      const out = dc.normalizeNzb(bytes);
      const elapsedMs = performance.now() - started;

      expect(out.toString("utf-8")).toBe(hostile);
      expect(elapsedMs).toBeLessThan(3000);
    });
  });
});

describe("normalizeNzb — a UTF-16 file with a half character left over is damaged", () => {
  const fullLe = utf16le(NZB_XML);
  const fullBe = utf16be(NZB_XML);
  const ODD: [string, Buffer][] = [
    ["UTF-16LE", Buffer.concat([fullLe, Buffer.from([0x00])])],
    ["UTF-16BE", Buffer.concat([fullBe, Buffer.from([0x00])])],
    ["UTF-16LE cut in the middle of a character", fullLe.subarray(0, fullLe.length - 1)],
    ["UTF-16BE cut in the middle of a character", fullBe.subarray(0, fullBe.length - 1)],
    ["UTF-16LE with nothing but a byte after the byte order mark", Buffer.from([0xff, 0xfe, 0x3c])],
    ["UTF-16BE with nothing but a byte after the byte order mark", Buffer.from([0xfe, 0xff, 0x00])],
    ["gzip-compressed UTF-16LE", gzip(Buffer.concat([fullLe, Buffer.from([0x00])]))],
    ["gzip-compressed UTF-16BE", gzip(Buffer.concat([fullBe, Buffer.from([0x00])]))],
  ];

  it.each(ODD)("%s: a release failure naming a damaged UTF-16 file, not a RangeError", (_label, bytes) => {
    expect(() => dc.normalizeNzb(bytes)).toThrow(/^Failed to fetch release: .*damaged UTF-16 file$/);
    expect(() => dc.validateNzb(bytes)).toThrow(/^Failed to fetch release: .*damaged UTF-16 file$/);
    expect(() => dc.validateNzb(bytes)).not.toThrow(RangeError);
  });

  it("does not turn an even number of bytes after the byte order mark into an error", () => {
    expect(() => dc.validateNzb(fullLe)).not.toThrow();
    expect(() => dc.validateNzb(fullBe)).not.toThrow();
    // A byte order mark and nothing else is an empty document: refused as not an NZB, not as damaged.
    expect(() => dc.validateNzb(Buffer.from([0xff, 0xfe]))).toThrow(/^Failed to fetch release: .*not an NZB file$/);
    expect(() => dc.validateNzb(Buffer.from([0xfe, 0xff]))).toThrow(/^Failed to fetch release: .*not an NZB file$/);
  });
});

// ---------------------------------------------------------------------------
// What the adapters hand on
// ---------------------------------------------------------------------------

let nextClientId = 910_000;
function client(over: Partial<DownloadClient> = {}): DownloadClient {
  return {
    id: nextClientId++,
    name: "Test Client",
    type: "sabnzbd",
    host: "dl.local",
    port: 8080,
    useSsl: 0,
    username: null,
    password: null,
    apiKey: "key",
    category: null,
    enabled: 1,
    audioOnly: 0,
    downloadTypes: null,
    tagIds: [],
    priority: 1,
    urlBase: null,
    categoryByType: null,
    ...over,
  } as DownloadClient;
}

/** An indexer answering a download with `bytes`. */
const indexerAnswer = (bytes: Buffer) => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });

describe("SABnzbd uploads the decoded NZB", () => {
  it.each(ENCODINGS)("when the indexer sent %s", async (_label, encode) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(indexerAnswer(encode(NZB_XML))).mockResolvedValueOnce(json({ nzo_ids: ["SABnzbd_nzo_1"] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await dc.getDownloadClientAdapter("sabnzbd").addDownload(client(), "https://idx.example.com/getnzb?id=1", "tv", "Show.S01E01.1080p-GRP");

    expect(result.downloadId).toBe("SABnzbd_nzo_1");
    const form = (fetchMock.mock.calls[1][1] as RequestInit).body as FormData;
    const file = form.get("name") as File;
    expect(file.name).toBe("Show.S01E01.1080p-GRP.nzb");
    expect(Buffer.from(await file.arrayBuffer()).equals(utf8(NZB_XML))).toBe(true);
    expect(await file.text()).toBe(NZB_XML);
  });

  it("uploads an ordinary NZB as it came", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(indexerAnswer(utf8(NZB_XML))).mockResolvedValueOnce(json({ nzo_ids: ["SABnzbd_nzo_2"] }));
    vi.stubGlobal("fetch", fetchMock);

    await dc.getDownloadClientAdapter("sabnzbd").addDownload(client(), "https://idx.example.com/getnzb?id=2", null, "Plain");

    const file = ((fetchMock.mock.calls[1][1] as RequestInit).body as FormData).get("name") as File;
    expect(await file.text()).toBe(NZB_XML);
  });

  it.each(ENCODINGS)("refuses an indexer's error document sent as %s without calling SABnzbd", async (_label, encode) => {
    const fetchMock = vi.fn().mockResolvedValue(indexerAnswer(encode(NZB_ERROR_XML)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(dc.getDownloadClientAdapter("sabnzbd").addDownload(client(), "https://idx.example.com/getnzb?id=3", "tv", "Refused")).rejects.toThrow(
      /^Failed to fetch release: the indexer answered the NZB download with an error 100: Invalid API Key$/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("NZBGet appends the base64 of the decoded XML", () => {
  /** Answers the indexer download with `bytes` and NZBGet's JSON-RPC `append` with an id. */
  function nzbgetFetch(bytes: Buffer) {
    const appended: any[][] = [];
    const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
      let body: any = null;
      try {
        body = init.body ? JSON.parse(String(init.body)) : null;
      } catch {
        // not an RPC call
      }
      if (body?.method === "append") {
        appended.push(body.params);
        return json({ result: 42 });
      }
      return indexerAnswer(bytes);
    });
    return { fn, appended };
  }
  const nzbget = () => client({ type: "nzbget", host: "nz.local", port: 6789, username: "nzbget", password: "tegbzn6789", apiKey: null });

  it.each(ENCODINGS)("when the indexer sent %s", async (_label, encode) => {
    const { fn, appended } = nzbgetFetch(encode(NZB_XML));
    vi.stubGlobal("fetch", fn);

    const result = await dc.getDownloadClientAdapter("nzbget").addDownload(nzbget(), "https://idx.example.com/getnzb?id=4", "tv", "Show.S01E02.1080p-GRP");

    expect(result.downloadId).toBe("42");
    expect(appended).toHaveLength(1);
    expect(appended[0][0]).toBe("Show.S01E02.1080p-GRP.nzb");
    // The second argument of append() is the NZB content, base64 of the plain UTF-8 XML.
    expect(appended[0][1]).toBe(utf8(NZB_XML).toString("base64"));
    expect(Buffer.from(appended[0][1], "base64").toString("utf-8")).toBe(NZB_XML);
  });

  it("refuses an error document from the indexer before NZBGet is called", async () => {
    const { fn, appended } = nzbgetFetch(gzip(utf8(NZB_ERROR_XML)));
    vi.stubGlobal("fetch", fn);

    await expect(dc.getDownloadClientAdapter("nzbget").addDownload(nzbget(), "https://idx.example.com/getnzb?id=5", "tv", "Refused")).rejects.toThrow(/^Failed to fetch release: .*Invalid API Key/);
    expect(appended).toHaveLength(0);
  });
});

describe("Blackhole writes the decoded NZB, and a torrent as the raw bytes", () => {
  let watch: string;

  beforeEach(() => {
    watch = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-nzb-watch-"));
  });
  afterEach(() => {
    fs.rmSync(watch, { recursive: true, force: true });
  });

  const adapter = () => dc.getDownloadClientAdapter("blackhole");
  const blackhole = () => client({ type: "blackhole", host: watch, apiKey: null });

  it.each(ENCODINGS)("writes <title>.nzb with plain XML when the indexer sent %s", async (_label, encode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(indexerAnswer(encode(NZB_XML))));

    const { downloadId } = await adapter().addDownload(blackhole(), "https://idx.example.com/getnzb?id=6", null, "Some Show S01E03");

    expect(downloadId).toMatch(/\|Some Show S01E03$/);
    expect(fs.readdirSync(watch)).toEqual(["Some Show S01E03.nzb"]);
    const written = fs.readFileSync(path.join(watch, "Some Show S01E03.nzb"));
    expect(written.equals(utf8(NZB_XML))).toBe(true);
    expect(written.toString("utf-8")).toBe(NZB_XML);
  });

  it("writes an ordinary NZB as it came", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(indexerAnswer(utf8(NZB_XML))));

    await adapter().addDownload(blackhole(), "https://idx.example.com/getnzb?id=7", null, "Plain Release");

    expect(fs.readFileSync(path.join(watch, "Plain Release.nzb"), "utf-8")).toBe(NZB_XML);
  });

  it("writes <title>.torrent with the raw bytes for a bencoded torrent", async () => {
    // A torrent is binary: bytes that are not valid UTF-8, and one that is "d8:announce..." to start with.
    const torrent = Buffer.concat([Buffer.from("d8:announce31:http://tracker.example/announce4:infod6:lengthi1e4:name1:x12:piece lengthi16384e6:pieces20:"), Buffer.from(Array.from({ length: 20 }, (_, i) => 0xe0 + (i % 16)))]);
    expect(torrent.subarray(0, 3).toString()).toBe("d8:");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(indexerAnswer(torrent)));

    await adapter().addDownload(blackhole(), "https://idx.example.com/dl.torrent", null, "Some Movie 2020");

    expect(fs.readdirSync(watch)).toEqual(["Some Movie 2020.torrent"]);
    expect(fs.readFileSync(path.join(watch, "Some Movie 2020.torrent")).equals(torrent)).toBe(true);
  });

  it("writes a torrent as it is even when gzip- or UTF-16-looking bytes turn up later in it", async () => {
    // Bencoded dictionaries start with "d"; whatever follows, the first bytes decide it is not an NZB.
    const torrent = Buffer.concat([Buffer.from("d4:infod4:name1:xee"), Buffer.from([0x1f, 0x8b, 0xff, 0xfe])]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(indexerAnswer(torrent)));

    await adapter().addDownload(blackhole(), "https://idx.example.com/dl2.torrent", null, "Second Movie");

    expect(fs.readdirSync(watch)).toEqual(["Second Movie.torrent"]);
    expect(fs.readFileSync(path.join(watch, "Second Movie.torrent")).equals(torrent)).toBe(true);
  });

  it.each(ENCODINGS)("refuses an indexer's error document sent as %s and writes nothing", async (_label, encode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(indexerAnswer(encode(NZB_ERROR_XML))));

    await expect(adapter().addDownload(blackhole(), "https://idx.example.com/getnzb?id=8", null, "Refused Release")).rejects.toThrow(/^Failed to fetch release: .*Invalid API Key/);
    expect(fs.readdirSync(watch)).toEqual([]);
  });

  it("refuses a damaged gzip body and writes nothing", async () => {
    const damaged = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0xff]), Buffer.from("not deflate data")]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(indexerAnswer(damaged)));

    await expect(adapter().addDownload(blackhole(), "https://idx.example.com/getnzb?id=9", null, "Damaged Release")).rejects.toThrow(/^Failed to fetch release: .*gzip/);
    expect(fs.readdirSync(watch)).toEqual([]);
  });
});
