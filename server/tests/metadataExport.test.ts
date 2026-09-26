import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import os from "node:os";
import request from "supertest";
import AdmZip from "adm-zip";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

const movie = {
  type: "movie",
  title: "Dune",
  year: 2021,
  overview: "A noble family becomes embroiled in a war.",
  posterUrl: "https://example.com/poster.jpg",
  externalIds: { tmdb: "438631", imdb: "tt1160419" },
};

describe("buildNfo", () => {
  it("uses <movie> as the root for a single-shape type", async () => {
    const { buildNfo } = await import("../src/services/metadataExport.js");
    const xml = buildNfo(movie);
    expect(xml).toContain("<movie>");
    expect(xml).toContain("<title>Dune</title>");
    expect(xml).toContain('<uniqueid type="tmdb">438631</uniqueid>');
  });

  it("uses <tvshow> as the root for episodic/collection-shape types, not just movies", async () => {
    const { buildNfo } = await import("../src/services/metadataExport.js");
    expect(buildNfo({ ...movie, type: "series" })).toContain("<tvshow>");
    expect(buildNfo({ ...movie, type: "artist" })).toContain("<tvshow>");
  });

  it("escapes XML-significant characters in title/overview", async () => {
    const { buildNfo } = await import("../src/services/metadataExport.js");
    const xml = buildNfo({ ...movie, title: `Bob & "Doug" <McKenzie>`, overview: null });
    expect(xml).toContain("Bob &amp; &quot;Doug&quot; &lt;McKenzie&gt;");
  });

  it("omits optional elements entirely when the field is absent, rather than emitting empty tags", async () => {
    const { buildNfo } = await import("../src/services/metadataExport.js");
    const xml = buildNfo({ type: "movie", title: "Bare", year: null, overview: null, posterUrl: null, externalIds: {} });
    expect(xml).not.toContain("<year>");
    expect(xml).not.toContain("<plot>");
    expect(xml).not.toContain("<thumb");
    expect(xml).not.toContain("<uniqueid");
  });
});

describe("buildJson / buildPlexMatch / buildCalibreOpf", () => {
  it("buildJson round-trips the item through JSON", async () => {
    const { buildJson } = await import("../src/services/metadataExport.js");
    expect(JSON.parse(buildJson(movie))).toEqual(movie);
  });

  it("buildPlexMatch includes only the ids that are actually present", async () => {
    const { buildPlexMatch } = await import("../src/services/metadataExport.js");
    const text = buildPlexMatch(movie);
    expect(text).toContain("tmdbid: 438631");
    expect(text).toContain("imdbid: tt1160419");
    expect(text).not.toContain("tvdbid:");
  });

  it("buildCalibreOpf puts an ISBN in its own dc:identifier with the ISBN scheme", async () => {
    const { buildCalibreOpf } = await import("../src/services/metadataExport.js");
    const opf = buildCalibreOpf({ ...movie, externalIds: { isbn: "9780593099322" } });
    expect(opf).toContain('opf:scheme="ISBN"');
    expect(opf).toContain("9780593099322");
  });
});

describe("safeFileName", () => {
  it("strips filesystem-illegal characters and trims whitespace", async () => {
    const { safeFileName } = await import("../src/services/metadataExport.js");
    expect(safeFileName('Movie: "Subtitle" <2021>')).toBe("Movie Subtitle 2021");
  });

  it("truncates an excessively long title to 200 characters", async () => {
    const { safeFileName } = await import("../src/services/metadataExport.js");
    expect(safeFileName("A".repeat(500)).length).toBe(200);
  });
});

describe("writeNfoSidecar", () => {
  it("writes a sidecar with the same basename as the media file, next to it", async () => {
    const { writeNfoSidecar } = await import("../src/services/metadataExport.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-nfo-"));
    const mediaFile = path.join(dir, "Dune (2021).mkv");
    fs.writeFileSync(mediaFile, "fake video content");

    writeNfoSidecar(mediaFile, movie);

    const nfoPath = path.join(dir, "Dune (2021).nfo");
    expect(fs.existsSync(nfoPath)).toBe(true);
    expect(fs.readFileSync(nfoPath, "utf-8")).toContain("<title>Dune</title>");
  });

  it("never throws even when the target directory doesn't exist", async () => {
    const { writeNfoSidecar } = await import("../src/services/metadataExport.js");
    expect(() => writeNfoSidecar("/definitely/does/not/exist/movie.mkv", movie)).not.toThrow();
  });
});

describe("fetchPosterBuffer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null without making a request when there's no URL", async () => {
    const { fetchPosterBuffer } = await import("../src/services/metadataExport.js");
    expect(await fetchPosterBuffer(null)).toBeNull();
  });

  it("downloads a ScreenScraper poster through its stored reference, with the credentials added server-side", async () => {
    const { setSetting, deleteSetting } = await import("../src/services/settingsStore.js");
    setSetting("screenscraperDevId", "export-dev");
    setSetting("screenscraperDevPassword", "export-dev-secret");
    const fetchMock = vi.fn(async () => new Response(Buffer.from("png-bytes"), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchPosterBuffer } = await import("../src/services/metadataExport.js");

    try {
      const buffer = await fetchPosterBuffer(
        "/api/media/local-artwork/sometoken",
        "screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?systemeid=1&jeuid=4242&media=box-2D"
      );

      expect(buffer?.toString()).toBe("png-bytes");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
      expect(url.hostname).toBe("neoclone.screenscraper.fr");
      expect(url.searchParams.get("jeuid")).toBe("4242");
      expect(url.searchParams.get("devpassword")).toBe("export-dev-secret");
    } finally {
      deleteSetting("screenscraperDevId");
      deleteSetting("screenscraperDevPassword");
    }
  });

  it("returns null once its signal has aborted, without leaving the request running", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      })
    );
    const { fetchPosterBuffer } = await import("../src/services/metadataExport.js");
    const controller = new AbortController();

    const pending = fetchPosterBuffer("https://img.example/slow.jpg", null, controller.signal);
    controller.abort();

    expect(await pending).toBeNull();
    expect(requestSignal?.aborted).toBe(true);
    expect(await fetchPosterBuffer("https://img.example/slow.jpg", null, controller.signal)).toBeNull();
  });
});

async function insertItem(type: string, title: string, year: number | null): Promise<number> {
  // No poster_url, so the exports never go to the network for artwork.
  const result = await db
    .prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES (?, ?, ?, ?, 1, 0, 'missing')`)
    .run(type, title, title.toLowerCase(), year);
  return Number(result.lastInsertRowid);
}

function getZip(url: string) {
  return request(app)
    .get(url)
    .set("X-Api-Key", apiKey)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
}

describe("GET /api/media/:id/export", () => {
  it("downloads an item whose title is outside Latin-1, with the name carried in an RFC 5987 filename*", async () => {
    const id = await insertItem("artist", "坂本龍一", null);

    const res = await request(app).get(`/api/media/${id}/export?format=nfo`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("坂本龍一")}.nfo`);
    expect(res.text).toContain("<title>坂本龍一</title>");
  });

  it("still names a plexmatch download exactly .plexmatch", async () => {
    const id = await insertItem("movie", "Plexmatch Name Test", 2001);

    const res = await request(app).get(`/api/media/${id}/export?format=plexmatch`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename=".plexmatch"');
  });
});

describe("bulk zip exports with same-titled items", () => {
  it("gives two same-titled items their own .nfo, told apart by year", async () => {
    await insertItem("series", "Dune", 1984);
    await insertItem("series", "Dune", 2021);
    await insertItem("series", "Arrival", 2016);

    const res = await getZip("/api/media/export-bulk.zip?type=series&format=nfo");

    expect(res.status).toBe(200);
    const zip = new AdmZip(res.body as Buffer);
    expect(zip.getEntries().map((e) => e.entryName).sort()).toEqual(["Arrival.nfo", "Dune (1984).nfo", "Dune (2021).nfo"]);
    expect(zip.readAsText("Dune (1984).nfo")).toContain("<year>1984</year>");
    expect(zip.readAsText("Dune (2021).nfo")).toContain("<year>2021</year>");
  });

  it("falls back to the item id when the title and year are both shared (plexmatch folders)", async () => {
    const first = await insertItem("adult", "Solaris", 1972);
    const second = await insertItem("adult", "solaris", 1972);

    const res = await getZip("/api/media/export-bulk.zip?type=adult&format=plexmatch");

    expect(res.status).toBe(200);
    const names = new AdmZip(res.body as Buffer).getEntries().map((e) => e.entryName).sort();
    // Whichever row comes back first keeps the plain "title (year)" folder; the other gets its id.
    // Compared case-insensitively, since "Solaris" and "solaris" collide on a case-insensitive disk.
    const lower = names.map((n) => n.toLowerCase());
    expect(lower).toHaveLength(2);
    expect(lower).toContain("solaris (1972)/.plexmatch");
    expect([`solaris (1972) [${first}]/.plexmatch`, `solaris (1972) [${second}]/.plexmatch`]).toContain(
      lower.find((n) => n !== "solaris (1972)/.plexmatch")
    );
  });

  it("keeps each same-titled book's metadata.opf in its own Calibre folder", async () => {
    const first = await insertItem("book", "Emma", null);
    const second = await insertItem("book", "Emma", null);

    const res = await getZip("/api/media/export-calibre.zip?type=book");

    expect(res.status).toBe(200);
    const names = new AdmZip(res.body as Buffer).getEntries().map((e) => e.entryName).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain("Emma/metadata.opf");
    expect([`Emma [${first}]/metadata.opf`, `Emma [${second}]/metadata.opf`]).toContain(names.find((n) => n !== "Emma/metadata.opf"));
  });
});

async function insertItemWithPoster(type: string, title: string, posterUrl: string): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO media_items (type, title, sort_title, poster_url, monitored, has_file, status) VALUES (?, ?, ?, ?, 1, 0, 'missing')`)
    .run(type, title, title.toLowerCase(), posterUrl);
  return Number(result.lastInsertRowid);
}

describe("bulk zip exports with posters", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches posters a few items ahead, not one at a time or all at once, and keeps each with its item", async () => {
    for (let i = 0; i < 20; i++) await insertItemWithPoster("rom", `Poster Game ${String(i).padStart(2, "0")}`, `https://img.example/game-${i}.jpg`);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return new Response(Buffer.from(`jpeg:${url}`));
      })
    );

    const res = await getZip("/api/media/export-bulk.zip?type=rom&format=nfo");

    expect(res.status).toBe(200);
    const zip = new AdmZip(res.body as Buffer);
    expect(zip.getEntries()).toHaveLength(40);
    expect(zip.readAsText("Poster Game 07-poster.jpg")).toBe("jpeg:https://img.example/game-7.jpg");
    expect(zip.readAsText("Poster Game 19.nfo")).toContain("<title>Poster Game 19</title>");
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it("gives up on a poster that never arrives instead of stalling the whole export, and cancels its request", async () => {
    await insertItemWithPoster("manga", "Hanging Cover", "https://img.example/hang.jpg");
    await insertItemWithPoster("manga", "Quick Cover", "https://img.example/quick.jpg");
    const hangingSignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (!url.includes("hang")) return Promise.resolve(new Response(Buffer.from("jpeg")));
        hangingSignals.push(init!.signal!);
        return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
      })
    );
    // The real per-poster timeout, shortened so the test doesn't wait it out.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(50));

    const res = await getZip("/api/media/export-calibre.zip?type=manga");

    expect(res.status).toBe(200);
    const names = new AdmZip(res.body as Buffer).getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(["Hanging Cover/metadata.opf", "Quick Cover/cover.jpg", "Quick Cover/metadata.opf"]);
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(hangingSignals).toHaveLength(1);
    expect(hangingSignals[0].aborted).toBe(true);
  });

  it("stops fetching posters once the client has gone away", async () => {
    for (let i = 0; i < 40; i++) await insertItemWithPoster("podcast", `Abort Show ${String(i).padStart(2, "0")}`, `https://img.example/abort-${i}.jpg`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = vi.fn(async (url: string) => {
      if (Number(url.match(/abort-(\d+)/)![1]) >= 10) await gate;
      return new Response(Buffer.from("jpeg"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { log } = await import("../src/services/logger.js");
    const warn = vi.spyOn(log, "warn");
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/api/media/export-bulk.zip?type=podcast&format=nfo", headers: { "X-Api-Key": apiKey } },
          (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
          }
        );
        req.on("error", (err) => (err.message.includes("socket hang up") ? undefined : reject(err)));
      });
      const connections = () => new Promise<number>((resolve) => server.getConnections((_err, n) => resolve(n)));
      await vi.waitFor(async () => expect(await connections()).toBe(0));
      release();

      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[media] bulk export aborted:", expect.any(String)));
      // 10 posters written, 8 more prefetched while the export waited on the 11th, and at most the
      // one prefetched when that 11th finally arrived — never the other 20-odd.
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(19);
    } finally {
      release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
