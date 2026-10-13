#!/usr/bin/env node
// Read-only proof from the seeded container's nginx access log (nginx writes it to stdout, so `docker logs` has it).
//   node scripts/readonly-proof.mjs [--after-line N] [--out .tmp/readonly-proof.json]
// Counts every request by method; lists every request that is not GET/HEAD (method, path without query, status, user agent).
// Request lines are never echoed with their query strings, and nothing else from the container log is printed.
// Only `docker logs` on the container named aonarr-e2e is run.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { E2E_DIR, TMP_DIR } from "./_common.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const afterLine = Number(opt("--after-line", "0"));
const outFile = path.resolve(E2E_DIR, opt("--out", ".tmp/readonly-proof.json"));

const r = spawnSync("docker", ["logs", "--timestamps", "aonarr-e2e"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
if (r.status !== 0) { console.error("docker logs failed"); process.exit(1); }
const lines = (r.stdout + r.stderr).split(/\r?\n/);
const re = /\[(\d{2}\/\w{3}\/\d{4}:[\d:]{8}) [+-]\d{4}\] "([A-Z]+) (\S+) HTTP\/[\d.]+" (\d{3}) \d+ "[^"]*" "([^"]*)"/;
const norm = (p) => p.split("?")[0].replace(/\/[0-9a-f]{32,}/g, "/:token").replace(/\/\d+/g, "/:id");

const all = { total: 0, byMethod: {}, firstAt: null, lastAt: null };
const mutations = new Map();
const healthChecks = { count: 0 };
let considered = 0;
lines.forEach((line, idx) => {
  if (idx + 1 <= afterLine) return;
  const m = re.exec(line);
  if (!m) return;
  const [, ts, method, rawPath, status, ua] = m;
  considered++;
  all.total++;
  all.byMethod[method] = (all.byMethod[method] ?? 0) + 1;
  all.firstAt ??= ts;
  all.lastAt = ts;
  if (/^curl\//.test(ua) && rawPath === "/api/health") healthChecks.count++;
  if (method !== "GET" && method !== "HEAD") {
    const key = `${method} ${norm(rawPath)} -> ${status} (ua: ${ua.split(" ")[0]})`;
    mutations.set(key, (mutations.get(key) ?? 0) + 1);
  }
});
const result = {
  note: "nginx access log of the aonarr-e2e container (everything that reached the instance), lines after the seed finished",
  afterLine, linesInLog: lines.length, requestsCounted: considered, firstAt: all.firstAt, lastAt: all.lastAt,
  byMethod: all.byMethod, containerHealthChecks: healthChecks.count,
  nonGetRequests: [...mutations.entries()].map(([k, n]) => ({ request: k, count: n })),
};
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
