import { useEffect, useRef } from "react";
// The ?url suffix makes Vite copy these into the build output and hand back the final asset URL,
// instead of trying to parse the large UMD bundle as an ES module.
import swaggerCssUrl from "swagger-ui-dist/swagger-ui.css?url";
import swaggerBundleUrl from "swagger-ui-dist/swagger-ui-bundle.js?url";
import swaggerPresetUrl from "swagger-ui-dist/swagger-ui-standalone-preset.js?url";
import { getApiKey } from "../api/client.js";

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
 * Self-hosted Swagger UI (no external CDN) against GET /api/openapi.json — covers the core
 * resources for anyone scripting against AoNarr directly, not every single admin-settings route.
 * The admin API key already in localStorage is attached to every "Try it out" request so it works
 * without re-entering it.
 */
export default function ApiDocs() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadStylesheet(swaggerCssUrl);
    Promise.all([loadScript(swaggerBundleUrl), loadScript(swaggerPresetUrl)]).then(() => {
      if (cancelled || !window.SwaggerUIBundle || !containerRef.current) return;
      window.SwaggerUIBundle({
        url: "/api/openapi.json",
        domNode: containerRef.current,
        presets: [window.SwaggerUIBundle.presets.apis],
        requestInterceptor: (req: any) => {
          const key = getApiKey();
          if (key) req.headers["X-Api-Key"] = key;
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
        Covers the core resources — media, search/grab, queue, indexers, download clients,
        requests, root folders, quality profiles. Not every admin-settings route is documented
        here; see the server source under <code>src/routes</code> for the complete list. "Try it
        out" uses your admin API key automatically.
      </p>
      <div ref={containerRef} style={{ background: "#fff", borderRadius: 8, overflow: "hidden" }} />
    </div>
  );
}
