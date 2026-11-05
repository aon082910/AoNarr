import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

let art: typeof import("../src/services/artworkFiles.js");
let dir: string;

beforeAll(async () => {
  await setupTestDb();
  art = await import("../src/services/artworkFiles.js");
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-artwork-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

const jpeg = (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 1)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);

function image(bytes: Buffer, type = "image/jpeg", init: ResponseInit = {}): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": type }, ...init });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const listing = () => fs.readdirSync(dir).sort();

describe("writeArtworkFile", () => {
  it("fetches the picture, writes it under its own extension and leaves no temporary file", async () => {
    stubFetch(() => image(jpeg()));

    const result = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false });

    expect(result.outcome).toBe("written");
    expect(listing()).toEqual(["poster.jpg"]);
    expect(fs.readFileSync(path.join(dir, "poster.jpg")).equals(jpeg())).toBe(true);
  });

  it("names a PNG poster.png, the extension the bytes really are", async () => {
    stubFetch(() => image(png(), "image/png"));

    await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p" }, { overwrite: false });

    expect(listing()).toEqual(["poster.png"]);
  });

  it("keeps a picture that is already there, without asking the network", async () => {
    fs.writeFileSync(path.join(dir, "poster.jpg"), "mine");
    const fetchMock = stubFetch(() => image(jpeg()));

    const result = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false });

    expect(result.outcome).toBe("exists");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, "poster.jpg"), "utf-8")).toBe("mine");
  });

  it("counts folder.jpg as the poster, and any extension of the name as being there", async () => {
    fs.writeFileSync(path.join(dir, "folder.png"), "mine");
    const fetchMock = stubFetch(() => image(jpeg()));

    const viaFolder = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false, alsoCountsAs: ["folder"] });
    expect(viaFolder.outcome).toBe("exists");

    fs.writeFileSync(path.join(dir, "fanart.png"), "mine");
    const otherExtension = await art.writeArtworkFile(dir, "fanart", { url: "https://img.example.com/f.jpg" }, { overwrite: false });
    expect(otherExtension.outcome).toBe("exists");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces a picture only when overwrite is on, and takes away the same name under another extension", async () => {
    fs.writeFileSync(path.join(dir, "poster.png"), "old");
    stubFetch(() => image(jpeg()));

    const result = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: true });

    expect(result.outcome).toBe("written");
    expect(listing()).toEqual(["poster.jpg"]);
  });

  it("refuses an answer whose content type is not an image", async () => {
    stubFetch(() => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } }));

    const result = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false });

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("not an image");
    expect(listing()).toEqual([]);
  });

  it("refuses bytes that are not a picture although the answer calls them one", async () => {
    stubFetch(() => image(Buffer.from("<html>an error page</html>")));

    const result = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false });

    expect(result.outcome).toBe("failed");
    expect(listing()).toEqual([]);
  });

  it("refuses a body that is declared too large without reading it", async () => {
    const big = new Response(jpeg(), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(art.ARTWORK_MAX_BYTES + 1) } });
    stubFetch(() => big);

    const result = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false });

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("larger than");
    expect(listing()).toEqual([]);
  });

  it("stops reading a body that grows past the limit though it never said how large it was", async () => {
    const chunk = Buffer.alloc(4 * 1024 * 1024, 7);
    chunk[0] = 0xff;
    chunk[1] = 0xd8;
    chunk[2] = 0xff;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 6) controller.enqueue(chunk);
        else controller.close();
      },
    });
    stubFetch(() => new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } }));

    const result = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false });

    expect(result.outcome).toBe("failed");
    expect(sent).toBeLessThan(6);
    expect(listing()).toEqual([]);
  });

  it("leaves nothing behind when the download dies halfway", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ === 0) controller.enqueue(jpeg(1000));
        else controller.error(new Error("connection reset"));
      },
    });
    stubFetch(() => new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } }));

    const result = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false });

    expect(result.outcome).toBe("failed");
    expect(listing()).toEqual([]);
  });

  it("does not touch the file that is there when an overwrite fails", async () => {
    fs.writeFileSync(path.join(dir, "poster.jpg"), "mine");
    stubFetch(() => new Response("gone", { status: 404 }));

    const result = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: true });

    expect(result.outcome).toBe("failed");
    expect(fs.readFileSync(path.join(dir, "poster.jpg"), "utf-8")).toBe("mine");
  });

  it("does not fetch a URL on a local address, with credentials, or of another kind", async () => {
    const fetchMock = stubFetch(() => image(jpeg()));

    for (const url of ["http://192.168.1.5/p.jpg", "http://localhost/p.jpg", "https://user:pw@img.example.com/p.jpg", "ftp://img.example.com/p.jpg"]) {
      const result = await art.writeArtworkFile(dir, `poster-${listing().length}`, { url }, { overwrite: false });
      // ftp is not an http(s) address at all, so it names no source.
      expect(["failed", "none"], url).toContain(result.outcome);
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(listing()).toEqual([]);
  });

  it("follows a redirect to a public address and refuses one to a local address", async () => {
    stubFetch((url) => {
      if (url.endsWith("/public")) return new Response(null, { status: 302, headers: { location: "https://cdn.example.com/real.jpg" } });
      if (url.endsWith("/real.jpg")) return image(jpeg());
      return new Response(null, { status: 302, headers: { location: "http://10.0.0.7/secret.jpg" } });
    });

    const followed = await art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/public" }, { overwrite: false });
    expect(followed.outcome).toBe("written");

    const refused = await art.writeArtworkFile(dir, "fanart", { url: "https://img.example.com/elsewhere" }, { overwrite: false });
    expect(refused.outcome).toBe("failed");
    expect(listing()).toEqual(["poster.jpg"]);
  });

  it("uses the picture AoNarr already holds before the URL, and the URL when that file is gone", async () => {
    const local = path.join(dir, "..", `aonarr-local-${Date.now()}.jpg`);
    fs.writeFileSync(local, jpeg(10));
    const fetchMock = stubFetch(() => image(jpeg(99)));

    try {
      const first = await art.writeArtworkFile(dir, "poster", { localPath: local, url: "https://img.example.com/p.jpg" }, { overwrite: false });
      expect(first.outcome).toBe("written");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(dir, "poster.jpg")).equals(jpeg(10))).toBe(true);

      const second = await art.writeArtworkFile(dir, "fanart", { localPath: path.join(dir, "missing.jpg"), url: "https://img.example.com/f.jpg" }, { overwrite: false });
      expect(second.outcome).toBe("written");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(local, { force: true });
    }
  });

  it("asks for TMDB's full-size picture first and falls back to the size it stored", async () => {
    const fetchMock = stubFetch((url) => (url.includes("/original/") ? new Response("no", { status: 404 }) : image(jpeg())));

    const result = await art.writeArtworkFile(dir, "poster", { url: "https://image.tmdb.org/t/p/w342/abc.jpg" }, { overwrite: false });

    expect(result.outcome).toBe("written");
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://image.tmdb.org/t/p/original/abc.jpg", "https://image.tmdb.org/t/p/w342/abc.jpg"]);
  });

  it("reports a source that names nothing as none, and asks nobody", async () => {
    const fetchMock = stubFetch(() => image(jpeg()));

    expect((await art.writeArtworkFile(dir, "poster", { url: null }, { overwrite: false })).outcome).toBe("none");
    expect((await art.writeArtworkFile(dir, "poster", { url: "/api/media/local-artwork/abc" }, { overwrite: false })).outcome).toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches one picture once when two imports ask for it at the same moment", async () => {
    const fetchMock = stubFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return image(jpeg());
    });

    const [a, b] = await Promise.all([
      art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false }),
      art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false }),
    ]);

    expect(a.outcome).toBe("written");
    expect(b.outcome).toBe("written");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at once when the run is cancelled", async () => {
    const controller = new AbortController();
    // A request that never answers, until its signal says stop.
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    );
    const pending = art.writeArtworkFile(dir, "poster", { url: "https://img.example.com/p.jpg" }, { overwrite: false, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled")), 20);

    const result = await pending;

    expect(result.outcome).toBe("failed");
    expect(listing()).toEqual([]);
  });
});

describe("sniffImage", () => {
  it("knows the four formats by their first bytes and nothing else", () => {
    expect(art.sniffImage(jpeg())).toBe("jpg");
    expect(art.sniffImage(png())).toBe("png");
    expect(art.sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe("webp");
    expect(art.sniffImage(Buffer.from("GIF89a....."))).toBe("gif");
    expect(art.sniffImage(Buffer.from("<html></html>"))).toBeNull();
    expect(art.sniffImage(Buffer.alloc(0))).toBeNull();
  });
});
