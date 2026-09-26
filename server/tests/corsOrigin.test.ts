import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let getSetting: (key: string) => string | null;
let setSetting: (key: string, value: string) => void;

const EVIL = "https://evil.example";

/** A POST any page can send cross-site without a preflight (no body, so no Content-Type). With
 * Authentication disabled it gets its ticket (200) unless the cross-origin guard refuses it (403). */
const simplePost = (headers: Record<string, string>) => request(app).post("/api/auth/stream-ticket").set(headers);

const csvUpload = (headers: Record<string, string>) =>
  request(app).post("/api/media/bulk-import.csv").set(headers).attach("file", Buffer.from("id,monitored\n999999,1\n"), "items.csv");

describe("cross-origin requests", () => {
  beforeAll(async () => {
    ({ app, apiKey } = await setupTestDb());
    ({ getSetting, setSetting } = await import("../src/services/settingsStore.js"));
  });

  afterEach(() => {
    setSetting("corsAllowedOrigins", "");
    setSetting("authRequired", "1");
    delete process.env.AONARR_CORS_ALLOWED_ORIGINS;
  });

  it("doesn't let a foreign origin read responses by default", async () => {
    const res = await request(app).get("/api/settings").set("X-Api-Key", apiKey).set("Origin", EVIL);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("doesn't approve a foreign origin's preflight", async () => {
    const res = await request(app)
      .options("/api/settings/authRequired")
      .set("Origin", EVIL)
      .set("Access-Control-Request-Method", "PUT")
      .set("Access-Control-Request-Headers", "content-type, x-api-key");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses preflight-free state-changing requests from a foreign origin, with Authentication disabled", async () => {
    setSetting("authRequired", "0");

    expect((await simplePost({ Origin: EVIL })).status).toBe(403);
    // A plain form/text POST is sent cross-site without any preflight, so CORS headers alone can't stop it.
    for (const contentType of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "Multipart/Form-Data; boundary=x"]) {
      const formPost = await request(app)
        .post("/api/settings/api-key/regenerate")
        .set("Origin", "http://192.168.1.50:8080")
        .set("Content-Type", contentType)
        .send("x");
      expect(formPost.status).toBe(403);
      expect(formPost.body.error).toBe(
        "Cross-origin request from http://192.168.1.50:8080 refused — allow that origin under Settings → Allowed CORS origins, " +
          "or in the AONARR_CORS_ALLOWED_ORIGINS environment variable (comma-separated)"
      );
    }
    expect(getSetting("apiKey")).toBe(apiKey);
    // Reads still aren't blocked outright, but the page can't see the response.
    const read = await request(app).get("/api/settings").set("Origin", EVIL);
    expect(read.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses an opaque null origin (sandboxed frame, file:// page)", async () => {
    setSetting("authRequired", "0");

    expect((await simplePost({ Origin: "null" })).status).toBe(403);
    // A request with a credential header needs a preflight first, and that isn't approved.
    const preflight = await request(app)
      .options("/api/auth/stream-ticket")
      .set("Origin", "null")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "x-api-key");
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    const withKey = await request(app).post("/api/auth/stream-ticket").set("X-Api-Key", apiKey).set("Origin", "null");
    expect(withKey.headers["access-control-allow-origin"]).toBeUndefined();

    // '*' covers every http(s) origin, not opaque ones.
    setSetting("corsAllowedOrigins", "*");
    expect((await simplePost({ Origin: "null" })).status).toBe(403);
  });

  // The UI's requests all carry Content-Type: application/json, a credential header or
  // X-Requested-With (web/src/api/client.ts), so a foreign page could only send them after a
  // preflight — which isn't approved. The guard leaves them alone however a proxy rewrites Host.
  describe("the bundled web UI's own requests", () => {
    const behindProxy = { Host: "nas:9876", Origin: "http://aonarr.lan" };

    it("reach their route behind a proxy that rewrites Host, while a text/plain POST from there is still refused", async () => {
      const login = await request(app).post("/api/auth/login").set(behindProxy).send({ username: "nobody", password: "wrong-password" });
      expect(login.status).toBe(401);
      expect(login.headers["access-control-allow-origin"]).toBeUndefined();

      const ticket = await request(app).post("/api/auth/stream-ticket").set(behindProxy).set("X-Api-Key", apiKey);
      expect(ticket.status).toBe(200);

      setSetting("authRequired", "0");
      const regenerate = await request(app)
        .post("/api/settings/api-key/regenerate")
        .set(behindProxy)
        .set("Content-Type", "text/plain")
        .send("x");
      expect(regenerate.status).toBe(403);
      expect(getSetting("apiKey")).toBe(apiKey);
    });

    it("let a multipart upload through with Authentication disabled when it carries X-Requested-With", async () => {
      setSetting("authRequired", "0");

      const fromUi = await csvUpload({ ...behindProxy, "X-Requested-With": "AoNarr" });
      expect(fromUi.status).toBe(200);
      expect(fromUi.body).toEqual({ updated: 0, skipped: 1 });

      const bare = await csvUpload(behindProxy);
      expect(bare.status).toBe(403);
    });

    it("let the API Docs page's body-less Try-it-out POSTs through with Authentication disabled", async () => {
      setSetting("authRequired", "0");

      // Swagger UI sends no Content-Type for an operation without a request body.
      const fromUi = await simplePost({ ...behindProxy, "X-Requested-With": "AoNarr" });
      expect(fromUi.status).toBe(200);
      expect(fromUi.headers["access-control-allow-origin"]).toBeUndefined();

      expect((await simplePost(behindProxy)).status).toBe(403);
    });

    it("pass the Vite dev server's proxy, which rewrites Host, when the page was opened by LAN address", async () => {
      const viteLan = { Host: "localhost:8989", Origin: "http://192.168.1.5:5173" };

      const login = await request(app).post("/api/auth/login").set(viteLan).send({ username: "nobody", password: "wrong-password" });
      expect(login.status).toBe(401);

      setSetting("authRequired", "0");
      // A body-less POST still says application/json.
      const ticket = await request(app).post("/api/auth/stream-ticket").set(viteLan).set("Content-Type", "application/json");
      expect(ticket.status).toBe(200);
      expect(ticket.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  describe("pages the browser vouches for with Sec-Fetch-Site", () => {
    it("accepts same-origin and user-initiated requests whatever the Host", async () => {
      setSetting("authRequired", "0");
      const viteLocal = { Host: "localhost:8989", Origin: "http://localhost:5173" };

      const sameOrigin = await simplePost({ ...viteLocal, "Sec-Fetch-Site": "same-origin" });
      expect(sameOrigin.status).toBe(200);
      expect(sameOrigin.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect((await simplePost({ ...viteLocal, "Sec-Fetch-Site": "none" })).status).toBe(200);
    });

    it("falls back to comparing Origin with the host for any other value, rather than refusing outright", async () => {
      setSetting("authRequired", "0");

      expect((await simplePost({ Host: "nas.lan:9876", Origin: "http://nas.lan:9876", "Sec-Fetch-Site": "cross-site" })).status).toBe(200);
      expect((await simplePost({ Host: "nas.lan:9876", Origin: "http://nas.lan:8080", "Sec-Fetch-Site": "same-site" })).status).toBe(403);
    });
  });

  // Browsers send Sec-Fetch-Site only to HTTPS and localhost URLs, so on a plain-HTTP LAN install
  // (http://nas.lan:9876) every preflight-free request is judged by Origin against the host alone.
  describe("plain-HTTP deployments (no Sec-Fetch-Site)", () => {
    const ticketFrom = (host: string, origin: string) => simplePost({ Host: host, Origin: origin });

    it("refuses another app on the same host but a different port, with or without a port in Host", async () => {
      setSetting("authRequired", "0");

      for (const host of ["nas.lan:9876", "nas.lan"]) {
        const sameHostOtherPort = { Host: host, Origin: "http://nas.lan:8080" };

        const read = await request(app).get("/api/settings").set(sameHostOtherPort);
        expect(read.headers["access-control-allow-origin"]).toBeUndefined();

        const formPost = await request(app)
          .post("/api/settings/api-key/regenerate")
          .set(sameHostOtherPort)
          .set("Content-Type", "text/plain")
          .send("x");
        expect(formPost.status).toBe(403);
        expect(getSetting("apiKey")).toBe(apiKey);
      }

      // Listing it is still how a dashboard on another port gets access.
      setSetting("corsAllowedOrigins", "http://nas.lan:8080");
      const listed = await ticketFrom("nas.lan:9876", "http://nas.lan:8080");
      expect(listed.status).toBe(200);
    });

    it("accepts the host:port the browser used, as the bundled nginx forwards it", async () => {
      setSetting("authRequired", "0");
      const res = await ticketFrom("nas.lan:9876", "http://nas.lan:9876");

      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("http://nas.lan:9876");
    });

    it("reads a Host without a port as the scheme's default port, not as any port", async () => {
      setSetting("authRequired", "0");

      expect((await ticketFrom("nas.lan", "http://nas.lan")).status).toBe(200);
      expect((await ticketFrom("nas.lan", "https://nas.lan")).status).toBe(200);
      expect((await ticketFrom("nas.lan", "http://nas.lan:8080")).status).toBe(403);
      expect((await ticketFrom("nas.lan", "http://nas.lan:9876")).status).toBe(403);
      // Default ports are the same origin whether or not they're spelled out.
      expect((await ticketFrom("nas.lan:80", "http://nas.lan")).status).toBe(200);
      expect((await ticketFrom("nas.lan:443", "https://nas.lan")).status).toBe(200);
      expect((await ticketFrom("nas.lan:443", "http://nas.lan")).status).toBe(403);
    });
  });

  describe("reverse proxies' X-Forwarded-* headers", () => {
    it("matches the public host a reverse proxy passes on in X-Forwarded-Host", async () => {
      setSetting("authRequired", "0");
      const res = await simplePost({ Host: "aonarr-server:8989", "X-Forwarded-Host": "media.example.com", Origin: "https://media.example.com" });

      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("https://media.example.com");
    });

    it("takes the scheme from X-Forwarded-Proto and the port from X-Forwarded-Port", async () => {
      setSetting("authRequired", "0");
      const via = (forwarded: Record<string, string>, origin: string) =>
        simplePost({ Host: "aonarr-server:8989", ...forwarded, Origin: origin }).then((res) => res.status);

      const plainHttpOnPort = { "X-Forwarded-Host": "nas.lan", "X-Forwarded-Proto": "http", "X-Forwarded-Port": "9876" };
      expect(await via(plainHttpOnPort, "http://nas.lan:9876")).toBe(200);
      expect(await via(plainHttpOnPort, "http://nas.lan:8080")).toBe(403);
      expect(await via(plainHttpOnPort, "http://nas.lan")).toBe(403);

      const https = { "X-Forwarded-Host": "media.example.com", "X-Forwarded-Proto": "https" };
      expect(await via(https, "https://media.example.com")).toBe(200);
      expect(await via(https, "http://media.example.com")).toBe(403);
      expect(await via({ ...https, "X-Forwarded-Port": "443" }, "https://media.example.com")).toBe(200);

      // A port in X-Forwarded-Host itself wins over X-Forwarded-Port.
      expect(await via({ ...https, "X-Forwarded-Host": "media.example.com:8443", "X-Forwarded-Port": "443" }, "https://media.example.com:8443")).toBe(200);
    });

    it("compares only the first X-Forwarded-* entries, not later ones", async () => {
      setSetting("authRequired", "0");
      const via = (origin: string) =>
        simplePost({
          Host: "aonarr-server:8989",
          "X-Forwarded-Host": "media.example.com, nas.lan:8080",
          "X-Forwarded-Proto": "https, http",
          Origin: origin,
        }).then((res) => res.status);

      expect(await via("https://media.example.com")).toBe(200);
      expect(await via("http://nas.lan:8080")).toBe(403);
      expect(await via("http://media.example.com")).toBe(403);
    });

    it("still accepts the Host the request reached", async () => {
      setSetting("authRequired", "0");
      const res = await simplePost({ Host: "nas.lan:9876", "X-Forwarded-Host": "media.example.com", Origin: "http://nas.lan:9876" });

      expect(res.status).toBe(200);
    });
  });

  it("allows requests that carry no Origin at all (scripts, server-to-server webhooks)", async () => {
    expect((await request(app).post("/api/auth/stream-ticket").set("X-Api-Key", apiKey).set("Host", "nas:9876")).status).toBe(200);
    setSetting("authRequired", "0");
    expect((await simplePost({ Host: "nas:9876" })).status).toBe(200);
  });

  it("allows the origins listed in corsAllowedOrigins, and every origin for *", async () => {
    setSetting("authRequired", "0");
    setSetting("corsAllowedOrigins", "https://dash.example.com/, https://other.example");

    const listed = await simplePost({ Origin: "https://dash.example.com" });
    expect(listed.status).toBe(200);
    expect(listed.headers["access-control-allow-origin"]).toBe("https://dash.example.com");
    const listedRead = await request(app).get("/api/settings").set("Origin", "https://other.example");
    expect(listedRead.headers["access-control-allow-origin"]).toBe("https://other.example");
    expect((await simplePost({ Origin: EVIL })).status).toBe(403);

    setSetting("corsAllowedOrigins", "*");
    const any = await simplePost({ Origin: EVIL });
    expect(any.status).toBe(200);
    expect(any.headers["access-control-allow-origin"]).toBe(EVIL);
  });

  it("adds the origins in AONARR_CORS_ALLOWED_ORIGINS to the ones in Settings", async () => {
    setSetting("authRequired", "0");
    setSetting("corsAllowedOrigins", "https://dash.example.com");
    process.env.AONARR_CORS_ALLOWED_ORIGINS = " https://other.example , http://homarr.lan:7575/ ";

    const fromEnv = await simplePost({ Origin: "http://homarr.lan:7575" });
    expect(fromEnv.status).toBe(200);
    expect(fromEnv.headers["access-control-allow-origin"]).toBe("http://homarr.lan:7575");
    expect((await simplePost({ Origin: "https://dash.example.com" })).status).toBe(200);
    expect((await simplePost({ Origin: EVIL })).status).toBe(403);

    process.env.AONARR_CORS_ALLOWED_ORIGINS = "*";
    expect((await simplePost({ Origin: EVIL })).status).toBe(200);
  });
});
