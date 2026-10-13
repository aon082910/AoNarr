#!/usr/bin/env node
// Build the CURRENT working-tree web app into web-e2e/.tmp/web-dist WITHOUT touching web/ output.
//
//   node scripts/build-web.mjs            build only when web/ sources changed since the last build
//   node scripts/build-web.mjs --force    always rebuild
//
// Equivalent to running, from web/:
//   web/node_modules/.bin/vite build --outDir ../web-e2e/.tmp/web-dist --emptyOutDir
// but through Vite's JS API so it is cross-platform with no shell. `tsc -b` (the type-check half of
// `npm run build`) is deliberately skipped: it writes tsbuildinfo into web/. No npm install runs in web/.
import fs from "node:fs";
import path from "node:path";
import {
  DIST_DIR, STAMP_FILE, WEB_DIR, assertInsideTmp, git, hashWebSources, loadVite, log, parseArgs, porcelainWeb, readStamp,
} from "./_common.mjs";

const args = parseArgs(process.argv.slice(2));
assertInsideTmp(DIST_DIR);

const { hash, fileCount } = hashWebSources();
const stamp = readStamp();
if (!args.force && stamp?.sourceHash === hash && fs.existsSync(path.join(DIST_DIR, "index.html"))) {
  log(`web build is up to date (${fileCount} source files, hash ${hash.slice(0, 12)}, built from ${stamp.gitCommit}${stamp.gitDirty ? "+dirty" : ""}). Use --force to rebuild.`);
  process.exit(0);
}

const before = porcelainWeb();
const t0 = Date.now();
const vite = await loadVite();
log(`building web/ (vite ${vite.version}) -> ${path.relative(process.cwd(), DIST_DIR) || DIST_DIR}`);
await vite.build({
  root: WEB_DIR,
  configFile: path.join(WEB_DIR, "vite.config.ts"),
  mode: "production",
  logLevel: "warn",
  build: { outDir: DIST_DIR, emptyOutDir: true },
});

const after = porcelainWeb();
if (after !== before) {
  console.error("[web-e2e] ERROR: git status of web/ or server/ changed during the build:\n" + after);
  process.exit(2);
}

fs.writeFileSync(
  STAMP_FILE,
  JSON.stringify(
    {
      sourceHash: hash,
      fileCount,
      viteVersion: vite.version,
      gitCommit: git(["rev-parse", "--short", "HEAD"]),
      gitDirty: (git(["status", "--porcelain", "--", "web/src", "web/public", "web/index.html"]) ?? "") !== "",
      builtAtMs: Date.now() - t0,
    },
    null,
    2,
  ) + "\n",
);
log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s (hash ${hash.slice(0, 12)}); web/ and server/ git status unchanged.`);
