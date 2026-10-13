// Shared helpers for the web-e2e scripts. Plain Node, no dependencies.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(E2E_DIR, "..");
export const WEB_DIR = path.join(REPO_ROOT, "web");
export const TMP_DIR = path.join(E2E_DIR, ".tmp");
export const DIST_DIR = path.join(TMP_DIR, "web-dist");
export const STAMP_FILE = path.join(DIST_DIR, "build-info.json");

export const APP_HOST = "127.0.0.1";
export const APP_PORT = 4173;
export const BACKEND_URL = process.env.AONARR_E2E_API ?? "http://127.0.0.1:8989";

// Telemetry off for everything these scripts start.
process.env.DO_NOT_TRACK = "1";

export function log(...args) {
  console.log("[web-e2e]", ...args);
}

/** Refuse to write outside web-e2e/.tmp: the build must never land in web/ or anywhere tracked. */
export function assertInsideTmp(target) {
  const rel = path.relative(TMP_DIR, path.resolve(target));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to use ${target}: output must live under ${TMP_DIR}`);
  }
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Content hash of everything that changes the built web app (never reads node_modules). */
export function hashWebSources() {
  const files = [
    ...walkFiles(path.join(WEB_DIR, "src")),
    ...walkFiles(path.join(WEB_DIR, "public")),
    ...["index.html", "vite.config.ts", "package.json", "package-lock.json", "tsconfig.json"].map((f) => path.join(WEB_DIR, f)).filter((f) => fs.existsSync(f)),
  ];
  const h = crypto.createHash("sha256");
  for (const f of files) {
    h.update(path.relative(WEB_DIR, f).replaceAll("\\", "/"));
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return { hash: h.digest("hex"), fileCount: files.length };
}

export function git(args) {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** `git status --porcelain` limited to web/ (and server/), used to prove a script touched nothing there. */
export function porcelainWeb() {
  return git(["status", "--porcelain", "--", "web", "server"]) ?? "";
}

export function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(STAMP_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (a.includes("=")) out[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else out[a.slice(2)] = true;
  }
  return out;
}

/** Load Vite from web/node_modules (read-only use; web-e2e never installs it). */
export async function loadVite() {
  const entry = path.join(WEB_DIR, "node_modules", "vite", "dist", "node", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`Vite not found at ${entry}. web/node_modules must already be installed (this package never runs npm in web/).`);
  }
  const { pathToFileURL } = await import("node:url");
  return import(pathToFileURL(entry).href);
}
