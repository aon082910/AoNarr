import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let backgroundJobs: typeof import("../src/services/backgroundJobs.js");

beforeAll(async () => {
  ({ app, apiKey } = await setupTestDb());
  backgroundJobs = await import("../src/services/backgroundJobs.js");
});

describe("GET /api/background-jobs", () => {
  it("requires admin credentials", async () => {
    const res = await request(app).get("/api/background-jobs");
    expect(res.status).toBe(401);
  });

  it("lists a job started directly through the tracker", async () => {
    const id = backgroundJobs.startBackgroundJob("scan", "test-route-list", "Scan & Import — Test Route List", 5);
    try {
      backgroundJobs.incrementBackgroundJobDone("scan", "test-route-list");
      const res = await request(app).get("/api/background-jobs").set("X-Api-Key", apiKey);
      expect(res.status).toBe(200);
      const job = (res.body as any[]).find((j) => j.id === id);
      expect(job).toMatchObject({ kind: "scan", type: "test-route-list", label: "Scan & Import — Test Route List", total: 5, done: 1, running: true });
    } finally {
      backgroundJobs.finishBackgroundJob(id);
    }
  });
});
