import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PassThrough } from "node:stream";
import { streamFileWithRangeSupport, CONTENT_TYPES } from "../src/services/rangeStream.js";

let tmpDir: string;
let filePath: string;
let fileContent: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-rangestream-"));
  fileContent = "0123456789ABCDEFGHIJ"; // 20 bytes, easy to reason about by index
  filePath = path.join(tmpDir, "video.mkv");
  fs.writeFileSync(filePath, fileContent);
});

function makeResponse() {
  const res: any = new PassThrough();
  res.statusCode = 200;
  res.headers = {};
  res.jsonBody = undefined;
  res.writeHead = (status: number, headers: Record<string, unknown>) => {
    res.statusCode = status;
    Object.assign(res.headers, headers);
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.set = (fieldOrHeaders: string | Record<string, unknown>, value?: unknown) => {
    if (typeof fieldOrHeaders === "string") res.headers[fieldOrHeaders] = value;
    else Object.assign(res.headers, fieldOrHeaders);
    return res;
  };
  res.json = (body: unknown) => {
    res.jsonBody = body;
    return res;
  };
  return res;
}

async function collectBody(res: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function makeRequest(range?: string): any {
  return { headers: range ? { range } : {} };
}

describe("streamFileWithRangeSupport", () => {
  it("serves the whole file with a 200 when no Range header is sent", async () => {
    const res = makeResponse();
    streamFileWithRangeSupport(makeRequest(), res, filePath);

    const body = await collectBody(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Length"]).toBe(fileContent.length);
    expect(res.headers["Accept-Ranges"]).toBe("bytes");
    expect(body).toBe(fileContent);
  });

  it("serves a byte range with 206 and the correct Content-Range", async () => {
    const res = makeResponse();
    streamFileWithRangeSupport(makeRequest("bytes=0-4"), res, filePath);

    const body = await collectBody(res);
    expect(res.statusCode).toBe(206);
    expect(res.headers["Content-Range"]).toBe(`bytes 0-4/${fileContent.length}`);
    expect(res.headers["Content-Length"]).toBe(5);
    expect(body).toBe("01234");
  });

  it("serves an open-ended range (bytes=N-) through to the end of the file", async () => {
    const res = makeResponse();
    streamFileWithRangeSupport(makeRequest("bytes=15-"), res, filePath);

    const body = await collectBody(res);
    expect(res.statusCode).toBe(206);
    expect(body).toBe(fileContent.slice(15));
  });

  it("serves a suffix range (bytes=-N) as the last N bytes of the file", async () => {
    const res = makeResponse();
    streamFileWithRangeSupport(makeRequest("bytes=-5"), res, filePath);

    const body = await collectBody(res);
    expect(res.statusCode).toBe(206);
    expect(body).toBe(fileContent.slice(-5));
  });

  it("clamps an end beyond the file size down to the last byte instead of erroring", async () => {
    const res = makeResponse();
    streamFileWithRangeSupport(makeRequest(`bytes=10-999999`), res, filePath);

    const body = await collectBody(res);
    expect(res.statusCode).toBe(206);
    expect(res.headers["Content-Range"]).toBe(`bytes 10-${fileContent.length - 1}/${fileContent.length}`);
    expect(body).toBe(fileContent.slice(10));
  });

  it("returns 416 for a syntactically invalid Range header", async () => {
    const res = makeResponse();
    streamFileWithRangeSupport(makeRequest("bytes=abc"), res, filePath);

    expect(res.statusCode).toBe(416);
    expect(res.headers["Content-Range"]).toBe(`bytes */${fileContent.length}`);
  });

  it("returns 416 when the range start is at or beyond the file size", async () => {
    const res = makeResponse();
    streamFileWithRangeSupport(makeRequest(`bytes=${fileContent.length}-`), res, filePath);

    expect(res.statusCode).toBe(416);
  });

  it("returns a 404 JSON error when the file doesn't exist on disk", async () => {
    const res = makeResponse();
    streamFileWithRangeSupport(makeRequest(), res, path.join(tmpDir, "does-not-exist.mkv"));

    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ error: "File not found on disk" });
  });

  it("sets the Content-Type from the file extension, falling back to octet-stream for an unknown one", async () => {
    expect(CONTENT_TYPES[".mkv"]).toBe("video/x-matroska");
    expect(CONTENT_TYPES[".mp3"]).toBe("audio/mpeg");

    const unknownPath = path.join(tmpDir, "mystery.xyz");
    fs.writeFileSync(unknownPath, "data");
    const res = makeResponse();
    streamFileWithRangeSupport(makeRequest(), res, unknownPath);
    await collectBody(res);

    expect(res.headers["Content-Type"]).toBe("application/octet-stream");
  });
});
