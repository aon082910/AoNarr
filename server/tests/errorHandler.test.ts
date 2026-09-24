import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express, Request, Response } from "express";
import multer from "multer";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;

beforeAll(async () => {
  ({ app, apiKey } = await setupTestDb());
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function spyOnErrorLog() {
  const { log } = await import("../src/services/logger.js");
  return vi.spyOn(log, "error");
}

/** Just enough of an Express response for errorHandler: status().json(). */
function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

// body-parser and multer errors aren't HttpErrors — they used to fall through to a logged 500
// "Internal server error", so a client's own malformed/oversized request looked like a server bug.
describe("errorHandler — middleware client errors over HTTP", () => {
  it("answers malformed JSON with 400, even unauthenticated, without logging an error", async () => {
    const errorLog = await spyOnErrorLog();
    const res = await request(app).post("/api/tags").set("Content-Type", "application/json").send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("answers an over-limit JSON body with 413", async () => {
    const res = await request(app)
      .post("/api/tags")
      .set("X-Api-Key", apiKey)
      .send({ name: "big", padding: "x".repeat(150 * 1024) });
    expect(res.status).toBe(413);
  });

  it("answers a multer upload error with 400", async () => {
    const res = await request(app)
      .post("/api/media/bulk-import.csv")
      .set("X-Api-Key", apiKey)
      .attach("not-the-file-field", Buffer.from("id,monitored\n1,1\n"), "items.csv");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unexpected file field");
  });
});

describe("settings template import body limit", () => {
  it("accepts a template well over the default 100kb JSON limit", async () => {
    const customFormats = Array.from({ length: 300 }, (_, i) => ({
      name: `Big Template Format ${i}`,
      conditionGroups: [{ type: "title", patterns: [`\\b(${"release-group-".repeat(30)}${i})\\b`], negate: false }],
      mediaTypes: [],
    }));
    const body = { templateVersion: 1, qualities: [], qualityProfiles: [], customFormats, formatScores: [], namingTemplates: {} };
    expect(JSON.stringify(body).length).toBeGreaterThan(100 * 1024);

    const res = await request(app).post("/api/settings/template/import").set("X-Api-Key", apiKey).send(body);
    expect(res.status).toBe(200);
    expect(res.body.formatsImported).toBe(300);
  });
});

describe("errorHandler — direct", () => {
  it("maps multer's file-size limit to 413 and other multer errors to 400", async () => {
    const { errorHandler } = await import("../src/middleware/errorHandler.js");
    const tooBig = fakeRes();
    errorHandler(new multer.MulterError("LIMIT_FILE_SIZE", "avatar"), {} as Request, tooBig as unknown as Response, () => {});
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.body).toEqual({ error: "File too large" });

    const tooMany = fakeRes();
    errorHandler(new multer.MulterError("LIMIT_FILE_COUNT"), {} as Request, tooMany as unknown as Response, () => {});
    expect(tooMany.statusCode).toBe(400);
  });

  it("keeps a 500 for an error carrying a 4xx status it doesn't mark as safe to expose", async () => {
    const { errorHandler } = await import("../src/middleware/errorHandler.js");
    const errorLog = await spyOnErrorLog();
    const res = fakeRes();
    const err = Object.assign(new Error("upstream said 404"), { status: 404 });
    errorHandler(err, {} as Request, res as unknown as Response, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(errorLog).toHaveBeenCalled();
  });

  it("still maps HttpError to its own status", async () => {
    const { errorHandler, HttpError } = await import("../src/middleware/errorHandler.js");
    const res = fakeRes();
    errorHandler(new HttpError(409, "conflict"), {} as Request, res as unknown as Response, () => {});
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "conflict" });
  });
});
