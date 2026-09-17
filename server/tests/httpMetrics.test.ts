import { describe, it, expect } from "vitest";
import { recordHttpRequest, getHttpMetricsSamples } from "../src/services/httpMetrics.js";

describe("httpMetrics", () => {
  it("aggregates count/errorCount/avgDurationMs per method+route", () => {
    recordHttpRequest("GET", "/api/media/:id", 200, 10);
    recordHttpRequest("GET", "/api/media/:id", 200, 20);
    recordHttpRequest("GET", "/api/media/:id", 500, 30);

    const sample = getHttpMetricsSamples().find((s) => s.method === "GET" && s.route === "/api/media/:id");
    expect(sample).toBeDefined();
    expect(sample!.count).toBe(3);
    expect(sample!.errorCount).toBe(1);
    expect(sample!.avgDurationMs).toBe(20);
  });

  it("keeps different routes and different methods on the same route separate", () => {
    recordHttpRequest("POST", "/api/media", 201, 5);
    recordHttpRequest("GET", "/api/media", 200, 15);

    const samples = getHttpMetricsSamples();
    const post = samples.find((s) => s.method === "POST" && s.route === "/api/media");
    const get = samples.find((s) => s.method === "GET" && s.route === "/api/media");
    expect(post!.count).toBe(1);
    expect(get!.count).toBe(1);
  });

  it("only counts 5xx responses as errors, not 4xx", () => {
    recordHttpRequest("GET", "/api/four-oh-four-only", 404, 1);
    const sample = getHttpMetricsSamples().find((s) => s.route === "/api/four-oh-four-only");
    expect(sample!.count).toBe(1);
    expect(sample!.errorCount).toBe(0);
  });
});
