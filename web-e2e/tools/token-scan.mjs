#!/usr/bin/env node
// CSS custom-property (token) scan for web/src: uses, definitions, gaps, duplicates, hard-coded colours.
//
//   node web-e2e/tools/token-scan.mjs                     # write token-scan.json + token-scan.md
//   node web-e2e/tools/token-scan.mjs --update-baseline   # also write web-e2e/baselines/token-baseline.json
//   node web-e2e/tools/token-scan.mjs --check             # ratchet: exit 1 if undefined tokens or hard-coded CSS colours increased
//
// Options: --src <dir> (default <repo>/web/src), --out <dir> (default <repo>/redesign-concepts/phase0), --baseline <file>, --quiet.
//
// Zero install: plain Node plus the TypeScript compiler API borrowed read-only from web/node_modules (used to read
// string literals in .tsx/.ts so comments are never counted). Does not touch the network or the live app.
//
// Model (inferred from the CSS entry order in main.tsx and the selectors):
//   - Classic = styles.css alone. `:root` and `:root[data-theme="light"]` define its tokens.
//   - Every other design = styles.css + designs/modern.css (shared layer, scoped `:root[data-design]`) + designs/<id>.css.
//   - Dark is the default theme (no attribute); light is `data-theme="light"`.
//   - 7 designs x 2 themes = 14 states. A token is "available" in a state if some root-scope rule that matches the state defines it.
import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  parseArgs,
  loadTypeScript,
  walk,
  rel,
  toPosix,
  readText,
  writeJson,
  writeText,
  gitInfo,
  mdTable,
  findRawColours,
  sortedEntries,
} from "./_common.mjs";

const args = parseArgs(process.argv.slice(2));
const ts = loadTypeScript();
const K = ts.SyntaxKind;
const SRC = path.resolve(args.src ?? path.join(REPO_ROOT, "web", "src"));
const OUT = path.resolve(args.out ?? path.join(REPO_ROOT, "redesign-concepts", "phase0"));
const BASELINE = path.resolve(args.baseline ?? path.join(REPO_ROOT, "web-e2e", "baselines", "token-baseline.json"));
const quiet = !!args.quiet;
const log = (...a) => {
  if (!quiet) console.log(...a);
};
const relSrc = (file) => "web/src/" + toPosix(path.relative(SRC, file));

/** Earlier agent's findings, compared against what is measured here. */
const PRIOR = {
  undefinedTokens: ["--link", "--bg-alt"],
  classicTokens: 10,
  designTokensRange: [29, 31],
};

// =====================================================================================
// CSS reader (comments stripped keeping line numbers; native nesting aware)
// =====================================================================================
function stripCssComments(text) {
  let out = "";
  let i = 0;
  let inStr = null;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse CSS into rules: { selector (nesting resolved), at: [at-rule preludes], decls: [{prop,value,line}], line }. */
function parseCss(raw) {
  const text = stripCssComments(raw);
  const rules = [];
  const stack = []; // {prelude, selector, at, decls, line}
  let buf = "";
  let bufStart = 0;
  let paren = 0;
  let inStr = null;
  const lineAt = (idx) => text.slice(0, idx).split("\n").length;
  const flushDecl = (endIdx) => {
    const s = buf.trim();
    buf = "";
    if (!s) return;
    const cur = stack[stack.length - 1];
    if (!cur) return; // top-level statement such as @import
    const colon = s.indexOf(":");
    if (colon === -1) return;
    const prop = s.slice(0, colon).trim();
    const value = s.slice(colon + 1).trim();
    if (!prop || /\s/.test(prop.replace(/--[\w-]+/, ""))) return;
    // declaration line = line of the first non-space char of the declaration
    const lead = text.slice(bufStart, endIdx).search(/\S/);
    cur.decls.push({ prop, value, line: lineAt(bufStart + Math.max(0, lead)) });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      buf += c;
      if (c === "\\") {
        buf += text[i + 1] ?? "";
        i++;
      } else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      if (!buf.trim()) bufStart = i;
      buf += c;
      continue;
    }
    if (c === "(") paren++;
    if (c === ")") paren = Math.max(0, paren - 1);
    if (paren === 0 && c === "{") {
      const prelude = buf.trim();
      const parent = stack[stack.length - 1];
      const isAt = prelude.startsWith("@");
      let selector = null;
      if (!isAt) {
        selector = parent && parent.selector ? prelude.split(",").map((p) => (p.includes("&") ? p.replace(/&/g, parent.selector) : `${parent.selector} ${p.trim()}`)).join(", ") : prelude;
      } else selector = parent ? parent.selector : null;
      const at = [...(parent ? parent.at : []), ...(isAt ? [prelude] : [])];
      stack.push({ prelude, selector, at, decls: [], line: lineAt(i), isAt });
      buf = "";
      bufStart = i + 1;
      continue;
    }
    if (paren === 0 && c === "}") {
      flushDecl(i);
      const done = stack.pop();
      if (done && !done.isAt) rules.push({ selector: done.selector, at: done.at, decls: done.decls, line: done.line });
      else if (done && done.isAt && done.decls.length) rules.push({ selector: done.selector, at: done.at, decls: done.decls, line: done.line });
      buf = "";
      bufStart = i + 1;
      continue;
    }
    if (paren === 0 && c === ";") {
      flushDecl(i);
      bufStart = i + 1;
      continue;
    }
    if (!buf.trim()) bufStart = i;
    buf += c;
  }
  return rules;
}

// =====================================================================================
// Selector scope analysis
// =====================================================================================
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
function expandIs(sel) {
  const idx = sel.indexOf(":is(");
  if (idx === -1) return [sel];
  let depth = 0;
  let end = -1;
  for (let i = idx + 3; i < sel.length; i++) {
    if (sel[i] === "(") depth++;
    if (sel[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [sel];
  const inner = sel.slice(idx + 4, end);
  const out = [];
  for (const alt of splitTop(inner, ",")) out.push(...expandIs(sel.slice(0, idx) + alt + sel.slice(end + 1)));
  return out;
}
/** Split a complex selector into compounds at top-level combinators. */
function compoundsOf(sel) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const c of sel) {
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (depth === 0 && /[\s>+~]/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
function attrsOf(compound) {
  const attrs = [];
  const re = /\[\s*([\w-]+)\s*(?:=\s*["']?([^"'\]]*)["']?)?\s*\]/g;
  let m;
  while ((m = re.exec(compound))) attrs.push({ name: m[1], value: m[2] ?? null });
  return attrs;
}
/** specificity of one expanded complex selector as [ids, classes/attrs/pseudo-classes, types] encoded to a number */
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const cls = (sel.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) ?? []).length;
  const types = (sel.replace(/\[[^\]]*\]|\([^)]*\)/g, "").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + cls * 100 + types;
}
/**
 * Analyse a (nesting-resolved) selector list into alternatives.
 * scope: 'root' (matches the <html> element), 'preview' ([data-design-preview] swatches), 'component' (anything else).
 */
function analyseSelector(selector) {
  const alts = [];
  if (!selector) return alts;
  for (const part of splitTop(selector, ",")) {
    for (const exp of expandIs(part)) {
      const comps = compoundsOf(exp);
      if (!comps.length) continue;
      const first = comps[0];
      const last = comps[comps.length - 1];
      const spec = specificity(exp);
      const isRootCompound = (c) => /^(:root|html)(?![\w-])/.test(c);
      if (comps.length === 1 && isRootCompound(first)) {
        const attrs = attrsOf(first);
        const design = attrs.find((a) => a.name === "data-design");
        const theme = attrs.find((a) => a.name === "data-theme");
        const other = attrs.filter((a) => a.name !== "data-design" && a.name !== "data-theme");
        alts.push({ scope: other.length || /:(?!root)/.test(first.replace(/\[[^\]]*\]/g, "").replace(/^:root/, "")) ? "root-conditional" : "root", design: design ? (design.value === null ? "*" : design.value) : null, theme: theme ? theme.value : null, otherAttrs: other.map((a) => `${a.name}=${a.value}`), spec, raw: exp });
      } else if (attrsOf(last).some((a) => a.name === "data-design-preview")) {
        const pv = attrsOf(last).find((a) => a.name === "data-design-preview");
        const theme = isRootCompound(first) ? attrsOf(first).find((a) => a.name === "data-theme") : null;
        alts.push({ scope: "preview", design: pv.value, theme: theme ? theme.value : null, spec, raw: exp });
      } else alts.push({ scope: "component", spec, raw: exp });
    }
  }
  return alts;
}
const DESIGN_STATE = (alt, state) => {
  // does a root-scope alternative apply to this state {design: 'classic'|id, theme: 'dark'|'light'}?
  if (alt.scope !== "root") return false;
  if (alt.design !== null) {
    if (alt.design === "*") {
      if (state.design === "classic") return false;
    } else if (alt.design !== state.design) return false;
  }
  if (alt.theme !== null && alt.theme !== state.theme) return false;
  return true;
};

// =====================================================================================
// Colour maths
// =====================================================================================
function parseColour(value) {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((x) => x + x).join("");
    if (h.length === 6 || h.length === 8) {
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}
function canonColour(value) {
  const c = parseColour(value);
  if (!c) return value.trim().replace(/\s+/g, " ").toLowerCase();
  const h = (n) => Math.round(n).toString(16).padStart(2, "0");
  return c.a >= 1 ? `#${h(c.r)}${h(c.g)}${h(c.b)}` : `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${+c.a.toFixed(3)})`;
}
function toLab({ r, g, b }) {
  const lin = (u) => {
    const c = u / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
const deltaE = (c1, c2) => {
  const a = toLab(c1);
  const b = toLab(c2);
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
};

// =====================================================================================
// Scan
// =====================================================================================
const cssFiles = walk(SRC, (f) => f.endsWith(".css"));
const codeFiles = walk(SRC, (f) => /\.(tsx|ts)$/.test(f) && !f.endsWith(".d.ts"));

// bundle order: main.tsx imports then @import chains
function cssOrder() {
  const order = [];
  const seen = new Set();
  const add = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const txt = stripCssComments(readText(file));
    // imports come first in a CSS file, so process them before the file's own rules
    const re = /@import\s+(?:url\()?["']([^"')]+)["']\)?\s*;/g;
    let m;
    while ((m = re.exec(txt))) add(path.resolve(path.dirname(file), m[1]));
    order.push(file);
  };
  const main = path.join(SRC, "main.tsx");
  if (fs.existsSync(main)) {
    const re = /import\s+["'](\.[^"']+\.css)["']/g;
    const t = readText(main);
    let m;
    while ((m = re.exec(t))) add(path.resolve(path.dirname(main), m[1]));
  }
  for (const f of cssFiles) add(f);
  return order;
}
const ORDER = cssOrder();
const orderIndex = new Map(ORDER.map((f, i) => [f, i]));

const parsed = new Map(); // css file -> rules
for (const f of cssFiles) parsed.set(f, parseCss(readText(f)));

// design ids = every [data-design="x"] value seen in selectors (not preview)
const designIds = new Set();
for (const [f, rules] of parsed) {
  void f;
  for (const r of rules) for (const alt of analyseSelector(r.selector)) if (alt.scope === "root" && alt.design && alt.design !== "*") designIds.add(alt.design);
}
const DESIGNS = ["classic", ...[...designIds].sort((a, b) => {
  // keep file order from the bundle for a stable, meaningful column order
  const fa = ORDER.findIndex((f) => path.basename(f, ".css") === a);
  const fb = ORDER.findIndex((f) => path.basename(f, ".css") === b);
  return fa - fb || a.localeCompare(b);
})];
const STATES = DESIGNS.flatMap((d) => ["dark", "light"].map((t) => ({ design: d, theme: t, key: `${d}/${t}` })));
const fileForDesign = (id) => ORDER.find((f) => path.basename(f, ".css") === id) ?? null;

// ---------- definitions ----------
const defs = []; // {name,value,file,line,selector,at,alt(analysis),order}
for (const [file, rules] of parsed) {
  for (const r of rules) {
    const alts = analyseSelector(r.selector);
    for (const d of r.decls) {
      if (!d.prop.startsWith("--")) continue;
      defs.push({ name: d.prop, value: d.value, file: relSrc(file), fileAbs: file, line: d.line, selector: r.selector, at: r.at, alts, order: orderIndex.get(file) ?? 999 });
    }
  }
}
// inline definitions from TSX/TS: style object keys '--x' and setProperty("--x")
const inlineDefs = [];
const uses = []; // {token, file, line, kind, prop, hasFallback, fallback}

/** Scan a CSS value (or any string) for var(--x[, fallback]) with balanced parentheses, including nested fallbacks. */
function scanVars(value, cb) {
  const re = /var\(\s*(--[\w-]+)\s*/g;
  let m;
  while ((m = re.exec(value))) {
    let depth = 1;
    let i = m.index + 4; // after "var("
    const start = i;
    for (; i < value.length && depth > 0; i++) {
      if (value[i] === "(") depth++;
      else if (value[i] === ")") depth--;
    }
    const body = value.slice(start, i - 1);
    const comma = body.indexOf(",");
    cb(m[1], comma === -1 ? null : body.slice(comma + 1).trim());
  }
}

for (const [file, rules] of parsed) {
  const isDesignsIndex = path.basename(file) === "index.css" && path.basename(path.dirname(file)) === "designs";
  const base = path.basename(file, ".css");
  for (const r of rules) {
    for (const d of r.decls) {
      scanVars(d.value, (token, fallback) => {
        uses.push({ token, file: relSrc(file), fileAbs: file, line: d.line, kind: "css", prop: d.prop, hasFallback: fallback !== null, fallback, selector: r.selector, isTokenDefinition: d.prop.startsWith("--"), designsIndex: isDesignsIndex, base });
      });
    }
  }
}
for (const file of codeFiles) {
  const sf = ts.createSourceFile(file, readText(file), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rf = relSrc(file);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n) => {
    // style-object key '--x'
    if (ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.name) || ts.isIdentifier(n.name)) && n.name.text.startsWith("--")) inlineDefs.push({ name: n.name.text, file: rf, line: lineOf(n), via: "inline style key" });
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "setProperty" && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text.startsWith("--")) inlineDefs.push({ name: n.arguments[0].text, file: rf, line: lineOf(n), via: "style.setProperty" });
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "getPropertyValue" && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text.startsWith("--")) uses.push({ token: n.arguments[0].text, file: rf, line: lineOf(n), kind: "js-read", prop: "getPropertyValue", hasFallback: false, fallback: null });
    let texts = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) texts = [n.text];
    else if (ts.isTemplateExpression(n)) texts = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)];
    if (texts) {
      // key context for style objects: nearest property name
      let prop = null;
      if (n.parent && ts.isPropertyAssignment(n.parent) && (ts.isIdentifier(n.parent.name) || ts.isStringLiteral(n.parent.name))) prop = n.parent.name.text;
      if (n.parent && ts.isConditionalExpression(n.parent) && n.parent.parent && ts.isPropertyAssignment(n.parent.parent)) prop = n.parent.parent.name.getText(sf);
      for (const t of texts) {
        if (!t.includes("var(")) continue;
        scanVars(t, (token, fallback) => uses.push({ token, file: rf, line: lineOf(n), kind: "tsx", prop, hasFallback: fallback !== null, fallback }));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// =====================================================================================
// Availability per state
// =====================================================================================
/** For a token and state, the winning root-scope definition (highest specificity, then latest in bundle order). */
function winningDef(name, state, defsFor) {
  let best = null;
  for (const d of defsFor) {
    if (d.name !== name) continue;
    for (const alt of d.alts) {
      if (!DESIGN_STATE(alt, state)) continue;
      const score = alt.spec * 1000 + d.order;
      if (!best || score >= best.score) best = { def: d, score, alt };
    }
  }
  return best ? best.def : null;
}
const allTokenNames = new Set([...defs.map((d) => d.name), ...inlineDefs.map((d) => d.name), ...uses.map((u) => u.token)]);
const definedRoot = new Set(); // tokens defined in some root-scope rule (any state)
const definedAnywhere = new Set(); // root, preview, component scope, or inline
for (const d of defs) {
  definedAnywhere.add(d.name);
  if (d.alts.some((a) => a.scope === "root" || a.scope === "root-conditional")) definedRoot.add(d.name);
}
for (const d of inlineDefs) definedAnywhere.add(d.name);
const defsByName = new Map();
for (const d of defs) {
  if (!defsByName.has(d.name)) defsByName.set(d.name, []);
  defsByName.get(d.name).push(d);
}
const availability = new Map(); // token -> Map(stateKey -> def|null)
for (const name of definedRoot) {
  const m = new Map();
  for (const st of STATES) m.set(st.key, winningDef(name, st, defsByName.get(name)));
  availability.set(name, m);
}
const previewDefined = new Set(defs.filter((d) => d.alts.some((a) => a.scope === "preview")).map((d) => d.name));

// ---------- use requirements ----------
/**
 * Which states must define the token for this use to resolve?
 *   styles.css, tsx, designs/index.css : all states (global code)
 *   designs/modern.css                 : every non-Classic state
 *   designs/<id>.css                   : that design's states
 */
function requiredStates(u) {
  if (u.kind !== "css") return STATES;
  if (u.designsIndex) return STATES;
  if (u.base === "modern" && path.basename(path.dirname(u.fileAbs)) === "designs") return STATES.filter((s) => s.design !== "classic");
  if (path.basename(path.dirname(u.fileAbs)) === "designs" && DESIGNS.includes(u.base)) return STATES.filter((s) => s.design === u.base);
  return STATES;
}

// per-token summary
const tokens = new Map();
const tok = (name) => {
  if (!tokens.has(name)) tokens.set(name, { name, uses: 0, usesCss: 0, usesTsx: 0, usesJs: 0, withFallback: 0, withoutFallback: 0, files: new Map(), tokenDefinitionUses: 0, sites: [] });
  return tokens.get(name);
};
for (const u of uses) {
  const t = tok(u.token);
  t.uses++;
  if (u.kind === "css") t.usesCss++;
  else if (u.kind === "tsx") t.usesTsx++;
  else t.usesJs++;
  if (u.hasFallback) t.withFallback++;
  else t.withoutFallback++;
  if (u.isTokenDefinition) t.tokenDefinitionUses++;
  t.files.set(u.file, (t.files.get(u.file) ?? 0) + 1);
  t.sites.push(u);
}

// gaps
const undefinedTokens = []; // used, defined nowhere
const missingBy = []; // used where required states lack a definition
for (const t of tokens.values()) {
  if (!definedAnywhere.has(t.name)) {
    undefinedTokens.push({ token: t.name, uses: t.uses, withFallback: t.withFallback, withoutFallback: t.withoutFallback, files: [...t.files.keys()], sites: t.sites.map((s) => `${s.file}:${s.line}`), fallbacks: [...new Set(t.sites.map((s) => s.fallback).filter(Boolean))] });
    continue;
  }
  const avail = availability.get(t.name);
  const missingStates = new Map(); // stateKey -> sites that need it
  for (const u of t.sites) {
    if (u.kind === "js-read") continue;
    for (const st of requiredStates(u)) {
      const have = avail ? avail.get(st.key) : null;
      const okPreview = u.designsIndex && previewDefined.has(t.name);
      if (!have && !okPreview) {
        if (!missingStates.has(st.key)) missingStates.set(st.key, []);
        missingStates.get(st.key).push(u);
      }
    }
  }
  if (missingStates.size) {
    const sitesWith = new Set();
    for (const arr of missingStates.values()) for (const u of arr) sitesWith.add(`${u.file}:${u.line}|${u.hasFallback ? "fb" : "nofb"}|${u.fallback ?? ""}`);
    const siteList = [...sitesWith].map((s) => {
      const [loc, fb, fallback] = s.split("|");
      return { at: loc, hasFallback: fb === "fb", fallback: fallback || null };
    });
    missingBy.push({
      token: t.name,
      missingInStates: [...missingStates.keys()],
      classicMissing: [...missingStates.keys()].some((k) => k.startsWith("classic/")),
      sites: siteList,
      allWithFallback: siteList.every((s) => s.hasFallback),
      withoutFallbackSites: siteList.filter((s) => !s.hasFallback).map((s) => s.at),
    });
  }
}
undefinedTokens.sort((a, b) => a.token.localeCompare(b.token));
missingBy.sort((a, b) => a.token.localeCompare(b.token));
const classicGaps = missingBy.filter((m) => m.classicMissing);
const classicGapsNoFallback = classicGaps.filter((m) => !m.allWithFallback);

// =====================================================================================
// Definitions per design (own file vs effective)
// =====================================================================================
const isDesignsDir = (f) => path.basename(path.dirname(f)) === "designs";
function ownTokensOf(designId) {
  const file = fileForDesign(designId === "classic" ? "styles" : designId);
  const byTheme = { dark: new Set(), light: new Set(), any: new Set() };
  if (!file) return { file: null, byTheme, all: new Set() };
  for (const d of defs) {
    if (d.fileAbs !== file) continue;
    for (const a of d.alts) {
      if (a.scope !== "root") continue;
      if (designId !== "classic" && a.design !== designId) continue;
      if (designId === "classic" && a.design !== null) continue;
      const th = a.theme ?? "any";
      byTheme[th === "light" ? "light" : th === "dark" ? "dark" : "any"].add(d.name);
    }
  }
  const all = new Set([...byTheme.dark, ...byTheme.light, ...byTheme.any]);
  return { file: relSrc(file), byTheme, all };
}
const own = Object.fromEntries(DESIGNS.map((d) => [d, ownTokensOf(d)]));
const effectiveCount = (design, theme) => [...availability.entries()].filter(([, m]) => m.get(`${design}/${theme}`)).length;
const modernFile = ORDER.find((f) => path.basename(f) === "modern.css" && isDesignsDir(f)) ?? null;
const modernDefines = new Set(defs.filter((d) => modernFile && d.fileAbs === modernFile && d.alts.some((a) => a.scope === "root")).map((d) => d.name));

/** Classify a token by its (first) value so the per-design counts can be split into colour / shadow / font / radius / other. */
function tokenClass(name) {
  const d = (defsByName.get(name) ?? [])[0];
  const v = d ? d.value : "";
  if (/^--font/.test(name)) return "font";
  if (/^--r-/.test(name)) return "radius";
  if (/^--shadow/.test(name) || /^-?\d+(px)?\s+-?\d+(px)?\s+\d+(px)?\s+.*(rgba?\(|#[0-9a-f]{3,8}\b)/i.test(v)) return "shadow";
  if (parseColour(v) || /^color-mix\(/.test(v)) return "colour";
  return "other";
}
function tokenClassCounts(set) {
  const c = { colour: 0, shadow: 0, font: 0, radius: 0, other: 0 };
  for (const n of set) c[tokenClass(n)]++;
  return c;
}
const definedSummary = DESIGNS.map((d) => ({
  design: d,
  file: own[d].file,
  ownTokens: own[d].all.size,
  ownDark: new Set([...own[d].byTheme.dark, ...own[d].byTheme.any]).size,
  ownLight: new Set([...own[d].byTheme.light, ...own[d].byTheme.any]).size,
  breakdown: tokenClassCounts(own[d].all),
  effectiveDark: effectiveCount(d, "dark"),
  effectiveLight: effectiveCount(d, "light"),
}));
const classicSet = own.classic.all;
const designOnly = {}; // tokens a design defines that Classic does not
const classicNotInDesign = {};
for (const d of DESIGNS.filter((x) => x !== "classic")) {
  designOnly[d] = [...own[d].all].filter((t) => !classicSet.has(t)).sort();
  classicNotInDesign[d] = [...classicSet].filter((t) => !own[d].all.has(t)).sort();
}
// tokens defined by only some designs
const designTokenUnion = new Set(DESIGNS.filter((d) => d !== "classic").flatMap((d) => [...own[d].all]));
const inconsistent = [...designTokenUnion]
  .map((t) => ({ token: t, definedBy: DESIGNS.filter((d) => d !== "classic" && own[d].all.has(t)), missingFrom: DESIGNS.filter((d) => d !== "classic" && !own[d].all.has(t)) }))
  .filter((x) => x.missingFrom.length)
  .sort((a, b) => a.token.localeCompare(b.token));
// per-theme gaps inside a design (defined for dark but not light or vice versa)
const themeGaps = [];
for (const d of DESIGNS) {
  const dark = new Set([...own[d].byTheme.dark, ...own[d].byTheme.any]);
  const light = new Set([...own[d].byTheme.light, ...own[d].byTheme.any]);
  for (const t of new Set([...dark, ...light])) {
    if (dark.has(t) !== light.has(t)) themeGaps.push({ design: d, token: t, onlyIn: dark.has(t) ? "dark" : "light" });
  }
}

// tokens used by modern.css and whether each design file defines them
const modernUsed = [...new Set(uses.filter((u) => u.kind === "css" && u.fileAbs === modernFile && !u.isTokenDefinition).map((u) => u.token))].sort();
const modernMatrix = modernUsed.map((t) => {
  const row = { token: t, definedByModern: modernDefines.has(t), usesInModern: uses.filter((u) => u.fileAbs === modernFile && u.token === t).length, designFile: {}, effective: {} };
  for (const d of DESIGNS.filter((x) => x !== "classic")) {
    row.designFile[d] = own[d].all.has(t);
    row.effective[d] = ["dark", "light"].every((th) => availability.get(t)?.get(`${d}/${th}`));
  }
  row.classicRootDefines = classicSet.has(t);
  row.undefinedEverywhere = !definedAnywhere.has(t);
  row.fallbackOnly = uses.filter((u) => u.fileAbs === modernFile && u.token === t).every((u) => u.hasFallback);
  return row;
});
const modernNotInEveryDesign = modernMatrix.filter((r) => !r.definedByModern && Object.values(r.designFile).some((v) => !v));
const modernEffectiveGaps = modernMatrix.filter((r) => Object.values(r.effective).some((v) => !v));

// =====================================================================================
// Values: duplicates and near-duplicates
// =====================================================================================
const valueOf = (name, st) => winningDef(name, st, defsByName.get(name) ?? [])?.value ?? null;
const identicalWithin = []; // per state: groups of tokens with the same value
const nearWithin = [];
const NEAR = 3; // CIE76 delta-E threshold (about a just-noticeable difference)
for (const st of STATES) {
  const byVal = new Map();
  const colourTokens = [];
  for (const name of availability.keys()) {
    const v = valueOf(name, st);
    if (v === null) continue;
    const cv = canonColour(v);
    if (!byVal.has(cv)) byVal.set(cv, []);
    byVal.get(cv).push(name);
    const pc = parseColour(v);
    if (pc && pc.a >= 1) colourTokens.push({ name, c: pc, cv });
  }
  for (const [value, names] of byVal) if (names.length >= 2 && !/^(\d|-)/.test(value)) identicalWithin.push({ state: st.key, value, tokens: names.sort() });
  for (let i = 0; i < colourTokens.length; i++) {
    for (let j = i + 1; j < colourTokens.length; j++) {
      const a = colourTokens[i];
      const b = colourTokens[j];
      if (a.cv === b.cv) continue;
      const de = deltaE(a.c, b.c);
      if (de <= NEAR) nearWithin.push({ state: st.key, a: a.name, b: b.name, aValue: a.cv, bValue: b.cv, deltaE: +de.toFixed(2) });
    }
  }
}
// same token, identical value across designs (per theme)
const crossDesignSame = [];
for (const name of availability.keys()) {
  for (const th of ["dark", "light"]) {
    const groups = new Map();
    for (const d of DESIGNS) {
      const v = valueOf(name, { design: d, theme: th });
      if (v === null) continue;
      const cv = canonColour(v);
      if (!groups.has(cv)) groups.set(cv, []);
      groups.get(cv).push(d);
    }
    for (const [value, ds] of groups) if (ds.length >= 3) crossDesignSame.push({ token: name, theme: th, value, designs: ds });
  }
}
crossDesignSame.sort((a, b) => b.designs.length - a.designs.length || a.token.localeCompare(b.token));
// design similarity: share of colour tokens (opaque) within deltaE <= NEAR, among tokens both define
const similarity = [];
for (const th of ["dark", "light"]) {
  for (let i = 0; i < DESIGNS.length; i++) {
    for (let j = i + 1; j < DESIGNS.length; j++) {
      let both = 0;
      let same = 0;
      for (const name of availability.keys()) {
        const va = valueOf(name, { design: DESIGNS[i], theme: th });
        const vb = valueOf(name, { design: DESIGNS[j], theme: th });
        if (va === null || vb === null) continue;
        const ca = parseColour(va);
        const cb = parseColour(vb);
        if (!ca || !cb || ca.a < 1 || cb.a < 1) continue;
        both++;
        if (deltaE(ca, cb) <= NEAR) same++;
      }
      if (both) similarity.push({ theme: th, a: DESIGNS[i], b: DESIGNS[j], sharedColourTokens: both, nearIdentical: same, share: +(same / both).toFixed(2) });
    }
  }
}
similarity.sort((x, y) => y.share - x.share);

// =====================================================================================
// Hard-coded colours in CSS
// =====================================================================================
const hardcoded = []; // in rule declarations (not token definitions)
const tokenDefLiterals = []; // raw colours inside --x definitions (legitimate token values)
for (const [file, rules] of parsed) {
  for (const r of rules) {
    for (const d of r.decls) {
      const raws = findRawColours(d.value, d.prop.startsWith("--") ? "color" : d.prop);
      for (const c of raws) {
        const rec = { file: relSrc(file), line: d.line, selector: (r.selector ?? "").replace(/\s+/g, " ").slice(0, 90), prop: d.prop, value: c.value, kind: c.kind, inVarFallback: c.inFallback };
        if (d.prop.startsWith("--")) tokenDefLiterals.push(rec);
        else hardcoded.push(rec);
      }
    }
  }
}
const hcByFile = sortedEntries(new Map([...hardcoded.reduce((m, h) => m.set(h.file, (m.get(h.file) ?? 0) + 1), new Map())]));
const hcByValue = sortedEntries(new Map([...hardcoded.reduce((m, h) => m.set(canonColour(h.value), (m.get(canonColour(h.value)) ?? 0) + 1), new Map())]));
const hcByProp = sortedEntries(new Map([...hardcoded.reduce((m, h) => m.set(h.prop, (m.get(h.prop) ?? 0) + 1), new Map())]));
const hcByKind = Object.fromEntries(sortedEntries(new Map([...hardcoded.reduce((m, h) => m.set(h.kind, (m.get(h.kind) ?? 0) + 1), new Map())])));
const hcLeaf = hardcoded.filter((h) => !/modern\.css$/.test(h.file) || true);
void hcLeaf;

// defined-but-unused tokens
const unused = [...definedRoot].filter((n) => !tokens.has(n) || tokens.get(n).uses === tokens.get(n).tokenDefinitionUses).sort();
// tokens referenced only by other token definitions
const onlyViaDefs = [...definedRoot].filter((n) => tokens.has(n) && tokens.get(n).uses > 0 && tokens.get(n).uses === tokens.get(n).tokenDefinitionUses).sort();

// =====================================================================================
// Output
// =====================================================================================
const git = gitInfo();
const generatedAt = new Date().toISOString();
const usedNames = [...tokens.keys()].sort();
const counts = {
  filesScanned: { css: cssFiles.length, tsAndTsx: codeFiles.length },
  distinctTokensUsed: usedNames.length,
  totalUses: uses.length,
  usesByKind: { css: uses.filter((u) => u.kind === "css").length, tsx: uses.filter((u) => u.kind === "tsx").length, jsRead: uses.filter((u) => u.kind === "js-read").length },
  usesWithFallback: uses.filter((u) => u.hasFallback).length,
  distinctTokensDefinedInCss: new Set(defs.map((d) => d.name)).size,
  distinctTokensDefinedAtRoot: definedRoot.size,
  inlineDefinedTokens: [...new Set(inlineDefs.map((d) => d.name))].sort(),
  undefinedTokens: undefinedTokens.map((u) => u.token),
  classicGaps: classicGaps.map((g) => g.token),
  hardcodedColourDeclarationsInCss: hardcoded.length,
  hardcodedColourFilesInCss: hcByFile.length,
  tokenDefinitionColourLiterals: tokenDefLiterals.length,
  statesModelled: STATES.length,
};
const classicOwn = own.classic;
const reproduction = [
  { metric: "tokens used but defined nowhere", earlier: PRIOR.undefinedTokens.join(", "), measured: undefinedTokens.map((u) => u.token).join(", ") || "(none)", match: JSON.stringify(undefinedTokens.map((u) => u.token).sort()) === JSON.stringify([...PRIOR.undefinedTokens].sort()) },
  { metric: "tokens Classic defines (own)", earlier: `~${PRIOR.classicTokens}`, measured: classicOwn.all.size, match: classicOwn.all.size === PRIOR.classicTokens },
  { metric: "tokens a design defines (own, min-max)", earlier: `${PRIOR.designTokensRange[0]}-${PRIOR.designTokensRange[1]}`, measured: `${Math.min(...definedSummary.filter((d) => d.design !== "classic").map((d) => d.ownTokens))}-${Math.max(...definedSummary.filter((d) => d.design !== "classic").map((d) => d.ownTokens))}`, match: definedSummary.filter((d) => d.design !== "classic").every((d) => d.ownTokens >= PRIOR.designTokensRange[0] && d.ownTokens <= PRIOR.designTokensRange[1]) },
];

const result = {
  tool: "web-e2e/tools/token-scan.mjs",
  generatedAt,
  git,
  scanned: { srcDir: rel(SRC), cssBundleOrder: ORDER.map(relSrc), designs: DESIGNS, typescript: ts.version },
  model: "7 designs x 2 themes = 14 states; Classic = styles.css; other designs = styles.css + designs/modern.css (:root[data-design]) + designs/<id>.css; dark = default (no attribute), light = data-theme=light. Inferred from selectors, not rendered.",
  counts,
  reproduction,
  undefinedTokens,
  usedButMissingInSomeState: missingBy,
  classicGaps: classicGaps.map((g) => ({ token: g.token, allUsesHaveFallback: g.allWithFallback, sites: g.sites })),
  definedSummary,
  designOnlyTokens: designOnly,
  classicTokensNotInDesign: classicNotInDesign,
  tokensDefinedBySomeDesignsOnly: inconsistent,
  themeGapsWithinDesign: themeGaps,
  modernCss: { file: modernFile ? relSrc(modernFile) : null, tokensDefinedByModern: [...modernDefines].sort(), tokensUsed: modernUsed.length, matrix: modernMatrix, notDefinedByEveryDesignFile: modernNotInEveryDesign.map((r) => r.token), effectiveGaps: modernEffectiveGaps.map((r) => r.token) },
  duplicates: { identicalValuesWithinState: identicalWithin, nearIdenticalColoursWithinState: nearWithin, sameValueAcrossThreeOrMoreDesigns: crossDesignSame, designSimilarity: similarity, nearThresholdDeltaE76: NEAR },
  hardcodedColoursInCss: { byFile: Object.fromEntries(hcByFile), byKind: hcByKind, byProperty: Object.fromEntries(hcByProp), byValue: Object.fromEntries(hcByValue), declarations: hardcoded, tokenDefinitionLiterals: tokenDefLiterals.length },
  unusedDefinedTokens: unused,
  tokenUse: usedNames.map((n) => {
    const t = tokens.get(n);
    return { token: n, uses: t.uses, css: t.usesCss, tsx: t.usesTsx, withFallback: t.withFallback, withoutFallback: t.withoutFallback, files: Object.fromEntries(sortedEntries(t.files)), definedAtRoot: definedRoot.has(n), definedAnywhere: definedAnywhere.has(n) };
  }),
  definitions: defs.map((d) => ({ token: d.name, value: d.value, at: `${d.file}:${d.line}`, selector: (d.selector ?? "").replace(/\s+/g, " ").slice(0, 120), scopes: d.alts.map((a) => (a.scope === "root" ? `root${a.design ? `[design=${a.design}]` : ""}${a.theme ? `[theme=${a.theme}]` : ""}` : a.scope)) })),
  inlineDefinitions: inlineDefs,
};

function mdOut() {
  const L = [];
  const non = DESIGNS.filter((d) => d !== "classic");
  L.push("# Token scan (before-numbers)");
  L.push("");
  L.push(`Generated ${generatedAt} from commit \`${git.commit ?? "unknown"}\` (${git.describe ?? ""}) by \`web-e2e/tools/token-scan.mjs\`. Evidence: **observed** = parsed from the files; **inferred** = state model (7 designs x 2 themes) reasoned from the selectors and CSS import order, not rendered in a browser.`);
  L.push("");
  L.push(`Scope: ${cssFiles.length} CSS files and ${codeFiles.length} .ts/.tsx files under \`${rel(SRC)}\`. CSS bundle order: ${ORDER.map((f) => "`" + relSrc(f).replace("web/src/", "") + "`").join(" -> ")}.`);
  L.push("");
  L.push("## Headline");
  L.push("");
  L.push(
    mdTable(
      ["Metric", "Value"],
      [
        ["Distinct tokens used (`var(--x)`)", `${usedNames.length} (${counts.totalUses} uses: ${counts.usesByKind.css} in CSS, ${counts.usesByKind.tsx} in .tsx strings; ${counts.usesWithFallback} have a fallback)`],
        ["Distinct tokens defined at root scope", definedRoot.size],
        ["Used but defined nowhere", undefinedTokens.map((u) => `\`${u.token}\` (${u.uses} use${u.uses === 1 ? "" : "s"}, ${u.withFallback} with fallback)`).join(", ") || "none"],
        ["Used in global code but missing from Classic", classicGaps.map((g) => `\`${g.token}\`${g.allWithFallback ? " (always has a fallback)" : " (NO fallback somewhere)"}`).join(", ") || "none"],
        ["Tokens Classic defines (own)", `${classicOwn.all.size}: ${[...classicOwn.all].join(", ")}`],
        ["Tokens each design defines (own)", non.map((d) => `${d} ${own[d].all.size}`).join(", ")],
        ["Hard-coded colour declarations in CSS (outside token definitions)", `${hardcoded.length} in ${hcByFile.length} files`],
        ["Defined tokens never used outside other token definitions", unused.length],
      ]
    )
  );
  L.push("");
  L.push("### Reproduction of the earlier findings");
  L.push("");
  L.push(mdTable(["Metric", "Earlier", "Measured here", "Match"], reproduction.map((r) => [r.metric, r.earlier, r.measured, r.match ? "yes" : "NO"])));
  L.push("");
  const bad = reproduction.filter((r) => !r.match);
  L.push(bad.length ? "Differences: " + bad.map((r) => `${r.metric} (earlier ${r.earlier}, measured ${r.measured})`).join("; ") + "." : "All earlier findings reproduce.");
  L.push("");

  L.push("## Used but undefined");
  L.push("");
  L.push(undefinedTokens.length ? mdTable(["Token", "Uses", "With fallback", "Fallback values", "Where"], undefinedTokens.map((u) => [u.token, u.uses, u.withFallback, u.fallbacks.map((f) => "`" + f + "`").join(", "), u.sites.join(", ")])) : "None.");
  L.push("");
  L.push("Effect: these resolve to their fallback in every design, so they can never follow a design or theme. Fix by defining them as tokens (default = the current fallback) and using the token.");
  L.push("");
  L.push("## Defined for some designs but not for all states that use them");
  L.push("");
  L.push("A token is checked against the states its using code runs in: global code (styles.css, .tsx) in all 14 states; `designs/modern.css` in the 12 non-Classic states; `designs/<id>.css` in that design only; `designs/index.css` (the picker) in all states, with `[data-design-preview]` swatch definitions counted.");
  L.push("");
  L.push(
    missingBy.length
      ? mdTable(
          ["Token", "Missing in", "Sites", "Fallback?"],
          missingBy.map((m) => [m.token, m.missingInStates.length === STATES.length ? "all states" : m.missingInStates.length > 6 ? `${m.missingInStates.length} states (${[...new Set(m.missingInStates.map((s) => s.split("/")[0]))].join(", ")})` : m.missingInStates.join(", "), m.sites.map((s) => s.at).join(", "), m.allWithFallback ? "always" : "NOT always: " + m.withoutFallbackSites.join(", ")])
        )
      : "None."
  );
  L.push("");
  L.push("## modern.css tokens versus the design files");
  L.push("");
  L.push(`\`${modernFile ? relSrc(modernFile) : "?"}\` is the shared structural layer for all six non-Classic designs; it uses ${modernUsed.length} distinct tokens and itself defines ${modernDefines.size} (${[...modernDefines].join(", ") || "none"}).`);
  L.push("");
  L.push(`Tokens modern.css uses that are **not defined by every design file** (own definitions only): ${modernNotInEveryDesign.length}.`);
  L.push("");
  if (modernNotInEveryDesign.length) {
    L.push(mdTable(["Token", "Uses in modern.css", ...non, "Classic root", "Effective in all states"], modernNotInEveryDesign.map((r) => [r.token, r.usesInModern, ...non.map((d) => (r.designFile[d] ? "yes" : "NO")), r.classicRootDefines ? "yes" : "no", Object.values(r.effective).every(Boolean) ? "yes" : r.undefinedEverywhere ? "undefined everywhere" : "NO"])));
  } else L.push("Every token modern.css uses is defined by all six design files (or by modern.css itself).");
  L.push("");
  L.push(`Of those, tokens still unresolved in at least one non-Classic state after counting Classic's \`:root\` and modern.css: ${modernEffectiveGaps.length ? modernEffectiveGaps.map((r) => "`" + r.token + "`").join(", ") : "none"}.`);
  L.push("");
  L.push("## Defined tokens: Classic versus each design");
  L.push("");
  L.push(mdTable(["Design", "Defined in", "Own tokens", "of which colour / shadow / font / radius / other", "Own (dark)", "Own (light)", "Effective (dark)", "Effective (light)"], definedSummary.map((d) => [d.design, d.file ?? "-", d.ownTokens, `${d.breakdown.colour} / ${d.breakdown.shadow} / ${d.breakdown.font} / ${d.breakdown.radius} / ${d.breakdown.other}`, d.ownDark, d.ownLight, d.effectiveDark, d.effectiveLight])));
  L.push("");
  L.push("'Own' = distinct tokens defined by that design's own file (Classic: styles.css `:root` blocks); dark values sit in the unqualified block, light values in the `[data-theme=\"light\"]` block, so own (dark) = own (light) when a design themes every token. 'Effective' = resolved in that state after cascade, including Classic's `:root` values and modern.css (+1 for modern.css's `--t-fast`).");
  L.push("");
  {
    const ds = definedSummary.filter((d) => d.design !== "classic");
    const range = (k) => {
      const v = ds.map((d) => (k === "total" ? d.ownTokens : d.breakdown[k]));
      return Math.min(...v) === Math.max(...v) ? `${Math.min(...v)}` : `${Math.min(...v)}-${Math.max(...v)}`;
    };
    const ok = ds.every((d) => d.ownTokens >= PRIOR.designTokensRange[0] && d.ownTokens <= PRIOR.designTokensRange[1]);
    L.push(
      ok
        ? `The earlier figure of ${PRIOR.designTokensRange.join("-")} tokens per design is reproduced.`
        : `The earlier figure of ${PRIOR.designTokensRange.join("-")} tokens per design is **not reproduced**: each design file defines ${range("total")} distinct custom properties (${range("colour")} colour, ${range("shadow")} shadow, ${range("radius")} radius, ${range("font")} font, ${range("other")} other layout/typography tokens). The earlier number may have counted a subset; the breakdown above is exact for this commit.`
    );
  }
  L.push("");
  L.push("Tokens Classic defines: " + [...classicSet].map((t) => "`" + t + "`").join(", ") + ".");
  L.push("");
  const designOnlyCommon = [...designTokenUnion].filter((t) => !classicSet.has(t) && non.every((d) => own[d].all.has(t))).sort();
  L.push(`Tokens every design defines that Classic lacks (${designOnlyCommon.length}): ${designOnlyCommon.map((t) => "`" + t + "`").join(", ")}.`);
  L.push("");
  L.push(inconsistent.length ? "Tokens defined by only some designs:" : "Every token defined by any design is defined by all six designs.");
  L.push("");
  if (inconsistent.length) L.push(mdTable(["Token", "Defined by", "Missing from"], inconsistent.map((x) => [x.token, x.definedBy.join(", "), x.missingFrom.join(", ")])));
  L.push("");
  if (themeGaps.length) {
    L.push("Defined for one theme only inside a design:");
    L.push("");
    L.push(mdTable(["Design", "Token", "Only in"], themeGaps.map((g) => [g.design, g.token, g.onlyIn])));
    L.push("");
  }
  L.push("## Duplicate and near-duplicate values");
  L.push("");
  L.push(`Colours are compared as opaque sRGB; "near" means CIE76 delta-E <= ${NEAR} (roughly one just-noticeable difference).`);
  L.push("");
  // collapse identical groups across states
  const idMap = new Map();
  for (const g of identicalWithin) {
    const k = g.tokens.join(" = ");
    if (!idMap.has(k)) idMap.set(k, []);
    idMap.get(k).push(`${g.state} (${g.value})`);
  }
  L.push("### Tokens with identical values inside one design and theme");
  L.push("");
  L.push(idMap.size ? mdTable(["Tokens", "Where (state and value)"], [...idMap.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, v.length > 6 ? `${v.length} states, e.g. ${v.slice(0, 3).join("; ")}` : v.join("; ")])) : "None.");
  L.push("");
  L.push("### Different tokens with near-identical colours inside one design and theme");
  L.push("");
  const nearMap = new Map();
  for (const g of nearWithin) {
    const k = `${g.a} ~ ${g.b}`;
    if (!nearMap.has(k)) nearMap.set(k, []);
    nearMap.get(k).push(`${g.state} (${g.aValue} vs ${g.bValue}, dE ${g.deltaE})`);
  }
  L.push(nearMap.size ? mdTable(["Token pair", "States"], [...nearMap.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 40).map(([k, v]) => [k, v.length > 5 ? `${v.length} states, e.g. ${v.slice(0, 2).join("; ")}` : v.join("; ")])) : "None.");
  L.push("");
  L.push("### Same token, same value in three or more designs (candidates for a shared default)");
  L.push("");
  L.push(crossDesignSame.length ? mdTable(["Token", "Theme", "Value", "Designs"], crossDesignSame.slice(0, 40).map((x) => [x.token, x.theme, x.value, x.designs.join(", ")])) : "None.");
  if (crossDesignSame.length > 40) L.push(`\n(${crossDesignSame.length - 40} more in the JSON.)`);
  L.push("");
  L.push("### How different are the designs? (share of opaque colour tokens within delta-E 3, most similar first)");
  L.push("");
  L.push(mdTable(["Theme", "Pair", "Shared colour tokens", "Near-identical", "Share"], similarity.slice(0, 16).map((s) => [s.theme, `${s.a} / ${s.b}`, s.sharedColourTokens, s.nearIdentical, `${Math.round(s.share * 100)}%`])));
  L.push("");
  L.push("## Hard-coded colours in CSS");
  L.push("");
  L.push(`${hardcoded.length} colour literals sit in rule declarations (not in \`--x:\` definitions) across ${hcByFile.length} CSS file(s); a further ${tokenDefLiterals.length} literals are token definition values (expected). By kind: ${JSON.stringify(hcByKind)}.`);
  L.push("");
  if (hardcoded.length) {
    L.push(mdTable(["File", "Declarations"], hcByFile));
    L.push("");
    L.push(mdTable(["Value", "Count"], hcByValue.slice(0, 20)));
    L.push("");
    const modernHard = hardcoded.filter((h) => /designs\/modern\.css$/.test(h.file)).length;
    if (modernHard) L.push(`designs/modern.css opens with the claim that it "never hardcodes a color", yet it contains ${modernHard} hard-coded colour declarations (listed below); they are the white-on-danger button text and the poster banner greys/scrim.`);
    if (modernHard) L.push("");
    L.push(mdTable(["File:line", "Property", "Value", "Selector"], hardcoded.slice(0, 80).map((h) => [`${h.file.replace("web/src/", "")}:${h.line}`, h.prop, h.value, "`" + h.selector + "`"])));
    if (hardcoded.length > 80) L.push(`\n(${hardcoded.length - 80} more in the JSON.)`);
  }
  L.push("");
  L.push("Raw colours in inline styles are counted by the inline-style ledger (`inline-style-ledger.md`), not here.");
  L.push("");
  L.push("## Defined but unused");
  L.push("");
  L.push(unused.length ? unused.map((t) => "`" + t + "`").join(", ") + "." : "None.");
  L.push("");
  L.push("## Token usage (top 30)");
  L.push("");
  L.push(mdTable(["Token", "Uses", "CSS", "TSX", "With fallback", "Defined at root"], result.tokenUse.slice().sort((a, b) => b.uses - a.uses).slice(0, 30).map((t) => [t.token, t.uses, t.css, t.tsx, t.withFallback, t.definedAtRoot ? "yes" : "NO"])));
  L.push("");
  L.push("## Method and limits");
  L.push("");
  L.push("- CSS is parsed with a small scanner that strips comments, follows native CSS nesting (`&`), expands `:is(...)` and classifies each selector as root scope, preview-swatch scope or component scope. Specificity is approximated; ties go to the later rule in bundle order.");
  L.push("- `.tsx`/`.ts` string literals and template chunks are read through the TypeScript AST so comments and identifiers are never miscounted. Inline style keys `'--x'` and `style.setProperty` calls count as definitions.");
  L.push("- Not covered: the admin's custom theme served at `/api/theme.css` (runtime config, can define more tokens), tokens set from JavaScript at runtime other than the patterns above, `@property` registrations, and anything inside the API docs bundle.");
  L.push("- The 14-state model is reasoned from the selectors; it has not been checked by computing styles in a browser. The Phase 0 sweep can confirm it.");
  L.push("");
  return L.join("\n");
}

// ---------- baseline ----------
function buildBaseline() {
  return {
    schema: 1,
    description: "Token ratchet baseline. `--check` fails if a new undefined token appears, a token loses its definition in Classic, or hard-coded colour declarations in CSS increase.",
    commit: git.commit,
    generatedAt,
    undefinedTokens: undefinedTokens.map((u) => u.token),
    classicGapTokens: classicGaps.map((g) => g.token),
    classicGapTokensWithoutFallback: classicGapsNoFallback.map((g) => g.token),
    hardcodedColourDeclarationsInCss: hardcoded.length,
    hardcodedColourByFile: Object.fromEntries(hcByFile),
    distinctTokensDefinedAtRoot: definedRoot.size,
  };
}

if (args.check) {
  if (!fs.existsSync(BASELINE)) {
    console.error(`No baseline at ${rel(BASELINE)}. Run with --update-baseline first.`);
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const cur = buildBaseline();
  let failed = false;
  console.log(`Token ratchet against ${rel(BASELINE)} (baseline commit ${base.commit}, now ${git.commit})`);
  const newUndef = cur.undefinedTokens.filter((t) => !base.undefinedTokens.includes(t));
  const newClassicGap = cur.classicGapTokensWithoutFallback.filter((t) => !base.classicGapTokensWithoutFallback.includes(t));
  const hcDelta = cur.hardcodedColourDeclarationsInCss - base.hardcodedColourDeclarationsInCss;
  console.log(`  undefined tokens        baseline ${base.undefinedTokens.length}  now ${cur.undefinedTokens.length}  ${newUndef.length ? "FAIL new: " + newUndef.join(", ") : "ok"}`);
  console.log(`  Classic gaps w/o fallback baseline ${base.classicGapTokensWithoutFallback.length}  now ${cur.classicGapTokensWithoutFallback.length}  ${newClassicGap.length ? "FAIL new: " + newClassicGap.join(", ") : "ok"}`);
  console.log(`  hard-coded CSS colours  baseline ${base.hardcodedColourDeclarationsInCss}  now ${cur.hardcodedColourDeclarationsInCss}  ${hcDelta > 0 ? "FAIL (+" + hcDelta + ")" : hcDelta < 0 ? "improved" : "ok"}`);
  if (newUndef.length || newClassicGap.length || hcDelta > 0) failed = true;
  const grew = Object.entries(cur.hardcodedColourByFile).filter(([f, n]) => n > (base.hardcodedColourByFile[f] ?? 0));
  if (grew.length) console.log("Files that gained hard-coded colours: " + grew.map(([f, n]) => `${f} ${base.hardcodedColourByFile[f] ?? 0}->${n}`).join(", "));
  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(failed ? 1 : 0);
}

writeJson(path.join(OUT, "token-scan.json"), result);
writeText(path.join(OUT, "token-scan.md"), mdOut());
log(`Wrote ${rel(path.join(OUT, "token-scan.json"))} and ${rel(path.join(OUT, "token-scan.md"))}`);
if (args["update-baseline"]) {
  writeJson(BASELINE, buildBaseline());
  log(`Wrote baseline ${rel(BASELINE)}`);
}
log(
  `tokens used ${usedNames.length} | defined at root ${definedRoot.size} | undefined: ${undefinedTokens.map((u) => u.token).join(", ") || "none"} | Classic gaps: ${classicGaps.map((g) => g.token).join(", ") || "none"} | Classic own ${classicOwn.all.size} | design own ${DESIGNS.filter((d) => d !== "classic").map((d) => own[d].all.size).join("/")} | hard-coded CSS colours ${hardcoded.length}`
);
