// A small static server + /api reverse proxy on plain node:http, used instead of `vite preview`.
//
// Why: in the Phase 0 runs `vite preview` froze for 85-190 s several times (curl to / and /api/health on 127.0.0.1:4173 timed out
// while the container kept answering its own health checks), failing four tests at a time with page.goto ERR_CONNECTION_RESET.
// Nothing in the app was involved. This server does only what the sweep needs and nothing else, so the web build under test is
// byte-for-byte what `vite build` produced and the only moving part is node:http:
//   * GET/HEAD of a file inside distDir, else index.html (SPA fallback, like nginx `try_files $uri /index.html`)
//   * "/api/..." (prefix with the trailing slash, as combined/nginx.conf: so the SPA route /api-docs is NOT proxied) is forwarded to
//     the backend with a keep-alive agent (bounded sockets: no ephemeral-port exhaustion on Windows), streamed both ways
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".map": "application/json",
};

/**
 * @param {{ distDir: string, backendUrl: string, host: string, port: number }} o
 * @returns {Promise<http.Server>}
 */
export function startStaticServer({ distDir, backendUrl, host, port }) {
  const backend = new URL(backendUrl);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
  const root = path.resolve(distDir);
  const indexHtml = path.join(root, "index.html");

  // The whole build (a few MB) is read ONCE at start and served from memory: no file I/O on the request path (a stalled disk /
  // antivirus hook / thread pool can then not freeze the server).
  const files = new Map();
  (function load(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) load(full);
      else files.set(full, fs.readFileSync(full));
    }
  })(root);

  function sendFile(req, res, file) {
    const body = files.get(file) ?? files.get(indexHtml);
    const served = files.has(file) ? file : indexHtml;
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(served).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  function proxy(req, res) {
    const proxyReq = http.request(
      { host: backend.hostname, port: backend.port || 80, method: req.method, path: req.url, headers: { ...req.headers, host: backend.host }, agent },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on("error", () => res.destroy());
      },
    );
    proxyReq.setTimeout(60_000, () => proxyReq.destroy(new Error("backend timeout")));
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("bad gateway");
    });
    // The browser went away (navigation, page closed): drop the backend request instead of leaving it dangling.
    res.on("close", () => { if (!res.writableEnded) proxyReq.destroy(); });
    req.pipe(proxyReq);
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/api/")) return proxy(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      return res.end();
    }
    let rel;
    try {
      rel = decodeURIComponent(url.split("?")[0].split("#")[0]);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const file = path.resolve(root, "." + path.posix.normalize("/" + rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    sendFile(req, res, rel === "/" ? indexHtml : file);
  });
  // Event-loop heartbeat: if THIS process ever stalls (as opposed to the network around it), it says so in .tmp/server-lag.log.
  const lagLog = path.join(path.dirname(root), "server-lag.log");
  let last = Date.now();
  const hb = setInterval(() => {
    const now = Date.now();
    if (now - last > 1500) fs.appendFile(lagLog, `${new Date(now).toISOString()} event loop was blocked ${now - last - 250} ms (connections now: ${connCount})
`, () => {});
    last = now;
  }, 250);
  hb.unref();
  let connCount = 0;
  server.on("connection", (sock) => { connCount++; sock.on("close", () => { connCount--; }); });
  server.on("close", () => clearInterval(hb));
  void monitorEventLoopDelay;
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => resolve(server));
  });
}
