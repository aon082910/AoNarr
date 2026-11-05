import { useEffect, useRef } from "react";
// The ?url suffix makes Vite copy these into the build output and hand back the final asset URL,
// instead of trying to parse the large UMD bundle as an ES module.
import swaggerCssUrl from "swagger-ui-dist/swagger-ui.css?url";
import swaggerBundleUrl from "swagger-ui-dist/swagger-ui-bundle.js?url";
import swaggerPresetUrl from "swagger-ui-dist/swagger-ui-standalone-preset.js?url";
import { getApiKey, getSessionToken, UI_REQUEST_HEADERS } from "../api/client.js";
import { withBase } from "../utils/urlBase.js";

declare global {
  interface Window {
    SwaggerUIBundle?: any;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}

function loadStylesheet(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

/**
 * Self-hosted Swagger UI (no external CDN) against GET /api/openapi.json, which the server generates from
 * every route it has registered (about 400 operations, in a group per resource). The admin API key already
 * in localStorage is attached to every "Try it out" request so it works without re-entering it.
 */
export default function ApiDocs() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadStylesheet(swaggerCssUrl);
    Promise.all([loadScript(swaggerBundleUrl), loadScript(swaggerPresetUrl)]).then(() => {
      if (cancelled || !window.SwaggerUIBundle || !containerRef.current) return;
      window.SwaggerUIBundle({
        url: withBase("/api/openapi.json"),
        domNode: containerRef.current,
        presets: [window.SwaggerUIBundle.presets.apis],
        // With this many operations nothing is opened until asked for, and a filter box finds one by name or path.
        docExpansion: "none",
        defaultModelsExpandDepth: -1,
        filter: true,
        requestInterceptor: (req: any) => {
          // Many operations have no request body, so Swagger sends them without a Content-Type;
          // with Authentication disabled this header is all that keeps them from looking like a
          // cross-site form post to the server.
          req.headers = Object.assign(req.headers ?? {}, UI_REQUEST_HEADERS);
          // Whichever credential the current session actually used — the raw admin API key, or a
          // session token from a normal logged-in admin account — since only one of the two is
          // ever populated at a time (setApiKey/setSessionToken each clear the other).
          const key = getApiKey();
          const token = getSessionToken();
          if (key) req.headers["X-Api-Key"] = key;
          if (token) req.headers["X-Session-Token"] = token;
          return req;
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <h1>API Docs</h1>
      <p style={{ color: "var(--muted)" }}>
        Every route the server answers under <code>/api</code>, generated from the routes themselves and
        grouped by resource. The core resources (media, search and grab, the queue, indexers, download
        clients, requests, root folders, quality profiles) carry notes on what they take and return; the
        rest lists the method, path, parameters and who may call it. "Try it out" uses your admin API key
        automatically.
      </p>
      <div ref={containerRef} style={{ background: "#fff", borderRadius: 8, overflow: "hidden" }} />
    </div>
  );
}
