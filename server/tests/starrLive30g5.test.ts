import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

/**
 * Defects the Round 30g live run found with the real tools (Jellyseerr 2.7.3's own Radarr/Sonarr client code run against a
 * running AoNarr). The bodies below are the ones the tool sent, captured from that run.
 */

let app: Express;
let apiKey: string;
let jobs: typeof import("../src/services/jobRegistry.js");

beforeAll(async () => {
  ({ app, apiKey } = await setupTestDb());
  jobs = await import("../src/services/jobRegistry.js");
});

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
const send = (method: "post" | "put", url: string, body: unknown) => request(app)[method](url).set("X-Api-Key", apiKey).send(body as object);

describe("Jellyseerr's download tracker: RefreshMonitoredDownloads", () => {
  let releasePoll: () => void;
  let polls = 0;

  beforeAll(() => {
    // The job registry the scheduler fills at startup is empty in a test: a poll that counts its runs and can be held open.
    jobs.registerJob({
      key: "queuePoll",
      name: "Queue poll",
      scheduleType: "interval",
      defaultSchedule: "3600",
      run: async () => {
        polls++;
        await new Promise<void>((resolve) => (releasePoll = resolve));
      },
    });
  });

  it("is accepted on all four apps and runs the queue check once, however many ask while it runs", async () => {
    // Jellyseerr sends this before every read of the queue (each minute) and does not read the queue when it is refused.
    for (const [app4, version] of [["sonarr", "v3"], ["radarr", "v3"], ["lidarr", "v1"], ["readarr", "v1"]] as const) {
      const before = polls;
      const res = await send("post", `/${app4}/api/${version}/command`, { name: "RefreshMonitoredDownloads" });
      expect(res.status, app4).toBe(201);
      expect(res.body).toMatchObject({ name: "RefreshMonitoredDownloads", commandName: "Refresh Monitored Downloads" });
      await vi.waitFor(() => expect(polls).toBe(before + 1));
      // A second command while the poll is still running is not an error either.
      const second = await send("post", `/${app4}/api/${version}/command`, { name: "RefreshMonitoredDownloads" });
      expect(second.status, app4).toBe(201);
      expect(polls).toBe(before + 1);
      releasePoll();
      await vi.waitFor(async () => expect((await get(`/${app4}/api/${version}/command/${res.body.id}`)).body.status).toBe("completed"));
      // The job is idle again before the next app asks.
      await vi.waitFor(() => expect(jobs.listJobs().find((j) => j.key === "queuePoll")?.running).toBe(false));
    }
  });
});
