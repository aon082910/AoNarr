#!/usr/bin/env node
// Serve the web-e2e build (web-e2e/.tmp/web-dist) on 127.0.0.1:4173 with /api/* proxied to the seeded throwaway container.
//
//   node scripts/serve-web.mjs
//
// Uses scripts/static-server.mjs (plain node:http) instead of `vite preview`, which froze for minutes during full sweeps (see
// the header of that file). The build under test is unchanged: it is exactly what scripts/build-web.mjs wrote. Refuses to start if
// the backend is not a loopback address or does not answer, so a sweep can never be pointed at anything else by accident.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { APP_HOST, APP_PORT, BACKEND_URL, DIST_DIR, log } from "./_common.mjs";
import { startStaticServer } from "./static-server.mjs";

function get(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
  });
}

if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
  console.error(`[web-e2e] No build at ${DIST_DIR}. Run: npm run build`);
  process.exit(1);
}

// Safety: BACKEND_URL (default http://127.0.0.1:8989, the seeded container) must be a loopback address.
const backend = new URL(BACKEND_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname)) {
  console.error(`[web-e2e] Refusing to run: backend ${BACKEND_URL} is not a loopback address.`);
  process.exit(1);
}
const health = await get(`${BACKEND_URL}/api/health`);
if (health.status !== 200) {
  console.error(`[web-e2e] Seeded instance not reachable at ${BACKEND_URL}/api/health (${health.status} ${health.body}). Run: npm run seed:start`);
  process.exit(1);
}
const server = await startStaticServer({ distDir: DIST_DIR, backendUrl: BACKEND_URL, host: APP_HOST, port: APP_PORT });
log(`static server for ${DIST_DIR} on http://${APP_HOST}:${APP_PORT} (node:http); /api/* -> ${BACKEND_URL}`);

// Prove the proxy really reaches the seeded backend before reporting ready.
const viaProxy = await get(`http://${APP_HOST}:${APP_PORT}/api/health`);
if (viaProxy.status !== 200) {
  console.error(`[web-e2e] the static server did not proxy /api to the backend (${viaProxy.status} ${viaProxy.body}).`);
  server.close();
  process.exit(1);
}
log("proxy check ok: GET /api/health via the static server -> 200");

function shutdown() {
  server.close();
  server.closeAllConnections?.();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
