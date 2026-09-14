/** In-memory HTTP request metrics, exposed via routes/metrics.ts's Prometheus endpoint —
 * previously that endpoint only had business/library gauges (item counts, queue depth), nothing
 * about the HTTP layer itself (request volume, error rate, latency), which is normally the first
 * thing anyone reaches for when debugging "is the app actually healthy right now". Keyed by
 * method+route (not the raw path) to keep cardinality bounded — Express's own route pattern
 * (`/api/media/:id`) rather than every distinct id that was ever requested. */
interface RouteStats {
  count: number;
  errorCount: number;
  totalDurationMs: number;
}

const stats = new Map<string, RouteStats>();

export function recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number): void {
  const key = `${method} ${route}`;
  const s = stats.get(key) ?? { count: 0, errorCount: 0, totalDurationMs: 0 };
  s.count++;
  if (statusCode >= 500) s.errorCount++;
  s.totalDurationMs += durationMs;
  stats.set(key, s);
}

export interface RouteMetricSample {
  method: string;
  route: string;
  count: number;
  errorCount: number;
  avgDurationMs: number;
}

export function getHttpMetricsSamples(): RouteMetricSample[] {
  return Array.from(stats.entries()).map(([key, s]) => {
    const spaceIdx = key.indexOf(" ");
    return {
      method: key.slice(0, spaceIdx),
      route: key.slice(spaceIdx + 1),
      count: s.count,
      errorCount: s.errorCount,
      avgDurationMs: s.count > 0 ? Math.round((s.totalDurationMs / s.count) * 10) / 10 : 0,
    };
  });
}
