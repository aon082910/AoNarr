#!/usr/bin/env node
// Route / navigation / palette / in-page-link graph per role, extracted from web/src with the
// TypeScript compiler API (no install, read-only, no network).
//
//   node web-e2e/tools/route-nav-graph.mjs [--src <web/src dir>] [--out <dir>] [--quiet]
//
// Writes route-nav-graph.json, route-nav-graph.md and sitemap.mmd (Mermaid, admin role) to --out
// (default redesign-concepts/phase0). `--src` lets the same extractor run on an exported copy of an
// old commit's web/src (for example `git archive <tag> web/src`) so two JSON files can be diffed.
//
// Evidence labels used in the outputs:
//   observed  = read straight from the AST (a Route element, a nav array entry, a palette entry, a call site)
//   inferred  = derived by this script from observed facts (reachability, click depth, import-graph attribution)
// Click depth is deliberately reported as a WEAK metric (Porter 2003: click count did not predict task success);
// path count, role asymmetry, palette coverage and cross-links are the primary signals.
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
  lineOf,
  mdTable,
} from "./_common.mjs";

const args = parseArgs(process.argv.slice(2));
const ts = loadTypeScript();
const K = ts.SyntaxKind;
const SRC = path.resolve(args.src ?? path.join(REPO_ROOT, "web", "src"));
const OUT = path.resolve(args.out ?? path.join(REPO_ROOT, "redesign-concepts", "phase0"));
const quiet = !!args.quiet;
const log = (...a) => {
  if (!quiet) console.log(...a);
};
const relSrc = (file) => "web/src/" + toPosix(path.relative(SRC, file));
const warnings = [];
const warn = (m) => warnings.push(m);

/** Earlier agent's numbers, reproduced or contradicted below. */
const PRIOR = {
  routeElementsAppRange: [49, 52],
  routeElementsApp: 50,
  adminGated: 31,
  open: 19,
  staticRoutes: 38,
  paletteStaticCovered: 18,
  routesWithoutNavLink: ["/add/preview"],
};

/**
 * Hand-verified annotations (read by a person at commit c57aa2e). The AST can only see lexical isAdmin guards; these two links are
 * gated by data flow instead. Matched by file + target route, so they survive small line shifts; remove them if the code changes.
 */
const MANUAL_ROLE_NOTES = [
  { file: "web/src/pages/GlobalSearch.tsx", target: "/add/preview", note: "data-gated: the 'Add new' result cards only exist for admins (GlobalSearch.tsx:82-83 returns before fetching metadata results when !auth.isAdmin), so goAdd() is never reachable by a household account" },
  { file: "web/src/pages/Dashboard.tsx", target: "/system", note: "data-gated: the health banner needs /system/health, which Dashboard.tsx fetches only when auth.isAdmin (lines 132-134), so household never sees the 'View System' button" },
];

// ---------- parsing helpers ----------
function parse(file) {
  const text = readText(file);
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function unwrap(e) {
  let x = e;
  while (x && (x.kind === K.ParenthesizedExpression || x.kind === K.AsExpression || x.kind === K.SatisfiesExpression || x.kind === K.NonNullExpression || x.kind === K.TypeAssertionExpression)) x = x.expression;
  return x;
}
const tagText = (el, sf) => el.tagName.getText(sf);
function openingOf(node) {
  if (ts.isJsxSelfClosingElement(node)) return node;
  if (ts.isJsxElement(node)) return node.openingElement;
  return null;
}
function jsxAttr(opening, name) {
  for (const a of opening.attributes.properties) if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === name) return a;
  return undefined;
}
/** Value expression of a JSX attribute (string literal initializer or {expr}); null if bare boolean. */
function attrExpr(attr) {
  if (!attr || !attr.initializer) return null;
  if (ts.isJsxExpression(attr.initializer)) return attr.initializer.expression ? unwrap(attr.initializer.expression) : null;
  return attr.initializer; // StringLiteral
}
function paramName(expr) {
  const e = unwrap(expr);
  if (!e) return "x";
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "encodeURIComponent" && e.arguments[0]) return paramName(e.arguments[0]);
  return "x";
}
/** Resolve an expression to a path-ish string, template spans become :name. */
function stringish(expr, sf) {
  const e = unwrap(expr);
  if (!e) return { unresolved: true, expr: "" };
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { text: e.text, dynamic: false };
  if (ts.isTemplateExpression(e)) {
    let text = e.head.text;
    for (const span of e.templateSpans) text += ":" + paramName(span.expression) + span.literal.text;
    return { text, dynamic: true };
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === K.PlusToken) {
    const l = stringish(e.left, sf);
    const r = stringish(e.right, sf);
    if (!l.unresolved && !r.unresolved) return { text: l.text + r.text, dynamic: true };
    if (!l.unresolved && r.unresolved) return { text: l.text + ":" + paramName(e.right), dynamic: true };
  }
  return { unresolved: true, expr: e.getText(sf).slice(0, 80) };
}
function normalisePath(raw) {
  let p = raw;
  let query = "";
  const cut = p.search(/[?#]/);
  if (cut !== -1) {
    query = p.slice(cut + 1).replace(/^[?#]/, "");
    p = p.slice(0, cut);
  }
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (!p) p = "/";
  return { path: p, query };
}
function queryKeys(q) {
  return q
    .split("&")
    .map((s) => s.split("=")[0])
    .filter(Boolean);
}

// ---------- 1. routes ----------
function roleOfGate(text) {
  const t = text.replace(/\s+/g, "");
  if (/^\(?(auth\.)?isAdmin\)?$/.test(t)) return "admin";
  if (/^!\(?(auth\.)?isAdmin\)?$/.test(t)) return "non-admin";
  return null;
}
function gatesFor(node, sf) {
  const gates = [];
  let child = node;
  let n = node.parent;
  while (n) {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === K.AmpersandAmpersandToken && n.right === child) gates.push(n.left.getText(sf));
    else if (ts.isConditionalExpression(n)) {
      if (n.whenTrue === child) gates.push(n.condition.getText(sf));
      else if (n.whenFalse === child) gates.push("!(" + n.condition.getText(sf) + ")");
    }
    child = n;
    n = n.parent;
  }
  return gates;
}
/** Polarity of a condition with respect to isAdmin: 'pos' (true => admin), 'neg' (true => not admin), 'complex', or null (no mention). */
function adminPolarity(text) {
  const parts = text.split("&&").map((s) => s.replace(/\s+/g, "").replace(/^\(+|\)+$/g, ""));
  if (parts.some((p) => /^(auth\.)?isAdmin$/.test(p))) return { kind: "pos", exact: parts.length === 1 };
  if (parts.some((p) => /^!\(?(auth\.)?isAdmin\)?$/.test(p))) return { kind: "neg", exact: parts.length === 1 };
  if (/isAdmin/.test(text)) return { kind: "complex", exact: false };
  return null;
}
function mergeRole(a, b) {
  if (!a || a === "both") return b ?? "both";
  if (!b || b === "both") return a;
  return a === b ? a : "unknown";
}
/**
 * Which role can actually see/trigger the code at `node`, judged from enclosing `isAdmin` guards:
 * ancestor `&&`, ternaries and if-statements, plus early returns before it in any enclosing block.
 * Returns 'admin' | 'household' | 'unknown' | 'both'. `stop` ends the climb (used for a Route's element).
 * Heuristic: a guard buried in a helper function or a prop is not seen.
 */
const usageCache = new WeakMap(); // SourceFile -> Map(name -> Identifier[] usages, declarations excluded)
function usagesOf(sf, name) {
  let m = usageCache.get(sf);
  if (!m) {
    m = new Map();
    const v = (n) => {
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        const isDecl = (ts.isFunctionDeclaration(p) && p.name === n) || (ts.isVariableDeclaration(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isParameter(p) && p.name === n) || (ts.isPropertyAccessExpression(p) && p.name === n);
        if (!isDecl) {
          const arr = m.get(n.text) ?? [];
          arr.push(n);
          m.set(n.text, arr);
        }
      }
      ts.forEachChild(n, v);
    };
    v(sf);
    usageCache.set(sf, m);
  }
  return m.get(name) ?? [];
}
/** Nearest enclosing function that has a name (function declaration, or `const f = () => ...`). */
function namedFunctionAround(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
  }
  return null;
}
function roleLimitOf(node, sf, stop = null, depth = 0) {
  let role = roleLimitWithin(node, sf, stop);
  // a helper like `goAdd(...)` is only as visible as the places that call it
  if (!stop && depth < 3) {
    const fn = namedFunctionAround(node);
    if (fn) {
      const uses = usagesOf(sf, fn);
      if (uses.length) {
        let merged = null;
        for (const u of uses) {
          const r = roleLimitOf(u, sf, null, depth + 1);
          merged = merged === null ? r : merged === r ? r : "both";
        }
        if (merged === "admin" || merged === "household") role = mergeRole(role, merged);
      }
    }
  }
  return role;
}
function roleLimitWithin(node, sf, stop = null) {
  let role = "both";
  const branchRole = (pol, branch) => {
    if (!pol) return "both";
    if (pol.kind === "complex") return "unknown";
    const thenRole = pol.kind === "pos" ? "admin" : "household";
    if (branch === "then") return thenRole;
    // else-branch: only a definite complement when the condition is exactly isAdmin / !isAdmin
    return pol.exact ? (thenRole === "admin" ? "household" : "admin") : "both";
  };
  if (stop && node === stop) return "both"; // the element itself is the whole expression: nothing above it to examine
  let child = node;
  let n = node.parent;
  while (n) {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === K.AmpersandAmpersandToken && n.right === child) role = mergeRole(role, branchRole(adminPolarity(n.left.getText(sf)), "then"));
    else if (ts.isConditionalExpression(n)) {
      if (n.whenTrue === child) role = mergeRole(role, branchRole(adminPolarity(n.condition.getText(sf)), "then"));
      else if (n.whenFalse === child) role = mergeRole(role, branchRole(adminPolarity(n.condition.getText(sf)), "else"));
    } else if (ts.isIfStatement(n)) {
      if (n.thenStatement === child) role = mergeRole(role, branchRole(adminPolarity(n.expression.getText(sf)), "then"));
      else if (n.elseStatement === child) role = mergeRole(role, branchRole(adminPolarity(n.expression.getText(sf)), "else"));
    }
    // early-return guards earlier in an enclosing block: code after `if (cond) return` runs only when cond is false
    if (ts.isBlock(n)) {
      for (const st of n.statements) {
        if (st === child || st.pos >= child.pos) break;
        if (ts.isIfStatement(st) && !st.elseStatement) {
          const pol = adminPolarity(st.expression.getText(sf));
          const returns = ts.isReturnStatement(st.thenStatement) || ts.isThrowStatement(st.thenStatement) || (ts.isBlock(st.thenStatement) && st.thenStatement.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s)));
          if (pol && returns) {
            if (pol.kind === "complex") role = mergeRole(role, "unknown");
            else if (pol.exact) role = mergeRole(role, pol.kind === "neg" ? "admin" : "household");
          }
        }
      }
    }
    if (n === stop) break; // the stop node itself (a Route's element expression) is examined, nothing above it
    child = n;
    n = n.parent;
  }
  return role;
}
function elementComponents(expr, sf, roles = null) {
  const names = [];
  const visit = (n) => {
    const op = openingOf(n);
    if (op) {
      const nm = tagText(op, sf);
      if (/^[A-Z]/.test(nm)) {
        names.push(nm);
        if (roles) roles[nm] = mergeRole(roles[nm], roleLimitOf(n, sf, expr));
      }
    }
    ts.forEachChild(n, visit);
  };
  if (expr) visit(expr);
  return names;
}
function extractRoutes(sf, fileLabel) {
  const out = [];
  const visit = (node, parentPath) => {
    const op = openingOf(node);
    if (op && tagText(op, sf) === "Route") {
      const pathAttr = jsxAttr(op, "path");
      const idx = jsxAttr(op, "index");
      const pe = attrExpr(pathAttr);
      let own = pe ? stringish(pe, sf).text ?? "" : "";
      if (!pathAttr && !idx) warn(`${fileLabel}:${lineOf(sf, node)} <Route> without path or index`);
      let full = own;
      if (parentPath !== null && !own.startsWith("/")) full = (parentPath.replace(/\/\*?$/, "") + "/" + own).replace(/\/+/g, "/");
      if (idx) full = parentPath ?? "/";
      const elExpr = attrExpr(jsxAttr(op, "element"));
      const componentRoles = {};
      const comps = elementComponents(elExpr, sf, componentRoles);
      let redirect = null;
      if (comps[0] === "Navigate" && elExpr) {
        const navOp = openingOf(unwrap(elExpr));
        const to = navOp ? attrExpr(jsxAttr(navOp, "to")) : null;
        redirect = { to: to ? stringish(to, sf).text : "?", replace: !!(navOp && jsxAttr(navOp, "replace")) };
      }
      const gates = gatesFor(node, sf);
      out.push({
        file: fileLabel,
        line: lineOf(sf, node),
        path: full,
        ownPath: own,
        index: !!idx,
        components: comps,
        componentRoles,
        redirect,
        gates,
      });
      if (ts.isJsxElement(node)) node.children.forEach((c) => visit(c, full));
      return;
    }
    ts.forEachChild(node, (c) => visit(c, parentPath));
  };
  visit(sf, null);
  return out;
}

// ---------- imports (component -> file) ----------
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  return null;
}
function importMap(sf, file) {
  const map = new Map(); // local name -> file
  const specs = []; // all relative import specs (for graph)
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const r = resolveImport(file, n.moduleSpecifier.text);
      if (r) {
        specs.push(r);
        const clause = n.importClause;
        if (clause?.name) map.set(clause.name.text, r);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) map.set(el.name.text, r);
      }
    }
    // const X = lazy(() => import("./pages/X.js"))
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const m = /import\(\s*["']([^"']+)["']\s*\)/.exec(n.initializer.getText(sf));
      if (m) {
        const r = resolveImport(file, m[1]);
        if (r) {
          map.set(n.name.text, r);
          specs.push(r);
        }
      }
    }
    // bare dynamic import() elsewhere
    if (ts.isCallExpression(n) && n.expression.kind === K.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      const r = resolveImport(file, n.arguments[0].text);
      if (r) specs.push(r);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { map, specs: [...new Set(specs)] };
}

// ---------- 2. nav ----------
function findVarInit(sf, name) {
  let found = null;
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
function parseLinkObject(obj, sf) {
  const rec = { line: lineOf(sf, obj) };
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
    const k = p.name.text;
    if (k === "to") {
      const s = stringish(p.initializer, sf);
      rec.to = s.text ?? `?${s.expr}`;
      rec.dynamicPath = !!s.dynamic;
    } else if (k === "label") {
      const s = stringish(p.initializer, sf);
      rec.label = s.unresolved ? `{${s.expr}}` : s.text;
      rec.labelDynamic = !!s.unresolved;
    } else if (k === "end") rec.end = p.initializer.kind === K.TrueKeyword;
    else if (k === "key") rec.key = stringish(p.initializer, sf).text;
    else if (k === "links") rec.linksNode = p.initializer;
  }
  return rec;
}
/** Collect {to,label} objects from an array-ish initializer. Handles .sort() wrappers, spreads of .map(), ternaries. */
function collectLinks(node, sf, ctx = {}) {
  const e = unwrap(node);
  if (!e) return { links: [] };
  if (ts.isConditionalExpression(e)) {
    return { cond: e.condition.getText(sf), whenTrue: collectLinks(e.whenTrue, sf).links, whenFalse: collectLinks(e.whenFalse, sf).links };
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const method = e.expression.name.text;
    if (method === "sort") {
      const inner = collectLinks(e.expression.expression, sf);
      inner.sortedByLabel = true;
      return inner;
    }
    if (method === "map") {
      // x.map((t) => ({ to: `...`, label }))
      const cb = e.arguments[0];
      const body = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? unwrap(cb.body) : null;
      if (body && ts.isObjectLiteralExpression(body)) {
        const rec = parseLinkObject(body, sf);
        rec.fromData = e.expression.expression.getText(sf);
        return { links: [rec] };
      }
    }
  }
  if (ts.isArrayLiteralExpression(e)) {
    const links = [];
    for (const el of e.elements) {
      const u = unwrap(el);
      if (ts.isObjectLiteralExpression(u)) links.push(parseLinkObject(u, sf));
      else if (ts.isSpreadElement(u)) links.push(...collectLinks(u.expression, sf).links);
    }
    return { links };
  }
  return { links: [] };
}

function extractNavData(sf) {
  const lib = findVarInit(sf, "libraryLinks");
  const standalone = findVarInit(sf, "standaloneLinks");
  const adminDefs = findVarInit(sf, "adminGroupDefs");
  if (!lib) warn("App.tsx: libraryLinks not found");
  if (!standalone) warn("App.tsx: standaloneLinks not found");
  if (!adminDefs) warn("App.tsx: adminGroupDefs not found");

  const libraryLinks = lib ? collectLinks(lib.initializer, sf).links : [];
  let standaloneLinks = { admin: [], household: [] };
  if (standalone) {
    const s = collectLinks(standalone.initializer, sf);
    if (s.cond) {
      const role = roleOfGate(s.cond);
      if (role === "admin") standaloneLinks = { admin: s.whenTrue, household: s.whenFalse };
      else {
        warn(`App.tsx: standaloneLinks condition "${s.cond}" not recognised as isAdmin`);
        standaloneLinks = { admin: s.whenTrue, household: s.whenFalse };
      }
    } else standaloneLinks = { admin: s.links, household: s.links };
  }
  const groups = [];
  if (adminDefs) {
    const arr = unwrap(adminDefs.initializer);
    if (ts.isArrayLiteralExpression(arr)) {
      for (const el of arr.elements) {
        const o = unwrap(el);
        if (!ts.isObjectLiteralExpression(o)) continue;
        const rec = parseLinkObject(o, sf);
        const col = collectLinks(rec.linksNode, sf);
        let links = col.links;
        if (col.sortedByLabel) links = [...links].sort((a, b) => String(a.label).localeCompare(String(b.label)));
        groups.push({ key: rec.key, label: rec.label, line: rec.line, sortedByLabel: !!col.sortedByLabel, links });
      }
    }
  }
  return { libraryLinks, standaloneLinks, groups };
}

/** Walk the App render tree for each renderer (sidebar <nav>, top bar <header>) and collect nav constructs. */
function extractNavRenderers(sf) {
  const sidebarRoot = [];
  const topbarRoot = [];
  const visit = (n) => {
    if (ts.isJsxElement(n)) {
      const nm = tagText(n.openingElement, sf);
      const cn = attrExpr(jsxAttr(n.openingElement, "className"));
      const cnText = cn ? cn.getText(sf) : "";
      if (nm === "nav" && /sidebar/.test(cnText)) sidebarRoot.push(n);
      if (nm === "header" && /topbar/.test(cnText)) topbarRoot.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (sidebarRoot.length !== 1) warn(`App.tsx: expected 1 sidebar <nav>, found ${sidebarRoot.length}`);
  if (topbarRoot.length !== 1) warn(`App.tsx: expected 1 top-bar <header>, found ${topbarRoot.length}`);

  const labelOf = (el) => {
    // NavLink's label: nested <NavLinkContent label="..."/> else title attr
    let label = null;
    const find = (n) => {
      const op = openingOf(n);
      if (op && tagText(op, sf) === "NavLinkContent") {
        const l = attrExpr(jsxAttr(op, "label"));
        if (l) label = stringish(l, sf).text ?? `{${l.getText(sf)}}`;
      }
      if (!label) ts.forEachChild(n, find);
    };
    find(el);
    if (!label) {
      const t = attrExpr(jsxAttr(openingOf(el), "title"));
      if (t) label = stringish(t, sf).text ?? null;
    }
    return label;
  };

  function walkRenderer(root, renderer) {
    const found = [];
    const go = (node, ctx) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === K.AmpersandAmpersandToken) {
        go(node.left, ctx);
        go(node.right, { ...ctx, gates: [...ctx.gates, node.left.getText(sf)] });
        return;
      }
      if (ts.isConditionalExpression(node)) {
        go(node.condition, ctx);
        go(node.whenTrue, { ...ctx, gates: [...ctx.gates, node.condition.getText(sf)] });
        go(node.whenFalse, { ...ctx, gates: [...ctx.gates, "!(" + node.condition.getText(sf) + ")"] });
        return;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "map") {
        const recv = node.expression.expression.getText(sf);
        const cb = node.arguments[0];
        if ((recv === "standaloneLinks" || recv === "visibleGroups") && cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          go(cb.body, { ...ctx, iter: recv });
          return;
        }
      }
      const op = openingOf(node);
      if (op) {
        const nm = tagText(op, sf);
        if (nm === "NavLink") {
          const toAttr = attrExpr(jsxAttr(op, "to"));
          const s = toAttr ? stringish(toAttr, sf) : { unresolved: true, expr: "" };
          found.push({ type: "link", renderer, line: lineOf(sf, node), to: s.unresolved ? null : s.text, toExpr: s.unresolved ? s.expr : null, label: labelOf(node), gates: ctx.gates, iter: ctx.iter ?? null });
        } else if (nm === "SidebarGroup" || nm === "TopbarGroup") {
          const lbl = attrExpr(jsxAttr(op, "label"));
          const linksAttr = attrExpr(jsxAttr(op, "links"));
          found.push({
            type: "group",
            renderer,
            component: nm,
            line: lineOf(sf, node),
            label: lbl ? stringish(lbl, sf).text ?? `{${lbl.getText(sf)}}` : null,
            linksExpr: linksAttr ? linksAttr.getText(sf) : null,
            defaultOpen: !!jsxAttr(op, "defaultOpen"),
            gates: ctx.gates,
            iter: ctx.iter ?? null,
          });
        }
      }
      ts.forEachChild(node, (c) => go(c, ctx));
    };
    go(root, { gates: [], iter: null });
    return found;
  }
  return {
    sidebar: sidebarRoot[0] ? walkRenderer(sidebarRoot[0], "sidebar") : [],
    topbar: topbarRoot[0] ? walkRenderer(topbarRoot[0], "topbar") : [],
  };
}

/** Flatten the renderer constructs + nav data into one row per (renderer, role, link). */
function flattenNav(data, renderers) {
  const rows = [];
  const rolesOf = (gates) => (gates.some((g) => roleOfGate(g) === "admin") ? ["admin"] : gates.some((g) => roleOfGate(g) === "non-admin") ? ["household"] : ["admin", "household"]);
  const push = (r) => rows.push(r);
  for (const rn of ["sidebar", "topbar"]) {
    for (const c of renderers[rn]) {
      const baseRoles = rolesOf(c.gates);
      if (c.type === "link") {
        if (c.iter === "standaloneLinks") {
          for (const role of ["admin", "household"]) {
            if (!baseRoles.includes(role)) continue;
            for (const l of data.standaloneLinks[role]) push({ renderer: rn, role, to: l.to, label: l.label, group: null, clicks: 1, defaultOpen: null, line: c.line, source: "standaloneLinks", dynamicPath: false });
          }
        } else if (c.to) {
          for (const role of baseRoles) push({ renderer: rn, role, to: c.to, label: c.label, group: null, clicks: 1, defaultOpen: null, line: c.line, source: "hard-coded NavLink", dynamicPath: false });
        } else warn(`App.tsx:${c.line} NavLink with unresolved to=${c.toExpr}`);
      } else if (c.type === "group") {
        const clicksForLink = c.component === "SidebarGroup" ? (c.defaultOpen ? 1 : 2) : 2;
        if (c.linksExpr === "libraryLinks") {
          for (const role of baseRoles) for (const l of data.libraryLinks) push({ renderer: rn, role, to: l.to, label: l.label, group: c.label, clicks: clicksForLink, defaultOpen: c.defaultOpen, line: c.line, source: "libraryLinks", dynamicPath: !!l.dynamicPath });
        } else if (c.iter === "visibleGroups" || /groupByKey/.test(c.linksExpr ?? "")) {
          for (const role of baseRoles)
            for (const g of data.groups) for (const l of g.links) push({ renderer: rn, role, to: l.to, label: l.label, group: g.label, clicks: clicksForLink, defaultOpen: c.defaultOpen, line: c.line, source: `adminGroupDefs.${g.key}`, dynamicPath: false });
        } else warn(`App.tsx:${c.line} ${c.component} links=${c.linksExpr} not understood`);
      }
    }
  }
  return rows;
}

// ---------- 3. palette ----------
function extractPalette(sf) {
  const decl = findVarInit(sf, "ALL_COMMANDS");
  const commands = [];
  if (!decl) {
    warn("CommandPalette.tsx: ALL_COMMANDS not found");
    return { commands, shortcuts: [], filterRule: null };
  }
  const arr = unwrap(decl.initializer);
  if (ts.isArrayLiteralExpression(arr)) {
    for (const el of arr.elements) {
      const o = unwrap(el);
      if (!ts.isObjectLiteralExpression(o)) continue;
      const rec = { line: lineOf(sf, o), adminOnly: false };
      for (const p of o.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
        if (p.name.text === "label") rec.label = stringish(p.initializer, sf).text;
        if (p.name.text === "path") rec.path = stringish(p.initializer, sf).text;
        if (p.name.text === "adminOnly") rec.adminOnly = p.initializer.kind === K.TrueKeyword;
      }
      commands.push(rec);
    }
  }
  // how the list is filtered per role, and the two keyboard entry points
  let filterRule = null;
  const shortcuts = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "filter" && n.expression.expression.getText(sf) === "ALL_COMMANDS") filterRule = n.getText(sf).replace(/\s+/g, " ").slice(0, 120);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "navigate" && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      const line = lineOf(sf, n);
      // the `navigate(path)` inside go() is the list handler; a literal path is a keyboard shortcut ("/" jumps to search)
      shortcuts.push({ key: "/", path: n.arguments[0].text, line, note: "pressing / outside a text field jumps straight to this route" });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!filterRule || !/adminOnly/.test(filterRule) || !/isAdmin/.test(filterRule)) warn(`CommandPalette.tsx: palette filter rule not the expected adminOnly/isAdmin form (${filterRule})`);
  return { commands, shortcuts, filterRule };
}

// ---------- 4. in-page links ----------
function extractRefs(sf, fileAbs) {
  const refs = [];
  const fileRel = relSrc(fileAbs);
  const navAliases = new Set(["navigate"]);
  const dataPaths = []; // property-assigned "/..." strings named to|path|href|link in this file
  const preVisit = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(sf) === "useNavigate" && ts.isIdentifier(n.name)) navAliases.add(n.name.text);
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && /^(to|path|href|link)$/.test(n.name.text) && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer)) && n.initializer.text.startsWith("/") && !n.initializer.text.startsWith("/api")) {
      dataPaths.push({ text: n.initializer.text, line: lineOf(sf, n) });
    }
    ts.forEachChild(n, preVisit);
  };
  preVisit(sf);

  const add = (kind, node, s, extra = {}) => {
    const line = lineOf(sf, node);
    extra = { roleLimit: roleLimitOf(node, sf), ...extra };
    if (s.unresolved) {
      // data-driven target such as <Link to={step.to}>: take literal candidates from the same file
      if (/^[\w$]+(\.[\w$]+)+$/.test(s.expr) && /\.(to|path|href|link)$/.test(s.expr) && dataPaths.length) {
        for (const d of dataPaths) {
          const np = normalisePath(d.text);
          refs.push({ file: fileRel, line, kind, via: "data-literal", raw: s.expr, path: np.path, query: np.query, dynamic: false, ...extra, inferred: true });
        }
        return;
      }
      refs.push({ file: fileRel, line, kind, raw: s.expr, unresolved: true, ...extra });
      return;
    }
    if (!s.text.startsWith("/")) {
      refs.push({ file: fileRel, line, kind, raw: s.text, relative: true, ...extra });
      return;
    }
    if (s.text.startsWith("//")) return; // protocol-relative external
    const np = normalisePath(s.text);
    refs.push({ file: fileRel, line, kind, raw: s.text, path: np.path, query: np.query, dynamic: !!s.dynamic, ...extra });
  };

  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && navAliases.has(callee.text) && n.arguments[0]) {
        const a0 = unwrap(n.arguments[0]);
        if (ts.isNumericLiteral(a0) || (ts.isPrefixUnaryExpression(a0) && a0.operator === K.MinusToken)) refs.push({ file: fileRel, line: lineOf(sf, n), kind: "history-back", raw: n.arguments[0].getText(sf) });
        else {
          const opts = n.arguments[1] ? n.arguments[1].getText(sf).replace(/\s+/g, " ").slice(0, 60) : null;
          add("navigate()", n, stringish(a0, sf), { options: opts });
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const ct = callee.getText(sf);
        if (/(^|\.)location\.(assign|replace)$/.test(ct) && n.arguments[0]) add("location." + callee.name.text, n, stringish(n.arguments[0], sf));
        if (ct === "window.open" && n.arguments[0]) {
          const s = stringish(n.arguments[0], sf);
          if (!s.unresolved && s.text.startsWith("/")) add("window.open", n, s);
        }
      }
    }
    if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name)) {
      const opening = n.parent.parent;
      const tag = opening && opening.tagName ? opening.tagName.getText(sf) : "";
      const ex = attrExpr(n);
      if (n.name.text === "to" && (tag === "Link" || tag === "NavLink" || tag === "Navigate") && ex) add(`<${tag} to>`, n, stringish(ex, sf), { target: jsxAttr(opening, "target") ? "_blank" : undefined });
      if (n.name.text === "href" && tag === "a" && ex) {
        const s = stringish(ex, sf);
        if (!s.unresolved && s.text.startsWith("/") && !s.text.startsWith("//")) {
          if (s.text.startsWith("/api") || s.text.startsWith("/assets")) refs.push({ file: fileRel, line: lineOf(sf, n), kind: "<a href> asset/api", raw: s.text, ignored: true });
          else add("<a href>", n, s);
        }
      }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === K.EqualsToken && /(^|\.)location\.href$/.test(n.left.getText(sf))) add("location.href =", n, stringish(n.right, sf));
    if (ts.isTemplateExpression(n) && n.head.text === "" && n.templateSpans.length >= 1 && /origin|externalUrl/.test(n.templateSpans[0].expression.getText(sf)) && n.templateSpans[0].literal.text.startsWith("/")) {
      // `${origin}/share/${token}` -> a URL meant to be copied and sent outside the app
      let text = n.templateSpans[0].literal.text;
      for (const span of n.templateSpans.slice(1)) text += ":" + paramName(span.expression) + span.literal.text;
      if (!text.startsWith("/api")) add("link-producer (origin URL)", n, { text, dynamic: true });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return refs;
}

// ---------- tabs / view state without URL ----------
function extractUrllessState(sf, fileAbs) {
  const fileRel = relSrc(fileAbs);
  const tabs = [];
  const views = [];
  const usesSearchParams = /useSearchParams\(/.test(sf.text);
  const usesLocationHash = /location\.hash|useLocation/.test(sf.text);
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(sf) === "useState") {
      const [a, b] = n.name.elements;
      if (a && b && ts.isBindingElement(a) && ts.isBindingElement(b) && ts.isIdentifier(a.name) && ts.isIdentifier(b.name)) {
        const stateName = a.name.text;
        const setter = b.name.text;
        const typeArg = n.initializer.typeArguments?.[0]?.getText(sf) ?? null;
        const initial = n.initializer.arguments[0] ? n.initializer.arguments[0].getText(sf).slice(0, 40) : null;
        const line = lineOf(sf, n);
        if (/^(tab|activeTab|currentTab|section|activeSection|panel|activePanel)$/i.test(stateName)) {
          // tab ids: array of [key,label] pairs mapped into buttons that call setter
          const ids = [];
          let barLine = null;
          const find = (m) => {
            if (ts.isCallExpression(m) && ts.isPropertyAccessExpression(m.expression) && m.expression.name.text === "map") {
              const recv = unwrap(m.expression.expression);
              if (recv && ts.isArrayLiteralExpression(recv) && m.getText(sf).includes(setter + "(")) {
                barLine = lineOf(sf, m);
                for (const el of recv.elements) {
                  const u = unwrap(el);
                  if (ts.isArrayLiteralExpression(u) && u.elements[0] && ts.isStringLiteral(u.elements[0])) ids.push({ id: u.elements[0].text, label: u.elements[1] && ts.isStringLiteral(u.elements[1]) ? u.elements[1].text : null });
                }
              }
            }
            ts.forEachChild(m, find);
          };
          find(sf);
          // panels that stay mounted and are hidden with display:none
          const hiddenPanels = (sf.text.match(new RegExp(`display:\\s*${stateName}\\s*===\\s*"[^"]+"\\s*\\?\\s*undefined\\s*:\\s*"none"`, "g")) ?? []).length;
          tabs.push({ file: fileRel, line, stateName, setter, type: typeArg, initial, tabBarLine: barLine, tabs: ids, hiddenPanelsMountedWithDisplayNone: hiddenPanels, urlBound: false });
        } else if (typeArg && /^("[\w-]+"\s*\|\s*)+"[\w-]+"$/.test(typeArg.trim()) && fileRel.includes("/pages/")) {
          views.push({ file: fileRel, line, stateName, type: typeArg.trim() });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const queryKeysUsed = [];
  if (usesSearchParams) {
    // variable names bound by `const [x, setX] = useSearchParams()`: only keys read from the page URL, not API query builders
    const names = [];
    const vv = (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(sf) === "useSearchParams" && ts.isArrayBindingPattern(n.name)) {
        const first = n.name.elements[0];
        if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) names.push(first.name.text);
      }
      ts.forEachChild(n, vv);
    };
    vv(sf);
    for (const nm of names) {
      const re = new RegExp("\\b" + nm + "\\.(?:get|has|getAll)\\(\\s*[\"']([\\w-]+)[\"']", "g");
      let m;
      while ((m = re.exec(sf.text))) queryKeysUsed.push(m[1]);
    }
  }
  return { tabs, views, usesSearchParams, usesLocationHash, queryKeys: [...new Set(queryKeysUsed)], usesLocationState: /location\.state|useLocation\(\)/.test(sf.text) };
}

// =====================================================================================
// run
// =====================================================================================
const appFile = path.join(SRC, "App.tsx");
const mainFile = path.join(SRC, "main.tsx");
const paletteFile = path.join(SRC, "components", "CommandPalette.tsx");
for (const f of [appFile, mainFile, paletteFile]) if (!fs.existsSync(f)) throw new Error(`Missing ${f}`);
const appSf = parse(appFile);
const mainSf = parse(mainFile);
const paletteSf = parse(paletteFile);

const appImports = importMap(appSf, appFile);
const mainImports = importMap(mainSf, mainFile);
const appRoutesRaw = extractRoutes(appSf, "web/src/App.tsx");
const mainRoutesRaw = extractRoutes(mainSf, "web/src/main.tsx");

// route table
let routeSeq = 0;
function buildRoute(r, layer) {
  const roleGate = r.gates.map(roleOfGate).find(Boolean) ?? null;
  const otherGates = r.gates.filter((g) => !roleOfGate(g));
  const isCatchAll = r.path === "*" || r.path.endsWith("/*");
  const segs = r.path.split("/").filter(Boolean);
  const params = segs.filter((s) => s.startsWith(":")).map((s) => s.slice(1));
  const comps = r.components.filter((c) => c !== "Navigate");
  const imports = layer === "shell" ? appImports.map : mainImports.map;
  const componentFiles = comps.map((c) => imports.get(c)).filter(Boolean).map(relSrc);
  // role limit per component file (for example Onboarding is only rendered when isAdmin on the "/" route)
  const fileRoles = {};
  for (const c of comps) {
    const f = imports.get(c);
    if (f) fileRoles[relSrc(f)] = mergeRole(fileRoles[relSrc(f)], r.componentRoles?.[c] ?? "both");
  }
  let gate = "open";
  if (layer === "public") gate = "public";
  if (roleGate === "admin") gate = "admin";
  if (otherGates.length && !roleGate) gate = "conditional";
  return {
    id: `R${String(++routeSeq).padStart(2, "0")}`,
    path: r.path,
    layer,
    file: r.file,
    line: r.line,
    gate,
    gateConditions: r.gates,
    components: comps,
    componentRoles: r.componentRoles,
    fileRoles,
    componentFiles,
    redirect: r.redirect,
    catchAll: isCatchAll,
    params,
    static: params.length === 0 && !isCatchAll,
    kind: r.redirect ? "redirect" : isCatchAll ? "catch-all" : params.length ? "param" : "static",
  };
}
const mainRoutes = mainRoutesRaw.map((r) => {
  const shell = r.components.includes("ApiKeyGate") || r.components.includes("App");
  const rt = buildRoute(r, shell ? "gate" : "public");
  if (shell) rt.gate = "auth-shell";
  return rt;
});
const appRoutes = appRoutesRaw.map((r) => buildRoute(r, "shell"));
const publicRoutes = mainRoutes.filter((r) => r.layer === "public");
const shellRouteMain = mainRoutes.find((r) => r.layer === "gate");
const allRoutes = [...publicRoutes, ...appRoutes];
const navigableApp = appRoutes.filter((r) => !r.catchAll);
const catchAll = appRoutes.find((r) => r.catchAll) ?? null;

// nav + palette
const navData = extractNavData(appSf);
const navRenderers = extractNavRenderers(appSf);
const navRows = flattenNav(navData, navRenderers);
const palette = extractPalette(paletteSf);

// route matching
function segsOf(p) {
  return p.split("/").filter(Boolean);
}
function matchRoute(linkPath, candidates) {
  const L = segsOf(linkPath);
  let best = null;
  let bestScore = -1;
  for (const r of candidates) {
    const R = segsOf(r.path);
    if (R.length !== L.length) continue;
    let ok = true;
    let score = 0;
    for (let i = 0; i < R.length; i++) {
      if (R[i].startsWith(":")) {
        score += 1; // dynamic segment accepts anything
      } else if (L[i].startsWith(":")) {
        ok = false; // link is dynamic where route is static: not a guaranteed match
        break;
      } else if (R[i] === L[i]) score += 3;
      else {
        ok = false;
        break;
      }
    }
    if (ok && score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}
const matchPool = [...publicRoutes, ...navigableApp];

// in-page refs over every non-App/main file
const allSrcFiles = walk(SRC, (f) => /\.(tsx|ts)$/.test(f) && !f.endsWith(".d.ts"));
const fileSf = new Map();
const importGraph = new Map(); // abs file -> [abs files]
for (const f of allSrcFiles) {
  const sf = f === appFile ? appSf : f === mainFile ? mainSf : f === paletteFile ? paletteSf : parse(f);
  fileSf.set(f, sf);
  importGraph.set(f, importMap(sf, f).specs);
}
const refsAll = [];
for (const f of allSrcFiles) {
  if (f === appFile || f === mainFile || f === paletteFile) continue;
  refsAll.push(...extractRefs(fileSf.get(f), f));
}
// attribute refs to routes via the static import graph (inferred)
const routeByPageFile = new Map(); // abs file -> routes
for (const r of navigableApp) for (const cf of r.componentFiles) {
  const abs = path.resolve(SRC, "..", "..", cf);
  const key = path.resolve(SRC, toPosix(path.relative("web/src", cf)));
  void abs;
  if (!routeByPageFile.has(key)) routeByPageFile.set(key, []);
  routeByPageFile.get(key).push(r);
}
const pageFiles = new Set(routeByPageFile.keys());
function reachableFrom(startFile) {
  const seen = new Set([startFile]);
  const stack = [startFile];
  while (stack.length) {
    const cur = stack.pop();
    for (const nx of importGraph.get(cur) ?? []) {
      if (seen.has(nx) || pageFiles.has(nx) || nx === appFile || nx === mainFile) continue;
      seen.add(nx);
      stack.push(nx);
    }
  }
  return seen;
}
const reachByRoute = new Map(); // route id -> Set(abs files)
for (const r of navigableApp) {
  const set = new Set();
  for (const cf of r.componentFiles) {
    const key = path.resolve(SRC, toPosix(path.relative("web/src", cf)));
    reachableFrom(key).forEach((x) => set.add(x));
  }
  reachByRoute.set(r.id, set);
}
// shell files = non-page files imported directly by App.tsx or CommandPalette-level shell
const shellFiles = new Set((importGraph.get(appFile) ?? []).filter((f) => !pageFiles.has(f)));

const absOfRel = (relPath) => path.resolve(SRC, toPosix(path.relative("web/src", relPath)));
const edges = []; // {from route id (or "*shell*"), to route id|null, ...}
const danglingRefs = [];
const producerRefs = [];
const resolvedRefSites = [];
for (const ref of refsAll) {
  if (ref.kind === "history-back" || ref.ignored || ref.relative || ref.unresolved) continue;
  const target = matchRoute(ref.path, matchPool);
  const refAbs = absOfRel(ref.file);
  let sources = [];
  if (pageFiles.has(refAbs)) sources = routeByPageFile.get(refAbs).map((r) => ({ route: r, via: null, fileRole: r.fileRoles?.[ref.file] ?? "both" }));
  else {
    for (const r of navigableApp) if (reachByRoute.get(r.id)?.has(refAbs)) sources.push({ route: r, via: ref.file, fileRole: "both" });
    if (!sources.length && shellFiles.has(refAbs)) sources = [{ route: null, via: ref.file, shell: true, fileRole: "both" }];
    if (!sources.length) sources = [{ route: null, via: ref.file, orphanFile: true, fileRole: "both" }];
  }
  if (!target) {
    danglingRefs.push({ ...ref, sources: sources.map((s) => s.route?.path ?? (s.shell ? "*shell*" : "?")) });
    continue;
  }
  resolvedRefSites.push({ at: `${ref.file}:${ref.line}`, kind: ref.kind, raw: ref.raw, target: target.path, query: ref.query || undefined, roleLimit: ref.roleLimit, sources: sources.map((s) => s.route?.path ?? (s.shell ? "*shell*" : "*unattributed*")) });
  if (target.layer === "public" || ref.kind.startsWith("link-producer")) {
    producerRefs.push({ ...ref, targetRoute: target.path, sources: sources.map((s) => s.route?.path ?? "?") });
    if (ref.kind.startsWith("link-producer")) continue;
  }
  for (const s of sources) {
    edges.push({
      from: s.route ? s.route.id : s.shell ? "*shell*" : "*unattributed*",
      to: target.id,
      kind: ref.kind,
      file: ref.file,
      line: ref.line,
      via: s.via,
      query: ref.query,
      inferred: !!ref.inferred || !!s.via,
      roleLimit: mergeRole(ref.roleLimit, s.fileRole),
    });
  }
}

// ---------- role analysis ----------
const routeById = new Map(allRoutes.map((r) => [r.id, r]));
function accessible(route, role) {
  if (route.layer === "public") return true; // by URL, outside the shell
  if (role === "admin") return true;
  if (role === "household") return route.gate === "open";
  return false; // anonymous sees the login gate for every shell URL
}
const staticApp = navigableApp.filter((r) => r.static);

const navByRoleRoute = {}; // role -> routeId -> {sidebar:[rows], topbar:[rows]}
function navMatch(row) {
  return matchRoute(normalisePath(row.to).path, matchPool);
}
for (const role of ["admin", "household"]) {
  navByRoleRoute[role] = new Map();
  for (const row of navRows.filter((r) => r.role === role)) {
    const t = navMatch(row);
    if (!t) {
      warn(`nav link ${row.to} (${row.renderer}/${role}) matches no route`);
      continue;
    }
    const m = navByRoleRoute[role].get(t.id) ?? { sidebar: [], topbar: [] };
    m[row.renderer].push(row);
    navByRoleRoute[role].set(t.id, m);
  }
}
const paletteByRole = { admin: new Map(), household: new Map() };
for (const c of palette.commands) {
  const t = matchRoute(normalisePath(c.path).path, matchPool);
  if (!t) {
    warn(`palette entry "${c.label}" -> ${c.path} matches no route`);
    continue;
  }
  paletteByRole.admin.set(t.id, c);
  if (!c.adminOnly) paletteByRole.household.set(t.id, c);
}
for (const s of palette.shortcuts) {
  const t = matchRoute(s.path, matchPool);
  if (t) for (const role of ["admin", "household"]) if (!paletteByRole[role].has(t.id)) paletteByRole[role].set(t.id, { label: `shortcut "${s.key}"`, path: s.path, shortcutOnly: true });
}

const roleResults = {};
for (const role of ["admin", "household"]) {
  const acc = navigableApp.filter((r) => accessible(r, role));
  const accIds = new Set(acc.map((r) => r.id));
  const otherRole = role === "admin" ? "household" : "admin";
  // in-page inbound edges between accessible routes, dedup by (from,to)
  const inbound = new Map();
  const blocked = []; // edges this role can trigger that lead to routes the role cannot open
  for (const e of edges) {
    if (e.from.startsWith("*")) continue;
    if (e.roleLimit === otherRole) continue; // the link is only rendered for the other role
    const src = routeById.get(e.from);
    const dst = routeById.get(e.to);
    if (!src || !dst || src.id === dst.id) continue;
    if (!accessible(src, role)) continue;
    if (!accessible(dst, role)) {
      blocked.push({ from: src.path, to: dst.path, file: e.file, line: e.line, kind: e.kind, roleGuard: e.roleLimit });
      continue;
    }
    if (dst.layer === "public") continue;
    const set = inbound.get(dst.id) ?? new Map();
    set.set(src.id, (set.get(src.id) ?? 0) + 1);
    inbound.set(dst.id, set);
  }
  // refs living in shell components (rendered on every page) reach every accessible route
  const shellInbound = edges.filter((e) => e.from === "*shell*" && accIds.has(e.to) && e.roleLimit !== otherRole);

  // routes reachable at all: nav or palette seeds, expanded through in-page links from reachable pages
  const reachable = new Set();
  const dash = acc.find((r) => r.path === "/");
  if (dash) reachable.add(dash.id);
  for (const rid of navByRoleRoute[role].keys()) reachable.add(rid);
  for (const rid of paletteByRole[role].keys()) reachable.add(rid);
  for (const e of shellInbound) reachable.add(e.to);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [dstId, srcs] of inbound) {
      if (reachable.has(dstId)) continue;
      if ([...srcs.keys()].some((s) => reachable.has(s))) {
        reachable.add(dstId);
        changed = true;
      }
    }
  }

  // click depth (weak metric): fixpoint from the Dashboard; palette counts as 2 actions (Ctrl+K, pick) when `withPalette`
  const depthFor = (layout, withPalette) => {
    const d = new Map();
    if (dash) d.set(dash.id, 0);
    const lower = (id, c) => {
      if (!d.has(id) || c < d.get(id)) d.set(id, c);
    };
    for (const [rid, nav] of navByRoleRoute[role]) {
      const rows = nav[layout];
      if (rows.length) lower(rid, Math.min(...rows.map((r) => r.clicks)));
    }
    if (withPalette) for (const rid of paletteByRole[role].keys()) lower(rid, 2);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [dstId, srcs] of inbound) {
        for (const srcId of srcs.keys()) {
          if (!d.has(srcId)) continue;
          const cand = d.get(srcId) + 1;
          if (!d.has(dstId) || cand < d.get(dstId)) {
            d.set(dstId, cand);
            changed = true;
          }
        }
      }
    }
    return d;
  };
  const depthSidebar = depthFor("sidebar", false);
  const depthTopbar = depthFor("topbar", false);
  const depthSidebarPal = depthFor("sidebar", true);

  const per = [];
  for (const r of acc) {
    const nav = navByRoleRoute[role].get(r.id) ?? { sidebar: [], topbar: [] };
    const pal = paletteByRole[role].get(r.id) ?? null;
    const inSrc = inbound.get(r.id) ?? new Map();
    const hasNavSidebar = nav.sidebar.length > 0;
    const hasNavTopbar = nav.topbar.length > 0;
    const hasNav = hasNavSidebar || hasNavTopbar;
    const hasPalette = !!pal;
    // an in-page link only counts if its source page is itself reachable
    const liveSources = [...inSrc.keys()].filter((sid) => reachable.has(sid));
    const shellCount = shellInbound.filter((e) => e.to === r.id).length;
    const hasInPage = liveSources.length > 0 || shellCount > 0;
    let cls;
    if (hasNav) cls = "nav";
    else if (hasPalette && !hasInPage) cls = "palette-only";
    else if (hasPalette && hasInPage) cls = "palette+in-page (no nav)";
    else if (hasInPage) cls = "in-page-only";
    else cls = "orphan";
    const groupLabels = [...new Set(nav.sidebar.map((x) => x.group ?? "top level"))];
    per.push({
      route: r.path,
      id: r.id,
      kind: r.kind,
      gate: r.gate,
      classification: cls,
      nav: {
        sidebar: hasNavSidebar ? { clicks: Math.min(...nav.sidebar.map((x) => x.clicks)), group: groupLabels.join(", "), label: nav.sidebar[0].label, sourceLine: nav.sidebar[0].line } : null,
        topbar: hasNavTopbar ? { clicks: Math.min(...nav.topbar.map((x) => x.clicks)), group: [...new Set(nav.topbar.map((x) => x.group ?? "top level"))].join(", "), label: nav.topbar[0].label } : null,
      },
      palette: hasPalette ? { label: pal.label, shortcutOnly: !!pal.shortcutOnly } : null,
      inPageSources: [...inSrc.entries()].map(([sid, n]) => ({ from: routeById.get(sid).path, edges: n, sourceReachable: reachable.has(sid) })).sort((a, b) => a.from.localeCompare(b.from)),
      reachable: reachable.has(r.id),
      depth: { sidebarLayout: depthSidebar.get(r.id) ?? null, topbarLayout: depthTopbar.get(r.id) ?? null, sidebarLayoutWithPalette: depthSidebarPal.get(r.id) ?? null },
      pathCount: (hasNav ? 1 : 0) + (hasPalette ? 1 : 0) + inSrc.size + shellCount,
    });
  }
  const counts = {};
  for (const p of per) counts[p.classification] = (counts[p.classification] ?? 0) + 1;
  const staticPer = per.filter((p) => p.kind === "static");
  const countsStatic = {};
  for (const p of staticPer) countsStatic[p.classification] = (countsStatic[p.classification] ?? 0) + 1;
  const hist = (items, layout) => {
    const h = {};
    for (const p of items) {
      const k = p.depth[layout] === null ? "none" : String(p.depth[layout]);
      h[k] = (h[k] ?? 0) + 1;
    }
    return h;
  };
  const paletteCovered = staticPer.filter((p) => p.palette && !p.palette.shortcutOnly);
  roleResults[role] = {
    accessibleRoutes: acc.length,
    accessibleStaticRoutes: staticPer.length,
    classificationAll: counts,
    classificationStatic: countsStatic,
    staticRoutesWithoutNavLink: staticPer.filter((p) => !p.nav.sidebar && !p.nav.topbar).map((p) => p.route),
    paletteCoverage: { covered: paletteCovered.length, ofStatic: staticPer.length, uncovered: staticPer.filter((p) => !p.palette || p.palette.shortcutOnly).map((p) => p.route) },
    clickDepthHistogram: {
      note: "clicks from the Dashboard (0). 'none' = no nav click path (palette or in-page chain only for the sidebarLayout column).",
      sidebarLayout: hist(per, "sidebarLayout"),
      topbarLayout: hist(per, "topbarLayout"),
      sidebarLayoutWithPalette: hist(per, "sidebarLayoutWithPalette"),
      staticOnlySidebar: hist(staticPer, "sidebarLayout"),
      staticOnlyTopbar: hist(staticPer, "topbarLayout"),
      staticOnlySidebarWithPalette: hist(staticPer, "sidebarLayoutWithPalette"),
    },
    blockedLinks: blocked,
    routes: per,
  };
}


// role asymmetries
const asymmetries = [];
for (const a of roleResults.admin.routes) {
  const h = roleResults.household.routes.find((x) => x.id === a.id);
  if (!h) continue;
  const diffs = [];
  const aNav = !!(a.nav.sidebar || a.nav.topbar);
  const hNav = !!(h.nav.sidebar || h.nav.topbar);
  if (aNav !== hNav) diffs.push(`nav link: admin ${aNav ? "yes" : "NO"}, household ${hNav ? "yes" : "NO"}`);
  if (!!a.palette !== !!h.palette) diffs.push(`palette: admin ${a.palette ? "yes" : "no"}, household ${h.palette ? "yes" : "no"}`);
  if (a.nav.sidebar && h.nav.sidebar && a.nav.sidebar.group !== h.nav.sidebar.group) diffs.push(`nav placement: admin "${a.nav.sidebar.group}" (${a.nav.sidebar.clicks} click), household "${h.nav.sidebar.group}" (${h.nav.sidebar.clicks} click)`);
  else if (a.depth.sidebarLayoutWithPalette !== h.depth.sidebarLayoutWithPalette) diffs.push(`depth (sidebar layout, palette = 2 actions): admin ${a.depth.sidebarLayoutWithPalette ?? "none"}, household ${h.depth.sidebarLayoutWithPalette ?? "none"}`);
  if (diffs.length) asymmetries.push({ route: a.route, admin: a.classification, household: h.classification, differences: diffs });
}

// palette vs nav label drift
const labelDrift = [];
for (const c of palette.commands) {
  const t = matchRoute(normalisePath(c.path).path, matchPool);
  const adminRows = t ? navByRoleRoute.admin.get(t.id)?.sidebar ?? [] : [];
  const navLabel = adminRows[0]?.label;
  if (navLabel && navLabel.toLowerCase() !== c.label.toLowerCase()) labelDrift.push({ route: c.path, palette: c.label, nav: navLabel });
}

// url-less state
const pageAndComponentFiles = allSrcFiles.filter((f) => /[\\/](pages|components)[\\/]/.test(f) && f.endsWith(".tsx"));
const tabStates = [];
const viewStates = [];
const queryStatePages = [];
for (const f of pageAndComponentFiles) {
  const r = extractUrllessState(fileSf.get(f), f);
  tabStates.push(...r.tabs);
  viewStates.push(...r.views);
  if (r.usesSearchParams) queryStatePages.push({ file: relSrc(f), queryKeys: r.queryKeys });
  if (r.usesLocationState && /pages[\\/]/.test(f) && /useLocation/.test(fileSf.get(f).text)) queryStatePages.push({ file: relSrc(f), locationState: true });
}

// anonymous / public
const publicInfo = publicRoutes.map((r) => {
  const prod = producerRefs.filter((p) => p.targetRoute === r.path && p.kind.startsWith("link-producer"));
  return { route: r.path, component: r.components[0], file: `${r.file}:${r.line}`, producedBy: prod.map((p) => `${p.file}:${p.line}`), reachableByUi: false, note: "outside the auth shell: no nav, palette or in-page click path; reachable only by a URL an admin copies out of the app" };
});

// ---------- numbers & reproduction ----------
const appRouteCount = appRoutes.length;
const adminGated = appRoutes.filter((r) => r.gate === "admin").length;
const openCount = appRoutes.filter((r) => r.gate === "open").length;
const paramRoutes = navigableApp.filter((r) => r.params.length);
const palStaticCovered = roleResults.admin.paletteCoverage.covered;
const reproduction = [
  { metric: "`<Route>` elements in App.tsx", earlier: `${PRIOR.routeElementsAppRange[0]}-${PRIOR.routeElementsAppRange[1]} (50 in the report)`, measured: appRouteCount, match: appRouteCount >= PRIOR.routeElementsAppRange[0] && appRouteCount <= PRIOR.routeElementsAppRange[1] },
  { metric: "admin-gated (isAdmin &&)", earlier: PRIOR.adminGated, measured: adminGated, match: adminGated === PRIOR.adminGated },
  { metric: "open (incl. catch-all)", earlier: PRIOR.open, measured: openCount, match: openCount === PRIOR.open },
  { metric: "static routes (no :param, excl. catch-all)", earlier: PRIOR.staticRoutes, measured: staticApp.length, match: staticApp.length === PRIOR.staticRoutes },
  { metric: "palette-covered static routes (admin)", earlier: PRIOR.paletteStaticCovered, measured: palStaticCovered, match: palStaticCovered === PRIOR.paletteStaticCovered },
  { metric: "static routes with no nav link (admin)", earlier: PRIOR.routesWithoutNavLink.join(", "), measured: roleResults.admin.staticRoutesWithoutNavLink.join(", ") || "(none)", match: JSON.stringify(roleResults.admin.staticRoutesWithoutNavLink) === JSON.stringify(PRIOR.routesWithoutNavLink) },
  { metric: "Route elements in main.tsx (outside the shell)", earlier: "2 public + the /* shell", measured: `${publicRoutes.length} public + ${shellRouteMain ? 1 : 0} shell`, match: publicRoutes.length === 2 && !!shellRouteMain },
];

const git = gitInfo();
const generatedAt = new Date().toISOString();

const result = {
  tool: "web-e2e/tools/route-nav-graph.mjs",
  generatedAt,
  git,
  scanned: { srcDir: rel(SRC), typescript: ts.version, files: allSrcFiles.length },
  evidenceLabels: { observed: "read from the AST", inferred: "derived by this script (reachability, click depth, import-graph attribution of component links)" },
  counts: {
    routeElements: { app: appRouteCount, appAdminGated: adminGated, appOpen: openCount, main: mainRoutes.length, total: appRouteCount + mainRoutes.length },
    appRoutesByKind: { static: staticApp.length, param: paramRoutes.length, catchAll: appRoutes.filter((r) => r.catchAll).length, redirect: appRoutes.filter((r) => r.redirect).length },
    nav: { libraryLinks: navData.libraryLinks.length, standaloneAdmin: navData.standaloneLinks.admin.length, standaloneHousehold: navData.standaloneLinks.household.length, adminGroups: navData.groups.map((g) => ({ key: g.key, label: g.label, links: g.links.length })), flattenedRows: navRows.length },
    palette: { commands: palette.commands.length, adminOnly: palette.commands.filter((c) => c.adminOnly).length, shortcuts: palette.shortcuts.length },
    inPageRefs: {
      totalSitesFound: refsAll.length,
      resolvedSites: resolvedRefSites.length,
      pageToPageEdges: edges.length,
      dangling: danglingRefs.length,
      linkProducers: producerRefs.filter((p) => p.kind.startsWith("link-producer")).length,
      historyBack: refsAll.filter((r) => r.kind === "history-back").length,
      unresolved: refsAll.filter((r) => r.unresolved).length,
      ignoredApiOrAssetHrefs: refsAll.filter((r) => r.ignored).length,
      relative: refsAll.filter((r) => r.relative).length,
    },
    tabsWithoutUrl: tabStates.length,
  },
  reproduction,
  routes: allRoutes,
  authShell: shellRouteMain ? { path: shellRouteMain.path, components: shellRouteMain.components, file: `${shellRouteMain.file}:${shellRouteMain.line}`, note: "every URL other than /share/:token and /invite/:token renders ApiKeyGate: the login form when there are no stored credentials, otherwise the app" } : null,
  nav: { data: { libraryLinks: navData.libraryLinks, standaloneLinks: navData.standaloneLinks, adminGroups: navData.groups.map((g) => ({ key: g.key, label: g.label, line: g.line, sortedByLabel: g.sortedByLabel, links: g.links.map((l) => ({ to: l.to, label: l.label, line: l.line })) })) }, renderers: navRenderers, flattened: navRows },
  palette,
  paletteLabelDrift: labelDrift,
  refSites: resolvedRefSites,
  edges: edges.map((e) => ({ from: routeById.get(e.from)?.path ?? e.from, to: routeById.get(e.to)?.path, kind: e.kind, at: `${e.file}:${e.line}`, via: e.via, query: e.query || undefined, inferredAttribution: e.inferred, roleLimit: e.roleLimit })),
  danglingRefs,
  linkProducers: producerRefs.filter((p) => p.kind.startsWith("link-producer")),
  unresolvedRefs: refsAll.filter((r) => r.unresolved),
  catchAll: catchAll ? { path: catchAll.path, at: `${catchAll.file}:${catchAll.line}`, redirect: catchAll.redirect, behaviour: "any URL that matches no registered Route is replaced (history replace) by `/`, silently: no 404 page, no message, no log. Because admin-only <Route> elements are not registered when !isAdmin, a household account that opens an admin URL lands on the Dashboard the same way.", adminUrlsHouseholdWouldHit: navigableApp.filter((r) => r.gate === "admin").map((r) => r.path) } : null,
  roles: roleResults,
  publicRole: publicInfo,
  asymmetries,
  tabsWithoutUrl: tabStates,
  otherUrllessViewState: viewStates,
  queryStatePages,
  warnings,
};

// ---------- sitemap (Mermaid, admin) ----------
function mermaid() {
  const admin = roleResults.admin;
  const nid = (r) => "n" + r.id;
  const q = (s) => String(s).replace(/&/g, "#amp;").replace(/"/g, "#quot;");
  const lines = [];
  lines.push("%% AoNarr sitemap, admin role. Generated by web-e2e/tools/route-nav-graph.mjs (evidence: observed from AST; layout grouping inferred from the sidebar renderer).");
  lines.push("%% Solid arrows: the sidebar contains the group. Dashed arrows: in-page links between pages (deduplicated, one per page pair). Colours: blue = has a nav link, amber = palette only, grey = in-page links only, red = orphan, green = public URL.");
  lines.push("flowchart LR");
  const byId = new Map(admin.routes.map((p) => [p.id, p]));
  const placed = new Set();
  const groupsOrder = [];
  const groupMembers = new Map();
  for (const p of admin.routes) {
    const g = p.nav.sidebar ? p.nav.sidebar.group.split(", ")[0] : null;
    const name = g === "top level" ? "Top level" : g;
    if (name) {
      if (!groupMembers.has(name)) {
        groupMembers.set(name, []);
        groupsOrder.push(name);
      }
      groupMembers.get(name).push(p);
    }
  }
  const nodeLabel = (p) => {
    let lbl = p.nav.sidebar?.label ?? p.palette?.label ?? routeById.get(p.id).components[0] ?? "";
    if (String(lbl).startsWith("{")) lbl = "one per media type";
    return `${q(p.route)}<br/>${q(lbl)}`;
  };
  let gi = 0;
  const sgIds = [];
  lines.push('  SIDEBAR(["Sidebar (admin, default layout)"])');
  const sg = (title, members, fromSidebar = true) => {
    sgIds.push([`G${gi + 1}`, fromSidebar]);
    lines.push(`  subgraph G${++gi}["${q(title)}"]`);
    lines.push("    direction TB");
    for (const p of members) {
      lines.push(`    ${nid(p)}["${nodeLabel(p)}"]`);
      placed.add(p.id);
    }
    lines.push("  end");
  };
  // order: Top level, Library, then the rest
  const ordered = ["Top level", "Library", ...groupsOrder.filter((g) => g !== "Top level" && g !== "Library")].filter((g) => groupMembers.has(g));
  for (const g of ordered) {
    const title = g === "Library" ? "Library (open by default)" : g === "Top level" ? "Sidebar top level" : `${g} (collapsed accordion)`;
    sg(title, groupMembers.get(g));
  }
  const rest = admin.routes.filter((p) => !placed.has(p.id));
  if (rest.length) sg("Not in the nav: reached by palette or in-page links only", rest, false);
  lines.push("");
  for (const [id, fromSidebar] of sgIds) if (fromSidebar) lines.push(`  SIDEBAR --> ${id}`);
  // in-page edges
  const seen = new Set();
  let edgeCount = 0;
  const maxEdges = 400;
  for (const p of admin.routes) {
    for (const s of p.inPageSources) {
      const src = admin.routes.find((x) => x.route === s.from);
      if (!src) continue;
      const key = src.id + ">" + p.id;
      if (seen.has(key)) continue;
      seen.add(key);
      if (edgeCount++ >= maxEdges) continue;
      lines.push(`  ${nid(src)} -.-> ${nid(p)}`);
    }
  }
  if (edgeCount > maxEdges) lines.push(`  %% ${edgeCount - maxEdges} further in-page edges omitted to stay under Mermaid's default 500-edge limit`);
  // public routes
  lines.push("");
  lines.push('  subgraph PUB["Public (outside the shell, no login)"]');
  for (const pr of publicRoutes) lines.push(`    ${nid(pr)}["${q(pr.path)}<br/>${q(pr.components[0])}"]`);
  lines.push("  end");
  for (const pp of result.linkProducers) {
    const target = publicRoutes.find((r) => r.path === pp.targetRoute);
    const from = (pp.sources[0] && admin.routes.find((x) => x.route === pp.sources[0])) || null;
    if (target && from) lines.push(`  ${nid(from)} -.->|copy link| ${nid(target)}`);
  }
  lines.push("");
  lines.push("  classDef nav fill:#dbeafe,stroke:#2563eb,color:#111;");
  lines.push("  classDef paletteOnly fill:#fef3c7,stroke:#d97706,color:#111;");
  lines.push("  classDef inPageOnly fill:#e5e7eb,stroke:#6b7280,color:#111;");
  lines.push("  classDef orphan fill:#fecaca,stroke:#dc2626,color:#111;");
  lines.push("  classDef pub fill:#dcfce7,stroke:#16a34a,color:#111;");
  const cls = { nav: "nav", "palette-only": "paletteOnly", "palette+in-page (no nav)": "paletteOnly", "in-page-only": "inPageOnly", orphan: "orphan" };
  for (const p of admin.routes) lines.push(`  class ${nid(p)} ${cls[p.classification] ?? "inPageOnly"};`);
  for (const pr of publicRoutes) lines.push(`  class ${nid(pr)} pub;`);
  void byId;
  return lines.join("\n") + "\n";
}

// ---------- markdown ----------
function md() {
  const L = [];
  const a = roleResults.admin;
  const h = roleResults.household;
  L.push("# Route, navigation and palette graph (before-numbers)");
  L.push("");
  L.push(`Generated ${generatedAt} from commit \`${git.commit ?? "unknown"}\` (${git.describe ?? ""}) by \`web-e2e/tools/route-nav-graph.mjs\` (TypeScript ${ts.version} compiler API, read-only). Evidence: **observed** = read from the AST; **inferred** = derived by the script (reachability, click depth, import-graph attribution).`);
  L.push("");
  L.push("## Headline");
  L.push("");
  L.push(
    mdTable(
      ["Fact", "Value", "Evidence"],
      [
        ["`<Route>` elements in App.tsx", `${appRouteCount} (${adminGated} admin-gated, ${openCount} open including the catch-all)`, "observed"],
        ["`<Route>` elements in main.tsx", `${mainRoutes.length}: ${publicRoutes.map((r) => r.path).join(", ")} (public, no login) and \`${shellRouteMain?.path}\` (login gate + app shell)`, "observed"],
        ["Static routes / param routes / catch-all", `${staticApp.length} / ${paramRoutes.length} / ${appRoutes.filter((r) => r.catchAll).length}`, "observed"],
        ["Command palette entries", `${palette.commands.length} (${palette.commands.filter((c) => c.adminOnly).length} admin-only)`, "observed"],
        ["Palette coverage of static routes: admin", `${a.paletteCoverage.covered} of ${a.paletteCoverage.ofStatic}`, "observed + inferred"],
        ["Palette coverage of static routes: household", `${h.paletteCoverage.covered} of ${h.paletteCoverage.ofStatic}`, "observed + inferred"],
        ["Static routes with no nav link: admin", a.staticRoutesWithoutNavLink.join(", ") || "none", "inferred"],
        ["Static routes with no nav link: household", h.staticRoutesWithoutNavLink.join(", ") || "none", "inferred"],
        ["Tab sets stored in `useState` (no URL)", `${tabStates.length}: ${tabStates.map((t) => t.file.split("/").pop().replace(".tsx", "")).join(", ")}`, "observed"],
        ["Catch-all", catchAll ? `\`${catchAll.path}\` -> \`<Navigate to="${catchAll.redirect?.to}" replace>\` at ${catchAll.file}:${catchAll.line}` : "none", "observed"],
        ["In-page cross-link reference sites", `${result.counts.inPageRefs.resolvedSites} resolve to a route (${edges.length} page-to-page edges after attributing shared components to the pages that render them), ${danglingRefs.length} match no route, ${result.counts.inPageRefs.unresolved} dynamic targets unresolved, ${result.counts.inPageRefs.historyBack} \`navigate(-1)\`, ${result.counts.inPageRefs.linkProducers} copy-link URL builders`, "observed + inferred"],
      ]
    )
  );
  L.push("");
  L.push("### Reproduction of the earlier counts");
  L.push("");
  L.push(mdTable(["Metric", "Earlier", "Measured here", "Match"], reproduction.map((r) => [r.metric, r.earlier, r.measured, r.match ? "yes" : "NO"])));
  L.push("");
  const bad = reproduction.filter((r) => !r.match);
  L.push(
    bad.length
      ? "Discrepancies: " + bad.map((r) => `${r.metric} (earlier ${r.earlier}, measured ${r.measured})`).join("; ") + "."
      : `All earlier counts reproduce. The earlier range "49-52 Route elements" is consistent with ${appRouteCount} in App.tsx; counting main.tsx as well gives ${appRouteCount + mainRoutes.length} Route elements in total.`
  );
  L.push("");

  L.push("## Reachability by role");
  L.push("");
  L.push("Classification of each accessible route: **nav** (a sidebar or top-bar link exists), **palette-only**, **palette+in-page (no nav)**, **in-page-only**, **orphan** (nothing points at it). Param routes (`/media/:id` and so on) are expected to be in-page-only.");
  L.push("");
  const clsOrder = ["nav", "palette-only", "palette+in-page (no nav)", "in-page-only", "orphan"];
  L.push(
    mdTable(
      ["Role", "Accessible routes", ...clsOrder.map((c) => c + " (all / static)")],
      ["admin", "household"].map((role) => [role, `${roleResults[role].accessibleRoutes} (${roleResults[role].accessibleStaticRoutes} static)`, ...clsOrder.map((c) => `${roleResults[role].classificationAll[c] ?? 0} / ${roleResults[role].classificationStatic[c] ?? 0}`)])
    )
  );
  L.push("");
  L.push(`Anonymous / public: only ${publicRoutes.map((r) => "`" + r.path + "`").join(" and ")} render without the login gate. Every other URL shows the login form. Neither public route is reachable by any in-app click; both exist to be opened from a link an admin copies out (link generators: ${result.linkProducers.map((p) => `${p.file}:${p.line}`).join(", ") || "none found"}).`);
  L.push("");
  L.push("### Route inventory");
  L.push("");
  const rows = [];
  for (const r of allRoutes) {
    const ar = a.routes.find((x) => x.id === r.id);
    const hr = h.routes.find((x) => x.id === r.id);
    const fmt = (x) => {
      if (!x) return "-";
      const parts = [x.classification];
      const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
      if (x.nav.sidebar) parts.push(`sidebar: ${x.nav.sidebar.group}, ${plural(x.nav.sidebar.clicks, "click")}`);
      if (x.nav.topbar) parts.push(`top bar: ${plural(x.nav.topbar.clicks, "click")}`);
      if (x.palette) parts.push("palette");
      if (x.inPageSources.length) parts.push(`${x.inPageSources.length} linking page${x.inPageSources.length === 1 ? "" : "s"}`);
      return parts.join("; ");
    };
    rows.push([r.path, r.components.join(" / ") || (r.redirect ? "Navigate -> " + r.redirect.to : "-"), r.gate, `${r.file.replace("web/src/", "")}:${r.line}`, r.layer === "public" ? "URL only" : fmt(ar), r.layer === "public" ? "URL only" : fmt(hr)]);
  }
  L.push(mdTable(["Route", "Component", "Gate", "Declared", "Admin", "Household"], rows));
  L.push("");

  L.push("## Role asymmetries (routes both roles can open)");
  L.push("");
  L.push(asymmetries.length ? mdTable(["Route", "Admin class", "Household class", "Differences"], asymmetries.map((x) => [x.route, x.admin, x.household, x.differences.join("; ")])) : "None.");
  L.push("");
  L.push("Household accounts also see a different Library section: media types are filtered to `auth.user.allowedTypes` (App.tsx), so the `/library/:type` nav entries vary per account (observed in code, not measured per account).");
  L.push("");
  L.push("### In-page links a household account may see that lead to admin-only routes");
  L.push("");
  if (h.blockedLinks.length) {
    L.push("Candidate dead ends: they land on the catch-all, which redirects to the Dashboard with no message. The column 'isAdmin guard' is what the script could prove from the AST (ancestor `&&`, ternary, `if`, or an earlier `if (...) return` in the same function); `both` means no guard was found, so check the page by hand.");
    L.push("");
    L.push(
      mdTable(
        ["Source page", "Target", "Where", "Kind", "isAdmin guard", "Hand check"],
        h.blockedLinks.map((b) => [b.from, b.to, `${b.file}:${b.line}`, "`" + b.kind + "`", b.roleGuard, MANUAL_ROLE_NOTES.find((n) => n.file === b.file && n.target === b.to)?.note ?? "not checked"])
      )
    );
  } else {
    L.push("None found: every in-page link to an admin-only route that a household account could reach sits behind an `isAdmin` guard the script could see, or is only in admin-only components (for example the Onboarding card on the Dashboard route).");
  }
  L.push("");

  L.push("## Command palette");
  L.push("");
  L.push(`Filter rule (observed): \`${palette.filterRule}\`. Opens with Ctrl/Cmd+K; the \`/\` key outside a text field jumps straight to \`/search\` (CommandPalette.tsx:${palette.shortcuts[0]?.line}).`);
  L.push("");
  L.push(`Admin sees ${a.paletteCoverage.covered} of ${a.paletteCoverage.ofStatic} static routes. Household sees ${h.paletteCoverage.covered} of ${h.paletteCoverage.ofStatic}.`);
  L.push("");
  L.push("Static routes missing from the palette (admin): " + a.paletteCoverage.uncovered.map((p) => "`" + p + "`").join(", "));
  L.push("");
  L.push("Static routes missing from the palette (household): " + (h.paletteCoverage.uncovered.map((p) => "`" + p + "`").join(", ") || "none"));
  L.push("");
  const palOnlyAdmin = a.routes.filter((p) => p.classification === "palette-only" || p.classification === "palette+in-page (no nav)").map((p) => p.route);
  const palOnlyHouse = h.routes.filter((p) => p.classification === "palette-only" || p.classification === "palette+in-page (no nav)").map((p) => p.route);
  L.push(`Reachable without a nav link, via the palette (admin): ${palOnlyAdmin.map((x) => "`" + x + "`").join(", ") || "none"}. Household: ${palOnlyHouse.map((x) => "`" + x + "`").join(", ") || "none"}.`);
  L.push("");
  if (labelDrift.length) {
    L.push("Label drift between palette and nav (same route, different words):");
    L.push("");
    L.push(mdTable(["Route", "Palette says", "Nav says"], labelDrift.map((d) => [d.route, d.palette, d.nav])));
    L.push("");
  }

  L.push("## Tabs and view state with no URL");
  L.push("");
  L.push("State lives in `useState`, so these views cannot be linked, bookmarked, or restored with the back button, and a route-diff/parity tool cannot see them without scripted clicks.");
  L.push("");
  L.push(
    mdTable(
      ["Page", "State declaration", "Tab bar", "Default", "Tabs", "Panels mounted but hidden"],
      tabStates.map((t) => [t.file.replace("web/src/", ""), `${t.file.split("/").pop()}:${t.line} \`${t.stateName}\``, t.tabBarLine ? `:${t.tabBarLine}` : "-", t.initial, t.tabs.map((x) => x.label ?? x.id).join(", "), t.hiddenPanelsMountedWithDisplayNone])
    )
  );
  L.push("");
  if (viewStates.length) {
    L.push("Other string-union view-mode state in pages (heuristic, not tabs):");
    L.push("");
    L.push(mdTable(["File:line", "State", "Type"], viewStates.map((v) => [`${v.file.replace("web/src/", "")}:${v.line}`, v.stateName, v.type])));
    L.push("");
  }
  if (queryStatePages.length) {
    L.push("Pages that do read URL state (query string or navigation state):");
    L.push("");
    L.push(mdTable(["File", "Detail"], queryStatePages.map((q) => [q.file.replace("web/src/", ""), q.locationState ? "useLocation / location.state" : `query keys: ${q.queryKeys.join(", ") || "(via useSearchParams)"}`])));
    L.push("");
  }

  L.push("## Catch-all behaviour");
  L.push("");
  if (catchAll) {
    L.push(`\`${catchAll.path}\` at ${catchAll.file}:${catchAll.line} renders \`<Navigate to="${catchAll.redirect?.to}" replace />\`. Effects (observed in code, not exercised in a browser):`);
    L.push("");
    L.push("- A mistyped or removed URL ends on the Dashboard with no 404 page, no message and no logging.");
    L.push(`- Admin-only \`<Route>\` elements are not registered when \`isAdmin\` is false, so all ${navigableApp.filter((r) => r.gate === "admin").length} admin URLs behave the same way for a household account.`);
    L.push("- For a signed-out visitor every shell URL shows the login form instead (main.tsx `/*` -> ApiKeyGate); `/share/:token` and `/invite/:token` are the only exceptions.");
  }
  L.push("");

  L.push("## Click depth and path count (weak metrics)");
  L.push("");
  L.push("Click depth is clicks from the Dashboard, assuming the default layout: top-level link = 1; link inside the Library group = 1 in the sidebar (open by default) but 2 in the top bar (dropdown); links inside the Manage, Configuration and System groups = 2 (open the accordion or dropdown, then click); in-page link = source depth + 1. **This is a weak metric**: Porter (2003) found no relationship between click count and task success, and nav is persistent so almost every nav route sits at depth 1 or 2. Use path count, role asymmetry, palette coverage and cross-links instead. Path count here = nav link (1) + palette (1) + distinct pages that link in.");
  L.push("");
  for (const role of ["admin", "household"]) {
    const r = roleResults[role];
    L.push(
      `**${role}**, static routes by click depth. Sidebar layout: ${JSON.stringify(r.clickDepthHistogram.staticOnlySidebar)}; top-bar layout: ${JSON.stringify(r.clickDepthHistogram.staticOnlyTopbar)}; sidebar layout counting the palette as 2 actions: ${JSON.stringify(r.clickDepthHistogram.staticOnlySidebarWithPalette)}. All routes including params (sidebar layout): ${JSON.stringify(r.clickDepthHistogram.sidebarLayout)}. ("none" = no nav-click path.)`
    );
    L.push("");
  }
  L.push("Routes with the fewest ways in (path count <= 1), admin:");
  L.push("");
  L.push(mdTable(["Route", "Class", "Path count", "Depth sidebar / top bar"], a.routes.filter((p) => p.pathCount <= 1).map((p) => [p.route, p.classification, p.pathCount, `${p.depth.sidebarLayout ?? "-"} / ${p.depth.topbarLayout ?? "-"}`])));
  L.push("");

  L.push("## Navigation structure (observed)");
  L.push("");
  L.push("Two renderers share the same link data: the sidebar (accordion groups, Library open by default, others collapsed) and the top bar (every group is a click-to-open dropdown). Admin sections can be reordered or hidden per browser (`useCustomizableLayout`, localStorage), which silently removes the nav link for every route in a hidden group.");
  L.push("");
  const groupRows = [
    ["Sidebar top level (all)", "/ Dashboard, /search Search"],
    ["Library (all, open by default)", navData.libraryLinks.map((l) => (l.fromData ? `${l.to} (one per media type)` : l.to)).join(", ")],
    ["Standalone (admin)", navData.standaloneLinks.admin.map((l) => l.to).join(", ")],
    ["Standalone (household)", navData.standaloneLinks.household.map((l) => l.to).join(", ")],
    ...navData.groups.map((g) => [`${g.label} (admin only, collapsed; ${g.links.length} links)`, g.links.map((l) => `${l.to}${String(l.label) !== "" ? " " + l.label : ""}`).join(", ")]),
  ];
  L.push(mdTable(["Group", "Links"], groupRows));
  L.push("");
  L.push("## Method, limits and warnings");
  L.push("");
  L.push("- Routes, nav arrays, hard-coded NavLinks, palette entries, `navigate()` calls, `<Link>`/`<NavLink>`/`<Navigate>` `to`, internal `<a href>`, `location.href =`/`window.open` and origin-based URL builders are read from the AST (observed). Template literals are normalised to `:param` form.");
  L.push("- Links in shared components are attributed to every page that imports them (static import graph, transitive, stopping at other route pages); that attribution is **inferred** and can over-count when a component is only rendered conditionally.");
  L.push("- `navigate(-1)` back-navigation and dynamic targets that cannot be resolved are counted but not turned into edges.");
  L.push("- Reachability treats a link as usable if its source page is reachable; it does not know about runtime data (an empty library shows no cards to click).");
  L.push("- Not covered: links built from API data (for example notification payloads), keyboard-only paths other than the palette and `/`, and anything rendered by `ApiDocs` (Swagger UI).");
  if (warnings.length) {
    L.push("");
    L.push("Warnings from this run:");
    for (const w of warnings) L.push(`- ${w}`);
  } else L.push("- No extraction warnings in this run.");
  L.push("");
  if (danglingRefs.length) {
    L.push("### Links to paths that match no route");
    L.push("");
    L.push(mdTable(["Where", "Kind", "Raw target", "Normalised"], danglingRefs.map((d) => [`${d.file}:${d.line}`, "`" + d.kind + "`", d.raw, d.path])));
    L.push("");
  }
  return L.join("\n");
}

/** Structural lint for the Mermaid text (no renderer is installed): balanced subgraph/end, edge endpoints defined, edge count. */
function lintMermaid(text) {
  const problems = [];
  const lines = text.split("\n");
  let depth = 0;
  const defined = new Set(["SIDEBAR"]);
  const subgraphs = new Set();
  let edges = 0;
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith("%%")) continue;
    let m;
    if ((m = /^subgraph\s+(\w+)\[/.exec(t))) {
      depth++;
      subgraphs.add(m[1]);
    } else if (t === "end") depth--;
    else if ((m = /^(\w+)\["/.exec(t))) defined.add(m[1]);
    else if (/^(\w+)\s+-\.?->/.test(t)) {
      edges++;
      for (const id of t.split(/\s*-\.?->(?:\|[^|]*\|)?\s*/).map((s) => s.trim())) if (id && !defined.has(id) && !subgraphs.has(id)) problems.push(`edge references undefined id ${id}`);
    }
  }
  if (depth !== 0) problems.push(`unbalanced subgraph/end (depth ${depth})`);
  if (edges > 500) problems.push(`${edges} edges exceeds Mermaid's default 500-edge limit`);
  return { problems, edges, nodes: defined.size };
}
const mermaidText = mermaid();
const lint = lintMermaid(mermaidText);
for (const p of lint.problems) warn(`sitemap.mmd lint: ${p}`);
result.sitemap = { file: "sitemap.mmd", nodes: lint.nodes, edges: lint.edges, lint: lint.problems.length ? lint.problems : "structural lint passed (not rendered: no Mermaid renderer is installed)" };

writeJson(path.join(OUT, "route-nav-graph.json"), result);
writeText(path.join(OUT, "route-nav-graph.md"), md());
writeText(path.join(OUT, "sitemap.mmd"), mermaidText);
log(`Wrote route-nav-graph.json, route-nav-graph.md, sitemap.mmd to ${rel(OUT)}`);
log(
  `Route elements: App ${appRouteCount} (${adminGated} admin-gated, ${openCount} open) + main ${mainRoutes.length}; static ${staticApp.length}; palette covers ${roleResults.admin.paletteCoverage.covered}/${roleResults.admin.paletteCoverage.ofStatic} (admin), ${roleResults.household.paletteCoverage.covered}/${roleResults.household.paletteCoverage.ofStatic} (household); no-nav static (admin): ${roleResults.admin.staticRoutesWithoutNavLink.join(",") || "none"}; tabs without URL: ${tabStates.length}; warnings: ${warnings.length}`
);
