import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import { appUrl, appUrlBase, appUrlBaseIsInvalid, artworkUrlForClient, normalizeAppUrlBase, withAppUrlBase } from "../src/services/urlBase.js";

// Round 30e (audit ST23): AoNarr can be served under a sub-path (URL_BASE=/aonarr). nginx cuts the prefix off, so the
// routes stay where they are; what the server itself hands to a client has to carry it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The same table runs against the server helper, the web helper and web/url-base.sh. A value that is not a path
 * (the second table) reads as no base in the two helpers and stops the container in the script. */
const VALID: [string | undefined | null, string][] = [
  [undefined, ""],
  [null, ""],
  ["", ""],
  ["/", ""],
  ["//", ""],
  ["   ", ""],
  ["aonarr", "/aonarr"],
  ["/aonarr", "/aonarr"],
  ["/aonarr/", "/aonarr"],
  ["//aonarr", "/aonarr"],
  ["aonarr/", "/aonarr"],
  [" /aonarr/ ", "/aonarr"],
  ["/a/b", "/a/b"],
  ["a//b/", "/a/b"],
  ["/media-apps/aonarr_2", "/media-apps/aonarr_2"],
  ["/v1.2/aonarr", "/v1.2/aonarr"],
  ["/~me/aonarr", "/~me/aonarr"],
];
const INVALID = ["/a b", "/a?b", "/a#b", "/a:b", "/..", "/a/../b", "/./a", ".", "/a%2Fb", "/ä", "\\aonarr", "/a;b", "/a'b", "/a\"b", "/a$b"];

/** External URL -> the link for "/api/x" with URL_BASE=/aonarr, in the server helper (appUrl) and the web helper
 * (linkOnOrigin). The base is added unless the URL's PATH already ends with it; a host name that reads like the
 * base ("http://aonarr") is not a path (review finding L1). */
const ORIGIN_LINKS: [string, string][] = [
  ["", "/aonarr/api/x"],
  ["https://media.example.com", "https://media.example.com/aonarr/api/x"],
  ["http://aonarr", "http://aonarr/aonarr/api/x"],
  ["http://aonarr/", "http://aonarr/aonarr/api/x"],
  ["http://aonarr:9876", "http://aonarr:9876/aonarr/api/x"],
  ["HTTPS://AONARR", "HTTPS://AONARR/aonarr/api/x"],
  ["//aonarr", "//aonarr/aonarr/api/x"],
  ["//aonarr/aonarr", "//aonarr/aonarr/api/x"],
  ["http://aonarr/aonarr", "http://aonarr/aonarr/api/x"],
  ["http://aonarr/aonarr/", "http://aonarr/aonarr/api/x"],
  ["https://h.example:8443/aonarr", "https://h.example:8443/aonarr/api/x"],
  ["https://h.example/x/aonarr", "https://h.example/x/aonarr/api/x"],
  ["https://h.example/myaonarr", "https://h.example/myaonarr/aonarr/api/x"],
  ["https://h.example/aonarr/extra", "https://h.example/aonarr/extra/aonarr/api/x"],
  ["/aonarr", "/aonarr/api/x"],
];

afterEach(() => {
  delete process.env.URL_BASE;
});

describe("normalizeAppUrlBase / appUrlBase", () => {
  it.each(VALID)("%j reads as %j", (raw, expected) => {
    expect(normalizeAppUrlBase(raw)).toBe(expected);
    expect(appUrlBaseIsInvalid(raw)).toBe(false);
  });

  it.each(INVALID)("%j is not a usable path: no base, and flagged", (raw) => {
    expect(normalizeAppUrlBase(raw)).toBe("");
    expect(appUrlBaseIsInvalid(raw)).toBe(true);
  });

  it("reads the environment on each call", () => {
    expect(appUrlBase()).toBe("");
    process.env.URL_BASE = "aonarr/";
    expect(appUrlBase()).toBe("/aonarr");
    process.env.URL_BASE = "/other";
    expect(appUrlBase()).toBe("/other");
  });
});

describe("links built on the URL base", () => {
  it("withAppUrlBase prefixes a root-relative path only, and only when a base is set", () => {
    expect(withAppUrlBase("/api/opds")).toBe("/api/opds");
    process.env.URL_BASE = "/aonarr";
    expect(withAppUrlBase("/api/opds?token=x")).toBe("/aonarr/api/opds?token=x");
    expect(withAppUrlBase("/")).toBe("/aonarr/");
    expect(withAppUrlBase("https://example.com/api")).toBe("https://example.com/api");
    expect(withAppUrlBase("//cdn.example.com/x")).toBe("//cdn.example.com/x");
    expect(withAppUrlBase("relative/path")).toBe("relative/path");
  });

  it("appUrl puts the base between an origin and the path, unless the origin already ends with it", () => {
    expect(appUrl("https://h.example", "/api/x")).toBe("https://h.example/api/x");
    expect(appUrl("https://h.example/", "/api/x")).toBe("https://h.example//api/x"); // no base: untouched, as before
    process.env.URL_BASE = "/aonarr";
    expect(appUrl("", "/api/x")).toBe("/aonarr/api/x");
    expect(appUrl("https://h.example", "/api/x")).toBe("https://h.example/aonarr/api/x");
    expect(appUrl("https://h.example/", "/api/x")).toBe("https://h.example/aonarr/api/x");
    expect(appUrl("https://h.example:8443/aonarr", "/api/x")).toBe("https://h.example:8443/aonarr/api/x");
    expect(appUrl("https://h.example/aonarr/", "/api/x")).toBe("https://h.example/aonarr/api/x");
    expect(appUrl("https://h.example", "")).toBe("https://h.example/aonarr");
  });

  it.each(ORIGIN_LINKS)("appUrl(%j) -> %j: the base is judged by the URL's path, not by the end of the string (L1)", (origin, expected) => {
    process.env.URL_BASE = "/aonarr";
    expect(appUrl(origin, "/api/x")).toBe(expected);
  });

  it("appUrl: a two-segment base is judged the same way", () => {
    process.env.URL_BASE = "/media/aonarr";
    expect(appUrl("http://aonarr", "/api/x")).toBe("http://aonarr/media/aonarr/api/x");
    expect(appUrl("http://nas/media/aonarr", "/api/x")).toBe("http://nas/media/aonarr/api/x");
    expect(appUrl("http://nas/aonarr", "/api/x")).toBe("http://nas/aonarr/media/aonarr/api/x");
  });

  it("artworkUrlForClient prefixes AoNarr's own artwork paths and nothing else", () => {
    process.env.URL_BASE = "/aonarr";
    expect(artworkUrlForClient("/api/media/local-artwork/abc_DEF-123")).toBe("/aonarr/api/media/local-artwork/abc_DEF-123");
    expect(artworkUrlForClient("/api/remote-instances/7/local-artwork/tok")).toBe("/aonarr/api/remote-instances/7/local-artwork/tok");
    expect(artworkUrlForClient("https://image.tmdb.org/t/p/w500/x.jpg")).toBe("https://image.tmdb.org/t/p/w500/x.jpg");
    expect(artworkUrlForClient("/api/media/5/anything")).toBe("/api/media/5/anything");
    expect(artworkUrlForClient("/api/media/local-artwork/tok/extra")).toBe("/api/media/local-artwork/tok/extra");
    delete process.env.URL_BASE;
    expect(artworkUrlForClient("/api/media/local-artwork/abc")).toBe("/api/media/local-artwork/abc");
  });
});

describe("the web helper (web/src/utils/urlBase.ts)", () => {
  async function loadWebHelper(base: string | undefined) {
    vi.resetModules();
    (globalThis as any).window = { __AONARR_BASE__: base, location: { origin: "http://nas:9876" } };
    return import("../../web/src/utils/urlBase.js");
  }
  afterAll(() => {
    delete (globalThis as any).window;
  });

  it.each(VALID.filter(([raw]) => typeof raw === "string" || raw === undefined))("normalises %j to %j, like the server", async (raw, expected) => {
    const web = await loadWebHelper(undefined);
    expect(web.normalizeAppUrlBase(raw)).toBe(expected);
  });

  it.each(INVALID)("treats %j as no base, like the server", async (raw) => {
    const web = await loadWebHelper(undefined);
    expect(web.normalizeAppUrlBase(raw)).toBe("");
  });

  it("without a base every helper hands its argument back untouched", async () => {
    const web = await loadWebHelper(undefined);
    expect(web.URL_BASE).toBe("");
    expect(web.withBase("/api/health")).toBe("/api/health");
    expect(web.withBase("/")).toBe("/");
    expect(web.absoluteUrl("/api/mcp")).toBe("http://nas:9876/api/mcp");
    expect(web.linkOnOrigin("https://h.example/", "/share/t")).toBe("https://h.example//share/t");
    expect(web.reviveAppUrls).toBeUndefined();
    expect(web.stripAppUrls).toBeUndefined();
    expect(JSON.parse('{"posterUrl":"/api/media/local-artwork/t"}', web.reviveAppUrls)).toEqual({ posterUrl: "/api/media/local-artwork/t" });
  });

  it("with a base: withBase, absoluteUrl, linkOnOrigin", async () => {
    const web = await loadWebHelper("/aonarr");
    expect(web.URL_BASE).toBe("/aonarr");
    expect(web.withBase("/api/health")).toBe("/aonarr/api/health");
    expect(web.withBase("/")).toBe("/aonarr/");
    expect(web.withBase("/icon.svg")).toBe("/aonarr/icon.svg");
    expect(web.withBase("https://x.example/y")).toBe("https://x.example/y");
    expect(web.withBase("//cdn/y")).toBe("//cdn/y");
    expect(web.absoluteUrl("/api/webhooks/overseerr?token=t")).toBe("http://nas:9876/aonarr/api/webhooks/overseerr?token=t");
    expect(web.linkOnOrigin("https://h.example", "/share/t")).toBe("https://h.example/aonarr/share/t");
    expect(web.linkOnOrigin("https://h.example/aonarr/", "/share/t")).toBe("https://h.example/aonarr/share/t");
  });

  it.each(ORIGIN_LINKS)("with a base: linkOnOrigin(%j) -> %j, the same table as the server's appUrl (L1)", async (origin, expected) => {
    const web = await loadWebHelper("/aonarr");
    expect(web.linkOnOrigin(origin, "/api/x")).toBe(expected);
  });

  it("with a base: artwork URLs get the prefix coming in and lose it going out, nothing else changes", async () => {
    const web = await loadWebHelper("aonarr/");
    const incoming = '{"posterUrl":"/api/media/local-artwork/tok_1","backdropUrl":"https://image.tmdb.org/x.jpg","overview":"/api/media/local-artwork/tok_1 is text","relay":"/api/remote-instances/3/local-artwork/zz","n":[1,"/api/health"]}';
    const parsed = JSON.parse(incoming, web.reviveAppUrls);
    expect(parsed.posterUrl).toBe("/aonarr/api/media/local-artwork/tok_1");
    expect(parsed.relay).toBe("/aonarr/api/remote-instances/3/local-artwork/zz");
    expect(parsed.backdropUrl).toBe("https://image.tmdb.org/x.jpg");
    expect(parsed.overview).toBe("/api/media/local-artwork/tok_1 is text");
    expect(parsed.n).toEqual([1, "/api/health"]);
    // Sent back unchanged, the stored value is exactly what the server had.
    expect(JSON.parse(JSON.stringify(parsed, web.stripAppUrls))).toEqual(JSON.parse(incoming));
  });
});

describe("web/url-base.sh (the container start-up step)", () => {
  const script = path.join(repoRoot, "web", "url-base.sh");
  const haveSh = process.platform !== "win32" && spawnSync("sh", ["-c", "command -v sed && command -v grep"]).status === 0;
  const suite = haveSh ? describe : describe.skip;

  suite("with a real nginx config and web root", () => {
    let dir: string;
    const conf = () => path.join(dir, "default.conf");
    const root = () => path.join(dir, "html");
    const state = () => path.join(dir, "state");

    function prepare(configFile: string) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-urlbase-"));
      fs.copyFileSync(path.join(repoRoot, configFile), conf());
      fs.mkdirSync(path.join(root(), "assets"), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, "web", "index.html"), path.join(root(), "index.html"));
      // What Vite writes: the entry and its stylesheet, with root-absolute addresses.
      fs.writeFileSync(
        path.join(root(), "index.html"),
        fs.readFileSync(path.join(root(), "index.html"), "utf-8").replace(
          '<script type="module" src="/src/main.tsx"></script>',
          '<script type="module" crossorigin src="/assets/index-AbC123.js"></script>\n    <link rel="stylesheet" crossorigin href="/assets/index-DeF456.css">'
        )
      );
      fs.copyFileSync(path.join(repoRoot, "web", "public", "manifest.json"), path.join(root(), "manifest.json"));
    }

    function run(urlBase: string | undefined) {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, AONARR_URL_BASE_STATE: state() };
      if (urlBase !== undefined) env.URL_BASE = urlBase;
      return spawnSync("sh", [script, conf(), root()], { env, encoding: "utf-8" });
    }
    const snapshot = () => ({
      conf: fs.readFileSync(conf(), "utf-8"),
      index: fs.readFileSync(path.join(root(), "index.html"), "utf-8"),
      manifest: fs.readFileSync(path.join(root(), "manifest.json"), "utf-8"),
      baseConfig: fs.existsSync(path.join(root(), "base-config.js")) ? fs.readFileSync(path.join(root(), "base-config.js"), "utf-8") : null,
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    for (const configFile of ["combined/nginx.conf", "web/nginx.conf.template"]) {
      describe(configFile, () => {
        it("does nothing at all without a base: no file changes, no state directory", () => {
          prepare(configFile);
          const before = snapshot();
          for (const value of [undefined, "", "/", "  //  "]) {
            const res = run(value);
            expect(res.status, res.stderr).toBe(0);
            expect(snapshot()).toEqual(before);
            expect(fs.existsSync(state())).toBe(false);
          }
        });

        it("serves under the base: prefixed index.html and manifest, base-config.js, nginx blocks", () => {
          prepare(configFile);
          const before = snapshot();
          const res = run("/aonarr");
          expect(res.status, res.stderr).toBe(0);
          const after = snapshot();
          expect(after.baseConfig).toBe('window.__AONARR_BASE__ = "/aonarr";\n');
          expect(after.index).toContain('<link rel="manifest" href="/aonarr/manifest.json" />');
          expect(after.index).toContain('<link rel="icon" href="/aonarr/icon.svg" type="image/svg+xml" />');
          expect(after.index).toContain('<script src="/aonarr/theme-init.js"></script>');
          expect(after.index).toContain('src="/aonarr/assets/index-AbC123.js"');
          expect(after.index).toContain('href="/aonarr/assets/index-DeF456.css"');
          expect(after.index).toContain('<script src="/aonarr/base-config.js"></script>');
          expect(after.index).not.toMatch(/(?:href|src)="\/(?!aonarr\/)/);
          const manifest = JSON.parse(after.manifest);
          expect(manifest.start_url).toBe("/aonarr/");
          expect(manifest.scope).toBe("/aonarr/");
          expect(manifest.icons.map((i: { src: string }) => i.src)).toEqual(["/aonarr/icon.svg", "/aonarr/icon.svg"]);
          expect(after.conf).toContain("rewrite ^/aonarr/(.*)$ /$1 break;");
          expect(after.conf).toContain('if ($request_uri !~ "^/aonarr/") { rewrite ^ /__aonarr_outside last; }');
          expect(after.conf.match(/AONARR-URL-BASE-BEGIN/g)).toHaveLength(2);
          expect(fs.readFileSync(path.join(state(), "base"), "utf-8")).toBe("/aonarr");
          // Only lines were added: every line the original config had is still there, in the same order.
          const patched = after.conf.split("\n");
          let at = 0;
          for (const line of before.conf.split("\n")) {
            at = patched.indexOf(line, at);
            expect(at, line).toBeGreaterThanOrEqual(0);
            at++;
          }
        });

        it("a second start with the same base changes nothing, whatever spelling it uses", () => {
          prepare(configFile);
          run("/aonarr");
          const first = snapshot();
          for (const value of ["/aonarr", "aonarr/", "//aonarr", " /aonarr/ "]) {
            const res = run(value);
            expect(res.status, res.stderr).toBe(0);
            expect(snapshot()).toEqual(first);
          }
        });

        it("another base replaces the first one completely; no base puts every file back byte for byte", () => {
          prepare(configFile);
          const original = snapshot();
          run("/aonarr");
          const res = run("/x.y/z");
          expect(res.status, res.stderr).toBe(0);
          const other = snapshot();
          expect(other.baseConfig).toContain('"/x.y/z"');
          expect(other.index).toContain('src="/x.y/z/assets/index-AbC123.js"');
          expect(other.index).not.toContain("/aonarr");
          expect(other.manifest).not.toContain("/aonarr");
          // The dot in the base is escaped where nginx reads it as a pattern.
          expect(other.conf).toContain("rewrite ^/x\\.y/z/(.*)$ /$1 break;");
          expect(other.conf).not.toContain("/aonarr/");
          expect(other.conf.match(/AONARR-URL-BASE-BEGIN/g)).toHaveLength(2);

          expect(run(undefined).status).toBe(0);
          expect(snapshot()).toEqual(original);
          expect(fs.existsSync(state())).toBe(false);
          expect(run("").status).toBe(0);
          expect(snapshot()).toEqual(original);
        });

        it("a re-rendered config (the web image renders its template again at every start) gets one fresh block", () => {
          prepare(configFile);
          const rendered = fs.readFileSync(conf(), "utf-8");
          run("/aonarr");
          const first = snapshot();
          fs.writeFileSync(conf(), rendered);
          expect(run("/aonarr").status).toBe(0);
          expect(snapshot()).toEqual(first);
        });

        /** What an image upgrade puts in the web root: a new build (new asset hashes), no base-config.js, and the
         * stock script's freshly rendered config. The state directory is the only thing that survives. */
        function upgradeTo(rendered: string, built: { index: string; manifest: string }) {
          const newIndex = built.index.replace("index-AbC123.js", "index-ZZ9999.js").replace("index-DeF456.css", "index-YY8888.css");
          const newManifest = built.manifest.replace('"short_name": "AoNarr"', '"short_name": "AoNarr 2"');
          expect(newIndex).not.toBe(built.index);
          expect(newManifest).not.toBe(built.manifest);
          fs.writeFileSync(path.join(root(), "index.html"), newIndex);
          fs.writeFileSync(path.join(root(), "manifest.json"), newManifest);
          fs.rmSync(path.join(root(), "base-config.js"), { force: true });
          fs.writeFileSync(conf(), rendered);
          return { newIndex, newManifest };
        }

        it("a state directory that outlived the container never brings an older build back (L3): no base after an upgrade", () => {
          prepare(configFile);
          const built = snapshot();
          run("/aonarr");
          const { newIndex, newManifest } = upgradeTo(built.conf, built);
          const res = run(undefined);
          expect(res.status, res.stderr).toBe(0);
          const after = snapshot();
          expect(after.index).toBe(newIndex);
          expect(after.manifest).toBe(newManifest);
          expect(after.conf).toBe(built.conf);
          expect(after.baseConfig).toBeNull();
          expect(fs.existsSync(state())).toBe(false);
        });

        it("... and with the same base after an upgrade: the new build is prefixed, then comes back byte for byte", () => {
          prepare(configFile);
          const built = snapshot();
          run("/aonarr");
          const { newIndex, newManifest } = upgradeTo(built.conf, built);
          expect(run("/aonarr").status).toBe(0);
          const prefixed = snapshot();
          expect(prefixed.index).toContain('src="/aonarr/assets/index-ZZ9999.js"');
          expect(prefixed.index).toContain('href="/aonarr/assets/index-YY8888.css"');
          expect(prefixed.index).not.toContain("AbC123");
          expect(prefixed.index).not.toContain("DeF456");
          expect(prefixed.index).not.toContain("/aonarr/aonarr");
          expect(JSON.parse(prefixed.manifest).short_name).toBe("AoNarr 2");
          expect(prefixed.conf.match(/AONARR-URL-BASE-BEGIN/g)).toHaveLength(2);
          expect(run(undefined).status).toBe(0);
          const after = snapshot();
          expect(after.index).toBe(newIndex);
          expect(after.manifest).toBe(newManifest);
        });

        it("... and when only one file is new: that one is kept, the one still as written is put back", () => {
          prepare(configFile);
          const built = snapshot();
          run("/aonarr");
          const newIndex = built.index.replace("index-AbC123.js", "index-ZZ9999.js");
          fs.writeFileSync(path.join(root(), "index.html"), newIndex);
          expect(run(undefined).status).toBe(0);
          const after = snapshot();
          expect(after.index).toBe(newIndex);
          expect(after.manifest).toBe(built.manifest);
          expect(fs.existsSync(state())).toBe(false);
        });

        it("a state directory with no checksum on record (a stop between saving and rewriting) treats the file as the original", () => {
          prepare(configFile);
          const built = snapshot();
          run("/aonarr");
          const first = snapshot();
          fs.writeFileSync(path.join(root(), "index.html"), built.index);
          fs.writeFileSync(path.join(root(), "manifest.json"), built.manifest);
          fs.rmSync(path.join(state(), "sum"), { recursive: true, force: true });
          expect(run("/aonarr").status).toBe(0);
          expect(snapshot()).toEqual(first);
          expect(run(undefined).status).toBe(0);
          expect(snapshot().index).toBe(built.index);
        });

        it("the rewrite leaves no temporary file behind and keeps the files' mode", () => {
          prepare(configFile);
          fs.chmodSync(path.join(root(), "index.html"), 0o640);
          run("/aonarr");
          expect(fs.readdirSync(root()).sort()).toEqual(["assets", "base-config.js", "index.html", "manifest.json"]);
          expect(fs.statSync(path.join(root(), "index.html")).mode & 0o777).toBe(0o640);
          run(undefined);
          expect(fs.statSync(path.join(root(), "index.html")).mode & 0o777).toBe(0o640);
        });

        it("the .. guard is a map on the path part of the address: a query holding /.. is not refused (L4)", () => {
          prepare(configFile);
          expect(run("/aonarr").status).toBe(0);
          const text = snapshot().conf;
          const found = text.match(/map \$request_uri \$aonarr_dotdot \{\s*"~([^"]+)" 1;/);
          expect(found, "map $aonarr_dotdot").not.toBeNull();
          const dotdot = new RegExp(found![1]);
          for (const uri of ["/aonarr/../x", "/aonarr/%2e%2e/x", "/aonarr/.%2E/x", "/aonarr/..", "/aonarr/..?x=1", "/aonarr/a/../b", "/aonarr/%2E%2e?x", "/aonarr/a/%2e%2E"]) {
            expect(dotdot.test(uri), uri).toBe(true);
          }
          for (const uri of [
            "/aonarr/api/files?path=/media/..",
            "/aonarr/api/x?p=/a/../b",
            "/aonarr/api/x?p=%2e%2e",
            "/aonarr/api/x?a=1&b=/..",
            "/aonarr/api/files?path=..%2F",
            "/aonarr/.../x",
            "/aonarr/a..b",
            "/aonarr/x..",
            "/aonarr/..x/y",
          ]) {
            expect(dotdot.test(uri), uri).toBe(false);
          }
          expect(text).toContain("if ($aonarr_dotdot) { rewrite ^ /__aonarr_outside last; }");
          expect(text).not.toContain("if ($request_uri ~ \"(^|/)");
        });

        it.each(INVALID)("refuses %j and leaves everything as it was", (value) => {
          prepare(configFile);
          const before = snapshot();
          const res = run(value);
          expect(res.status).toBe(1);
          expect(res.stderr).toContain("URL_BASE");
          expect(snapshot()).toEqual(before);
        });

        it.each(VALID.filter(([raw]) => typeof raw === "string" && raw.trim().replace(/\//g, "") !== ""))("reads %j as %j", (raw, expected) => {
          prepare(configFile);
          const res = run(raw as string);
          expect(res.status, res.stderr).toBe(0);
          expect(fs.readFileSync(path.join(state(), "base"), "utf-8")).toBe(expected);
        });

        it("stops, with a message, when the config lost the line the block goes after", () => {
          prepare(configFile);
          fs.writeFileSync(conf(), fs.readFileSync(conf(), "utf-8").replace(/^\s*index index\.html;\s*$/m, ""));
          const res = run("/aonarr");
          expect(res.status).toBe(1);
          expect(res.stderr).toContain("index");
        });
      });
    }

  });

  it("is wired into both images: copied in, executable, called by the entrypoint, used by the health checks", () => {
    const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), "utf-8");
    expect(read("Dockerfile.combined")).toContain("COPY web/url-base.sh /usr/local/bin/aonarr-url-base");
    expect(read("Dockerfile.combined")).toMatch(/chmod \+x [^\n]*\/usr\/local\/bin\/aonarr-url-base/);
    expect(read("Dockerfile.combined")).toContain("/var/lib/aonarr-url-base/base");
    expect(read("combined/entrypoint.sh")).toContain("/usr/local/bin/aonarr-url-base /etc/nginx/conf.d/aonarr.conf /usr/share/nginx/html");
    // Before nginx starts, so the config nginx reads is the one with the base in it.
    expect(read("combined/entrypoint.sh").indexOf("aonarr-url-base")).toBeLessThan(read("combined/entrypoint.sh").indexOf("nginx -g"));
    expect(read("web/Dockerfile")).toContain("COPY url-base.sh /docker-entrypoint.d/35-aonarr-url-base.sh");
    expect(read("web/Dockerfile")).toMatch(/chmod \+x \/docker-entrypoint\.d\/35-aonarr-url-base\.sh/);
    expect(read("web/Dockerfile")).toContain("/var/lib/aonarr-url-base/base");
    // The image keeps every shell script with Unix line endings (see .gitattributes).
    expect(read(".gitattributes")).toMatch(/^\*\.sh\s+text\s+eol=lf/m);
  });

  it("the two configs still have the lines the script anchors to, exactly once each", () => {
    for (const file of ["combined/nginx.conf", "web/nginx.conf.template"]) {
      const text = fs.readFileSync(path.join(repoRoot, file), "utf-8");
      expect(text.match(/^\s*index\s+index\.html;\s*$/gm), file).toHaveLength(1);
      expect(text.match(/^log_format\s+aonarr_starr\s/gm), file).toHaveLength(1);
      expect(text, file).not.toContain("AONARR-URL-BASE");
    }
  });
});

describe("the web sources build no root-relative URL by hand", () => {
  // The web package has no test runner; this is the guard that keeps a new fetch("/api/...") or <img src="/x"> from
  // quietly breaking the URL base. Anything root-relative goes through withBase() (web/src/utils/urlBase.ts).
  const webSrc = path.join(repoRoot, "web", "src");
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }
  const patterns: [string, RegExp][] = [
    ["fetch() of a root-relative literal", /\bfetch\(\s*["'`]\//],
    ["EventSource() of a root-relative literal", /\bEventSource\(\s*["'`]\//],
    ["service worker registered at a root-relative literal", /\.register\(\s*["'`]\//],
    ["window.location.origin joined to a path", /location\.origin\s*\}?\s*[+/]/],
    ["location.href assigned a root-relative literal", /location\.href\s*=\s*["'`]\//],
    ["root-relative src or href attribute literal", /\b(?:src|href)=["']\/[^/"']/],
    ["root-relative src or href literal in braces", /\b(?:src|href)=\{\s*["'`]\/[^/]/],
    ["url: given a root-relative literal", /\burl:\s*["'`]\/[a-z]/],
  ];

  it("finds the helper file and a plausible number of sources to scan", () => {
    expect(fs.existsSync(path.join(webSrc, "utils", "urlBase.ts"))).toBe(true);
    expect(sourceFiles(webSrc).length).toBeGreaterThan(80);
  });

  it.each(patterns)("no %s", (_label, pattern) => {
    const offenders: string[] = [];
    for (const file of sourceFiles(webSrc)) {
      if (file.endsWith(path.join("utils", "urlBase.ts"))) continue;
      fs.readFileSync(file, "utf-8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (!pattern.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
          offenders.push(`${path.relative(webSrc, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe("what the server hands out under a URL base", () => {
  let app: Express;
  let apiKey: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let setSetting: (key: string, value: string) => void;
  let deleteSetting: (key: string) => void;
  const opdsToken = "opds-urlbase-token";
  const iptvToken = "iptv-urlbase-token";

  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
    ({ setSetting, deleteSetting } = await import("../src/services/settingsStore.js"));
    setSetting("opdsToken", opdsToken);
    setSetting("iptvPlaylistToken", iptvToken);
  });

  afterEach(() => {
    deleteSetting("externalUrl");
  });

  async function feed(url: string, host?: string): Promise<string> {
    let req = request(app).get(url);
    if (host) req = req.set("Host", host);
    const res = await req
      .buffer(true)
      .parse((stream, cb) => {
        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => (data += chunk));
        stream.on("end", () => cb(null, data));
      });
    expect(res.status).toBe(200);
    return typeof res.body === "string" ? res.body : "";
  }

  async function insertAuthorWithBook(poster: string | null): Promise<number> {
    const parentId = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author', 'Base Author', 'base author', 1, 1, 'unknown')")
          .run()
      ).lastInsertRowid
    );
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path, poster_url) VALUES (?, 'Base Book', 1, '/books/Base Author/Base Book.epub', ?)")
      .run(parentId, poster);
    return parentId;
  }

  it("OPDS: without a base the feed is exactly what it was", async () => {
    const text = await feed(`/api/opds?token=${opdsToken}`);
    expect(text).toContain(`<link rel="self" href="/api/opds?token=${opdsToken}"`);
    expect(text).not.toContain("/aonarr");
  });

  it("OPDS: root-relative links carry the base when there is no External URL", async () => {
    process.env.URL_BASE = "/aonarr";
    const root = await feed(`/api/opds?token=${opdsToken}`);
    expect(root).toContain(`<link rel="self" href="/aonarr/api/opds?token=${opdsToken}"`);
    expect(root).toContain(`href="/aonarr/api/opds/type/author?token=${opdsToken}"`);
    const parentId = await insertAuthorWithBook("/api/media/local-artwork/cover_tok");
    const items = await feed(`/api/opds/item/${parentId}?token=${opdsToken}`);
    expect(items).toMatch(/href="\/aonarr\/api\/opds\/download\/subitem\/\d+\?token=/);
    // The cover is AoNarr's own proxied artwork: a reader fetches it under the base too.
    expect(items).toContain('rel="http://opds-spec.org/image" href="/aonarr/api/media/local-artwork/cover_tok"');
  });

  it("OPDS: the base goes after the External URL, once", async () => {
    process.env.URL_BASE = "aonarr";
    setSetting("externalUrl", "https://books.example.com:8443/");
    expect(await feed(`/api/opds?token=${opdsToken}`)).toContain(`<link rel="self" href="https://books.example.com:8443/aonarr/api/opds?token=${opdsToken}"`);
    setSetting("externalUrl", "https://books.example.com/aonarr");
    expect(await feed(`/api/opds?token=${opdsToken}`)).toContain(`<link rel="self" href="https://books.example.com/aonarr/api/opds?token=${opdsToken}"`);
  });

  it("OPDS: other cover URLs are left alone", async () => {
    process.env.URL_BASE = "/aonarr";
    const parentId = await insertAuthorWithBook("https://covers.example.com/c.jpg");
    const items = await feed(`/api/opds/item/${parentId}?token=${opdsToken}`);
    expect(items).toContain('rel="http://opds-spec.org/image" href="https://covers.example.com/c.jpg"');
  });

  it("IPTV playlist: stream links carry the base, after the External URL or the request's own address", async () => {
    const mediaId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'Base Movie', 'base movie', 1, 1, 'unknown')").run()).lastInsertRowid);
    const playlistId = Number((await db.prepare("INSERT INTO iptv_playlists (name, enabled) VALUES ('Base list', 1)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO iptv_playlist_items (playlist_id, position, title, media_item_id, duration_seconds) VALUES (?, 0, 'Base Movie', ?, 600)").run(playlistId, mediaId);
    const m3u = () => feed(`/api/iptv/m3u/${playlistId}?token=${iptvToken}`, "192.168.1.10:9876");

    expect(await m3u()).toContain(`http://192.168.1.10:9876/api/iptv/stream/media/${mediaId}?token=${iptvToken}`);
    process.env.URL_BASE = "/aonarr";
    expect(await m3u()).toContain(`http://192.168.1.10:9876/aonarr/api/iptv/stream/media/${mediaId}?token=${iptvToken}`);
    setSetting("externalUrl", "https://tv.example.com");
    expect(await m3u()).toContain(`https://tv.example.com/aonarr/api/iptv/stream/media/${mediaId}?token=${iptvToken}`);
    setSetting("externalUrl", "https://tv.example.com/aonarr/");
    expect(await m3u()).toContain(`https://tv.example.com/aonarr/api/iptv/stream/media/${mediaId}?token=${iptvToken}`);
  });

  it("OpenAPI: `servers` names the base so Swagger's Try it out reaches the API", async () => {
    const get = async () => (await request(app).get("/api/openapi.json").set("X-Api-Key", apiKey)).body;
    expect((await get()).servers).toEqual([{ url: "/api" }]);
    process.env.URL_BASE = "/aonarr";
    const doc = await get();
    expect(doc.servers).toEqual([{ url: "/aonarr/api" }]);
    // The rest of the document is the shared spec, not changed by the request.
    expect(Object.keys(doc.paths).length).toBeGreaterThan(10);
    delete process.env.URL_BASE;
    expect((await get()).servers).toEqual([{ url: "/api" }]);
  });

  it("Starr surface: status urlBase, OpenAPI servers and artwork URLs carry the base; the mounts themselves do not move", async () => {
    const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
    expect((await get("/sonarr/api/v3/system/status")).body.urlBase).toBe("/sonarr");
    expect((await get("/sonarr/api/v3/openapi.json")).body.servers).toEqual([{ url: "/sonarr" }]);

    process.env.URL_BASE = "/aonarr";
    expect((await get("/sonarr/api/v3/system/status")).body.urlBase).toBe("/aonarr/sonarr");
    expect((await get("/radarr/api/v3/system/status")).body.urlBase).toBe("/aonarr/radarr");
    expect((await get("/radarr/api/v3/openapi.json")).body.servers).toEqual([{ url: "/aonarr/radarr" }]);
    // nginx strips the prefix before the request gets here, so the unprefixed mount is still the one that answers.
    expect((await request(app).get("/sonarr/ping")).status).toBe(200);
    expect((await request(app).get("/aonarr/sonarr/ping")).status).toBe(404);

    const { images } = await import("../src/starr/shapes.js");
    expect(images("/api/media/local-artwork/p1", "https://image.tmdb.org/b.jpg")).toEqual([
      { coverType: "poster", url: "/aonarr/api/media/local-artwork/p1", remoteUrl: "/aonarr/api/media/local-artwork/p1" },
      { coverType: "fanart", url: "https://image.tmdb.org/b.jpg", remoteUrl: "https://image.tmdb.org/b.jpg" },
    ]);
    delete process.env.URL_BASE;
    expect(images("/api/media/local-artwork/p1")).toEqual([{ coverType: "poster", url: "/api/media/local-artwork/p1", remoteUrl: "/api/media/local-artwork/p1" }]);
  });

  it("the server itself keeps serving /api/... unprefixed (nginx cuts the prefix off), and sets no cookie that would need a Path", async () => {
    process.env.URL_BASE = "/aonarr";
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect((await request(app).get("/aonarr/api/health")).status).toBe(404);
  });
});
