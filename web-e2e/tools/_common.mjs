// Shared helpers for the three zero-install "before-numbers" scripts in this folder.
// Plain Node only. The TypeScript compiler API is borrowed read-only from web/node_modules
// (never added as a dependency of web-e2e). Nothing here touches the network or the live app.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TOOLS_DIR, "..", "..");

/** Tiny argv parser: `--flag`, `--key value`, `--key=value`. Positional args go in `_`. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/** Load the TypeScript compiler API from web/node_modules (read-only; no install). */
export function loadTypeScript(repoRoot = REPO_ROOT) {
  const tsPkg = path.join(repoRoot, "web", "node_modules", "typescript", "package.json");
  if (!fs.existsSync(tsPkg)) {
    throw new Error(`TypeScript not found at ${tsPkg}. Run from a checkout where web/node_modules exists (read-only use).`);
  }
  const req = createRequire(tsPkg);
  return req("./lib/typescript.js");
}

/** Recursively list files under `dir` whose names satisfy `pred`, sorted for determinism. */
export function walk(dir, pred, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, pred, out);
    else if (pred(full)) out.push(full);
  }
  return out;
}

export function toPosix(p) {
  return p.replace(/\\/g, "/");
}

/** Repo-relative POSIX path for display. */
export function rel(file, root = REPO_ROOT) {
  return toPosix(path.relative(root, file));
}

export function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
}

export function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.replace(/\r\n/g, "\n"), "utf8");
}

export function writeJson(file, obj) {
  writeText(file, JSON.stringify(obj, null, 2) + "\n");
}

/** Short commit hash of HEAD plus whether tracked files differ (read-only git). */
export function gitInfo(repoRoot = REPO_ROOT) {
  const run = (args) => {
    try {
      const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 15000 });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  return { commit: run(["rev-parse", "--short", "HEAD"]), describe: run(["describe", "--tags", "--always"]) };
}

/** 1-based line of a node start. */
export function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function pct(n, d) {
  return d === 0 ? "0.0%" : ((n / d) * 100).toFixed(1) + "%";
}

/** Render rows as a GitHub-flavoured Markdown table. */
export function mdTable(headers, rows) {
  const esc = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [`| ${headers.map(esc).join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const r of rows) lines.push(`| ${r.map(esc).join(" | ")} |`);
  return lines.join("\n");
}

export function countBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export function sortedEntries(map, by = "count") {
  const arr = [...map.entries()];
  arr.sort((a, b) => (by === "count" ? b[1] - a[1] || String(a[0]).localeCompare(String(b[0])) : String(a[0]).localeCompare(String(b[0]))));
  return arr;
}

/** CSS named colours (148, CSS Color 4) minus `transparent`/`currentcolor` which are keywords, not palette colours. */
export const CSS_NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" ")
);

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;
const FUNC_RE = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;

/** Property names (camelCase or kebab-case) whose value can legitimately carry a colour. */
export function isColourishProp(prop) {
  if (!prop) return false;
  const p = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return /color$/i.test(p) || /^(background|border|outline|boxShadow|textShadow|fill|stroke|filter|backdropFilter|columnRule|textDecoration|caretColor|accentColor|scrollbarColor)/.test(p);
}

/**
 * Find raw (hard-coded) colour literals in a CSS value string.
 * Returns [{ value, kind: 'hex'|'functional'|'named', inFallback: boolean }].
 * `var(--x)` references, `transparent`, `currentColor`, `inherit` are NOT raw colours.
 * Named colours are only recognised when `prop` is colour-ish (avoids `font-family: Tahoma` etc.).
 */
export function findRawColours(value, prop) {
  const found = [];
  if (typeof value !== "string" || !value) return found;

  // Mark spans that sit inside a var(--x, <fallback>) fallback so we can flag (not hide) them.
  const fallbackSpans = [];
  const varRe = /var\(\s*--[\w-]+\s*,/g;
  let vm;
  while ((vm = varRe.exec(value))) {
    let depth = 1;
    let i = vm.index + vm[0].length;
    const start = i;
    for (; i < value.length && depth > 0; i++) {
      if (value[i] === "(") depth++;
      else if (value[i] === ")") depth--;
    }
    fallbackSpans.push([start, i - 1]);
  }
  const inFallback = (idx) => fallbackSpans.some(([a, b]) => idx >= a && idx < b);

  let m;
  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(value))) found.push({ value: m[0], kind: "hex", inFallback: inFallback(m.index) });
  FUNC_RE.lastIndex = 0;
  while ((m = FUNC_RE.exec(value))) {
    // grab the balanced call text for display
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < value.length && depth > 0; i++) {
      if (value[i] === "(") depth++;
      else if (value[i] === ")") depth--;
    }
    found.push({ value: value.slice(m.index, i), kind: "functional", inFallback: inFallback(m.index) });
  }
  if (isColourishProp(prop)) {
    // strip url(...) and var(--x) heads and function names so words inside are not misread
    const stripped = value.replace(/url\([^)]*\)/gi, (s) => " ".repeat(s.length)).replace(/var\(\s*--[\w-]+/gi, (s) => " ".repeat(s.length));
    const wordRe = /[a-zA-Z]+/g;
    while ((m = wordRe.exec(stripped))) {
      const w = m[0].toLowerCase();
      const next = stripped[m.index + m[0].length];
      if (next === "(") continue; // function name like linear-gradient / rgba
      if (CSS_NAMED_COLOURS.has(w)) found.push({ value: m[0], kind: "named", inFallback: inFallback(m.index) });
    }
  }
  return found;
}

export const VAR_REF_RE = /var\(\s*(--[\w-]+)/g;
