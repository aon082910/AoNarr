#!/usr/bin/env node
// Inline-style ledger: AST scan of every web/src/**/*.tsx for JSX `style={...}` attributes.
//
//   node web-e2e/tools/inline-style-ledger.mjs                    # write the ledger (JSON + Markdown)
//   node web-e2e/tools/inline-style-ledger.mjs --update-baseline  # also write web-e2e/baselines/ledger-baseline.json
//   node web-e2e/tools/inline-style-ledger.mjs --check            # ratchet: exit 1 if static inline styles or raw-colour sites increased
//
// Options: --src <dir> (default <repo>/web/src), --out <dir> (default <repo>/redesign-concepts/phase0),
//          --baseline <file>, --quiet, --strict (with --check: also fail if total style attributes increase).
//
// Zero install: uses the TypeScript compiler API already present in web/node_modules (read-only).
// Never touches the network, the live app, or any file outside --out / --baseline.
import path from "node:path";
import fs from "node:fs";
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
  pct,
  mdTable,
  sortedEntries,
  findRawColours,
  isColourishProp,
  VAR_REF_RE,
} from "./_common.mjs";

const args = parseArgs(process.argv.slice(2));
const ts = loadTypeScript();
const SRC = path.resolve(args.src ?? path.join(REPO_ROOT, "web", "src"));
const OUT = path.resolve(args.out ?? path.join(REPO_ROOT, "redesign-concepts", "phase0"));
const BASELINE = path.resolve(args.baseline ?? path.join(REPO_ROOT, "web-e2e", "baselines", "ledger-baseline.json"));
const K = ts.SyntaxKind;

/** Earlier agent's numbers (plan section 3 / external-tools report) — compared against what is measured here. */
const PRIOR = {
  // the earlier report said "raw colour literals appear in 24 places" - read here as 24 sites
  totalStyleAttributes: 1110,
  objectLiteralSites: 1086,
  conditionalSites: 24,
  files: 68,
  pureLiteralSites: 1022,
  distinctStaticObjects: 346,
  clustersGE2: 126,
  clustersGE2Sites: 802,
  clustersGE5: 44,
  clustersGE5Sites: 603,
  rawColourLiterals: 24,
};

// ---------- property classification ----------
const SPACING = /^(margin|padding)(Top|Right|Bottom|Left|Block|Inline)?(Start|End)?$|^(gap|rowGap|columnGap|gridGap)$/;
const TYPOGRAPHY = new Set([
  "fontSize", "fontWeight", "fontFamily", "fontStyle", "fontVariant", "fontVariantNumeric", "font", "lineHeight", "letterSpacing", "wordSpacing",
  "textAlign", "textTransform", "textDecoration", "textDecorationLine", "textOverflow", "textIndent", "whiteSpace", "wordBreak", "overflowWrap",
  "wordWrap", "textWrap", "hyphens", "fontFeatureSettings", "textUnderlineOffset",
]);
const LAYOUT_RE = /^(display|position|top|left|right|bottom|inset|insetBlock|insetInline|zIndex|width|height|minWidth|maxWidth|minHeight|maxHeight|flex|flexDirection|flexWrap|flexGrow|flexShrink|flexBasis|flexFlow|grid|gridTemplate|gridTemplateColumns|gridTemplateRows|gridTemplateAreas|gridColumn|gridRow|gridColumnStart|gridColumnEnd|gridRowStart|gridRowEnd|gridAutoFlow|gridAutoColumns|gridAutoRows|gridArea|alignItems|alignContent|alignSelf|justifyContent|justifyItems|justifySelf|placeItems|placeContent|placeSelf|order|overflow|overflowX|overflowY|float|clear|boxSizing|aspectRatio|objectFit|objectPosition|verticalAlign|columns|columnCount|columnWidth|tableLayout|borderCollapse|borderSpacing|resize|contain|isolation)$/;
const COLOUR_PROP_RE = /(^|[a-z])Color$|^(fill|stroke|caretColor|accentColor|boxShadow|textShadow|colorScheme)$/;
const COLOUR_SHORTHAND_RE = /^(background|border|borderTop|borderRight|borderBottom|borderLeft|borderBlock|borderInline|outline|columnRule)$/;

/** @returns {'colour'|'layout'|'spacing'|'typography'|'one-off'} for a static (literal-valued) property. */
function classifyProp(key, valueText) {
  if (key === "color" || COLOUR_PROP_RE.test(key)) return key === "colorScheme" ? "one-off" : "colour";
  if (COLOUR_SHORTHAND_RE.test(key)) {
    // shorthand: colour only if the value actually carries a colour (var(--x), hex, rgb(), keyword, named)
    const v = String(valueText ?? "");
    if (/var\(\s*--|#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|currentColor|transparent/i.test(v) || findRawColours(v, key).length) return "colour";
    return "one-off";
  }
  if (SPACING.test(key)) return "spacing";
  if (TYPOGRAPHY.has(key)) return "typography";
  if (LAYOUT_RE.test(key)) return "layout";
  return "one-off";
}
const CATEGORIES = ["colour", "layout", "spacing", "typography", "one-off", "dynamic"];

// ---------- AST helpers ----------
function unwrap(expr) {
  let e = expr;
  while (e && (e.kind === K.ParenthesizedExpression || e.kind === K.AsExpression || e.kind === K.SatisfiesExpression || e.kind === K.NonNullExpression || e.kind === K.TypeAssertionExpression)) e = e.expression;
  return e;
}

/** @returns {{literal:boolean, text?:string, type?:string}} */
function literalValue(init) {
  const e = unwrap(init);
  switch (e.kind) {
    case K.StringLiteral:
    case K.NoSubstitutionTemplateLiteral:
      return { literal: true, text: e.text, type: "string" };
    case K.NumericLiteral:
      return { literal: true, text: String(Number(e.text)), type: "number" };
    case K.PrefixUnaryExpression:
      if (e.operator === K.MinusToken && unwrap(e.operand).kind === K.NumericLiteral) return { literal: true, text: "-" + Number(unwrap(e.operand).text), type: "number" };
      return { literal: false };
    case K.TrueKeyword:
      return { literal: true, text: "true", type: "boolean" };
    case K.FalseKeyword:
      return { literal: true, text: "false", type: "boolean" };
    case K.NullKeyword:
      return { literal: true, text: "null", type: "null" };
    case K.Identifier:
      if (e.text === "undefined") return { literal: true, text: "undefined", type: "undefined" };
      return { literal: false };
    default:
      return { literal: false };
  }
}

function propName(p) {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) return p.name.text;
  if (ts.isPrivateIdentifier(p.name)) return null;
  return null; // computed
}

/** Collect every string-ish leaf (string literal, template chunk) inside an expression with the nearest property key. */
function collectStringLeaves(node, sf, key, out) {
  if (!node) return;
  switch (node.kind) {
    case K.StringLiteral:
    case K.NoSubstitutionTemplateLiteral:
      out.push({ text: node.text, key, line: lineOf(sf, node) });
      return;
    case K.TemplateExpression:
      out.push({ text: node.head.text, key, line: lineOf(sf, node) });
      for (const span of node.templateSpans) {
        collectStringLeaves(span.expression, sf, key, out);
        out.push({ text: span.literal.text, key, line: lineOf(sf, span.literal) });
      }
      return;
    case K.ObjectLiteralExpression:
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p)) collectStringLeaves(p.initializer, sf, propName(p), out);
        else if (ts.isSpreadAssignment(p)) collectStringLeaves(p.expression, sf, key, out);
      }
      return;
    default:
      ts.forEachChild(node, (c) => collectStringLeaves(c, sf, key, out));
  }
}

/** Walk an expression finding object literals reachable as style values (object, conditional branches, && / || / ?? operands). */
function styleObjects(expr, acc = []) {
  const e = unwrap(expr);
  if (!e) return acc;
  if (e.kind === K.ObjectLiteralExpression) acc.push(e);
  else if (e.kind === K.ConditionalExpression) {
    styleObjects(e.whenTrue, acc);
    styleObjects(e.whenFalse, acc);
  } else if (e.kind === K.BinaryExpression) {
    styleObjects(e.left, acc);
    styleObjects(e.right, acc);
  }
  return acc;
}

function describeKind(e) {
  switch (e.kind) {
    case K.ObjectLiteralExpression: return "object-literal";
    case K.ConditionalExpression: return "conditional";
    case K.BinaryExpression: return "logical-expression";
    case K.Identifier: return "identifier";
    case K.CallExpression: return "call";
    case K.PropertyAccessExpression: return "property-access";
    case K.SpreadElement: return "spread";
    default: return K[e.kind] ?? "other";
  }
}

// ---------- scan ----------
const files = walk(SRC, (f) => f.endsWith(".tsx"));
const sites = [];

for (const file of files) {
  const text = readText(file);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // stable key even when --src points at an exported copy of web/src (for example a git tag checkout)
  const relFile = "web/src/" + toPosix(path.relative(SRC, file));

  const visit = (node) => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "style" && node.initializer) {
      sites.push(analyseSite(node, sf, relFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function analyseSite(attr, sf, relFile) {
  const line = lineOf(sf, attr);
  const opening = attr.parent.parent; // JsxAttributes -> JsxOpeningElement | JsxSelfClosingElement
  const tag = opening.tagName ? opening.tagName.getText(sf) : "?";

  // className co-occurrence
  let classNameKind = "none";
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === "className") {
      const init = a.initializer;
      if (!init) classNameKind = "expression";
      else if (ts.isStringLiteral(init)) classNameKind = "string-literal";
      else if (ts.isJsxExpression(init) && init.expression) {
        const ex = unwrap(init.expression);
        classNameKind = ex.kind === K.StringLiteral || ex.kind === K.NoSubstitutionTemplateLiteral ? "string-literal" : "expression";
      } else classNameKind = "expression";
    } else if (ts.isJsxSpreadAttribute(a)) {
      // {...props} may carry className; remember but do not override an explicit className
      if (classNameKind === "none") classNameKind = "none";
    }
  }

  const init = attr.initializer;
  const expr = ts.isJsxExpression(init) ? unwrap(init.expression) : init;
  const topKind = expr ? describeKind(expr) : "empty";
  const objs = expr ? styleObjects(expr) : [];

  // properties across every object literal reachable from the attribute
  const props = [];
  let dynamicReasons = [];
  let pureLiteral = false;
  if (expr && expr.kind === K.ObjectLiteralExpression) {
    pureLiteral = true;
    for (const p of expr.properties) {
      if (ts.isPropertyAssignment(p) && propName(p) !== null) {
        const key = propName(p);
        const lv = literalValue(p.initializer);
        if (lv.literal) props.push({ key, literal: true, valueText: lv.text, valueType: lv.type });
        else {
          pureLiteral = false;
          const vk = describeKind(unwrap(p.initializer));
          props.push({ key, literal: false, valueKind: vk, source: p.initializer.getText(sf).slice(0, 80).replace(/\s+/g, " ") });
          dynamicReasons.push({ key, valueKind: vk });
        }
      } else {
        pureLiteral = false;
        const k = ts.isSpreadAssignment(p) ? "spread" : ts.isShorthandPropertyAssignment(p) ? "shorthand" : ts.isPropertyAssignment(p) ? "computed-key" : "method";
        const nm = ts.isShorthandPropertyAssignment(p) ? p.name.text : ts.isPropertyAssignment(p) ? "[computed]" : "...";
        props.push({ key: nm, literal: false, valueKind: k, source: p.getText(sf).slice(0, 80).replace(/\s+/g, " ") });
        dynamicReasons.push({ key: nm, valueKind: k });
      }
    }
  } else {
    // conditional / identifier / call etc: classify any literal props inside reachable object branches too
    for (const o of objs) {
      for (const p of o.properties) {
        if (ts.isPropertyAssignment(p) && propName(p) !== null) {
          const lv = literalValue(p.initializer);
          if (lv.literal) props.push({ key: propName(p), literal: true, valueText: lv.text, valueType: lv.type, inDynamicSite: true });
          else props.push({ key: propName(p), literal: false, valueKind: describeKind(unwrap(p.initializer)), inDynamicSite: true });
        }
      }
    }
    dynamicReasons.push({ key: null, valueKind: topKind });
  }

  // colours + variables from every string leaf reachable from the attribute
  const leaves = [];
  if (expr) collectStringLeaves(expr, sf, null, leaves);
  const rawColours = [];
  const varRefs = [];
  for (const leaf of leaves) {
    for (const c of findRawColours(leaf.text, leaf.key)) rawColours.push({ ...c, property: leaf.key, line: leaf.line });
    let m;
    VAR_REF_RE.lastIndex = 0;
    while ((m = VAR_REF_RE.exec(leaf.text))) varRefs.push(m[1]);
    // keyword colours are tracked separately (not raw): transparent / currentColor
  }

  // cluster key (static sites only): sorted `key:json(value)`
  let clusterKey = null;
  if (pureLiteral) {
    clusterKey = props
      .map((p) => `${p.key}:${p.valueType === "string" ? JSON.stringify(p.valueText) : p.valueText}`)
      .sort()
      .join(";");
  }

  for (const p of props) p.category = p.literal && !p.inDynamicSite ? classifyProp(p.key, p.valueText) : "dynamic";
  // name-only category (what the property is, regardless of whether this use is literal)
  for (const p of props) p.nameCategory = classifyProp(p.key, "var(--x)");

  return {
    file: relFile,
    line,
    tag,
    topKind,
    static: pureLiteral,
    classNameKind,
    props,
    propCount: props.length,
    clusterKey,
    rawColours,
    varRefs: [...new Set(varRefs)],
    usesVar: varRefs.length > 0,
    dynamicReasons,
  };
}

// ---------- aggregate ----------
const total = sites.length;
const staticSites = sites.filter((s) => s.static);
const dynamicSites = sites.filter((s) => !s.static);
const byKind = new Map();
for (const s of sites) byKind.set(s.topKind, (byKind.get(s.topKind) ?? 0) + 1);

// objects (top-level object literal) vs conditional (the earlier agent's split)
const objectLiteralSites = sites.filter((s) => s.topKind === "object-literal").length;
const conditionalSites = sites.filter((s) => s.topKind === "conditional").length;
const otherKindSites = total - objectLiteralSites - conditionalSites;
const dynamicObjectSites = sites.filter((s) => s.topKind === "object-literal" && !s.static).length;

// per-file
const perFileMap = new Map();
for (const s of sites) {
  const f = perFileMap.get(s.file) ?? { file: s.file, total: 0, static: 0, dynamic: 0, rawColourSites: 0, usesVarSites: 0 };
  f.total++;
  if (s.static) f.static++;
  else f.dynamic++;
  if (s.rawColours.length) f.rawColourSites++;
  if (s.usesVar) f.usesVarSites++;
  perFileMap.set(s.file, f);
}
const perFile = [...perFileMap.values()].sort((a, b) => b.total - a.total || a.file.localeCompare(b.file));

// className co-occurrence
const classNameCounts = { none: 0, "string-literal": 0, expression: 0 };
const classNameStaticCounts = { none: 0, "string-literal": 0, expression: 0 };
for (const s of sites) {
  classNameCounts[s.classNameKind]++;
  if (s.static) classNameStaticCounts[s.classNameKind]++;
}

// dynamic breakdown
const dynamicByTop = new Map();
for (const s of dynamicSites) dynamicByTop.set(s.topKind, (dynamicByTop.get(s.topKind) ?? 0) + 1);
const dynamicPropReasons = new Map(); // `${key}|${valueKind}` -> count (object-literal dynamic sites only)
for (const s of dynamicSites.filter((x) => x.topKind === "object-literal")) {
  for (const p of s.props.filter((q) => !q.literal)) {
    const k = `${p.key} (${p.valueKind})`;
    dynamicPropReasons.set(k, (dynamicPropReasons.get(k) ?? 0) + 1);
  }
}
// human-friendly classes for the 64-ish dynamic object sites
function dynamicClass(s) {
  const dyn = s.props.filter((p) => !p.literal);
  const keys = new Set(dyn.map((p) => p.key));
  if (s.topKind === "conditional") {
    const ks = new Set(s.props.map((p) => p.key));
    return ks.has("backgroundImage") ? "conditional style: backgroundImage url() (poster) or none" : "conditional style: ternary of whole objects";
  }
  if (s.topKind !== "object-literal") return `other expression (${s.topKind})`;
  if (dyn.some((p) => p.valueKind === "spread")) return "spread of another object";
  if ([...keys].some((k) => /^backgroundImage$/.test(k))) return "backgroundImage url()";
  if ([...keys].every((k) => /^(width|height|minWidth|maxWidth|flex|flexBasis|left|right|top|bottom|transform|strokeDashoffset)$/.test(k))) return "size / progress / position from data";
  if ([...keys].every((k) => k === "display" || k === "visibility")) return "show/hide toggle (display)";
  if ([...keys].some((k) => /^(color|background|backgroundColor|borderColor|border|fill|stroke|boxShadow)$/.test(k)) && dyn.every((p) => p.valueKind === "conditional" || /Color|color|background|border|fill|stroke|boxShadow/.test(p.key))) return "colour chosen by ternary / data";
  if (dyn.every((p) => p.valueKind === "conditional")) return "ternary values";
  return "other dynamic values";
}
const backgroundImageDynamicSites = dynamicSites.filter((s) => s.props.some((p) => p.key === "backgroundImage")).length;
const backgroundImageInConditionals = dynamicSites.filter((s) => s.topKind === "conditional" && s.props.some((p) => p.key === "backgroundImage")).length;
const dynamicClassCounts = new Map();
for (const s of dynamicSites) {
  const c = dynamicClass(s);
  s.dynamicClass = c;
  dynamicClassCounts.set(c, (dynamicClassCounts.get(c) ?? 0) + 1);
}

// property classification
const propStats = new Map(); // key -> {category, count, values: Map}
for (const s of sites) {
  for (const p of s.props) {
    const rec = propStats.get(p.key) ?? { key: p.key, category: p.nameCategory, cats: new Map(), staticCount: 0, dynamicCount: 0, values: new Map() };
    if (p.literal && !p.inDynamicSite) {
      rec.cats.set(p.category, (rec.cats.get(p.category) ?? 0) + 1);
      rec.staticCount++;
      rec.values.set(p.valueText, (rec.values.get(p.valueText) ?? 0) + 1);
    } else rec.dynamicCount++;
    propStats.set(p.key, rec);
  }
}
const catOccurrences = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
const catSites = Object.fromEntries(CATEGORIES.map((c) => [c, new Set()]));
for (const s of sites) {
  s.props.forEach((p) => {
    const c = p.category ?? "dynamic";
    catOccurrences[c]++;
    catSites[c].add(`${s.file}:${s.line}`);
  });
}
const categoryTable = CATEGORIES.map((c) => ({ category: c, propertyOccurrences: catOccurrences[c], sitesTouching: catSites[c].size }));
// site profile: structure-only (layout+spacing), has colour, has typography, only one-off, dynamic
const siteProfile = { "structure-only (layout/spacing)": 0, "touches colour": 0, "touches typography": 0, "one-off only": 0, "has dynamic property": 0 };
for (const s of staticSites) {
  const cats = new Set(s.props.map((p) => p.category));
  if (cats.size && [...cats].every((c) => c === "layout" || c === "spacing")) siteProfile["structure-only (layout/spacing)"]++;
  if (cats.has("colour")) siteProfile["touches colour"]++;
  if (cats.has("typography")) siteProfile["touches typography"]++;
  if (cats.size && [...cats].every((c) => c === "one-off")) siteProfile["one-off only"]++;
}
siteProfile["has dynamic property"] = dynamicSites.length;

const propList = [...propStats.values()].sort((a, b) => b.staticCount + b.dynamicCount - (a.staticCount + a.dynamicCount) || a.key.localeCompare(b.key));
const valueScales = {};
for (const key of ["fontSize", "fontWeight", "gap", "padding", "margin", "marginBottom", "marginTop", "borderRadius", "width", "maxWidth", "opacity", "lineHeight", "zIndex"]) {
  const rec = propStats.get(key);
  if (rec) valueScales[key] = { uses: rec.staticCount, distinctValues: rec.values.size, top: sortedEntries(rec.values).slice(0, 8).map(([v, n]) => ({ value: v, count: n })) };
}

// colours
const rawColourSitesList = sites.filter((s) => s.rawColours.length);
const rawColourLiterals = sites.flatMap((s) => s.rawColours.map((c) => ({ ...c, file: s.file, siteLine: s.line })));
const rawColourLiteralsNoFallback = rawColourLiterals.filter((c) => !c.inFallback);
const rawColourSitesNoFallback = new Set(rawColourLiteralsNoFallback.map((c) => `${c.file}:${c.siteLine}`)).size;
const rawByKind = {};
for (const c of rawColourLiterals) rawByKind[c.kind] = (rawByKind[c.kind] ?? 0) + 1;
const varSites = sites.filter((s) => s.usesVar);
const varCounts = new Map();
for (const s of sites) for (const v of s.varRefs) varCounts.set(v, (varCounts.get(v) ?? 0) + 1);
// distinct var usage count (occurrences) too
let varOccurrences = 0;
for (const s of sites) {
  // count occurrences more precisely by re-scanning leaf text would need AST again; approximate by var-using properties
  varOccurrences += s.props.filter((p) => p.literal && /var\(\s*--/.test(p.valueText ?? "")).length;
}
const bothRawAndVar = sites.filter((s) => s.usesVar && s.rawColours.length).length;

// clusters (static sites)
const clusterMap = new Map();
for (const s of staticSites) {
  const c = clusterMap.get(s.clusterKey) ?? { key: s.clusterKey, count: 0, files: new Map(), sites: [], props: s.props, tags: new Map(), classNameKinds: new Map() };
  c.count++;
  c.files.set(s.file, (c.files.get(s.file) ?? 0) + 1);
  c.sites.push(`${s.file}:${s.line}`);
  c.tags.set(s.tag, (c.tags.get(s.tag) ?? 0) + 1);
  c.classNameKinds.set(s.classNameKind, (c.classNameKinds.get(s.classNameKind) ?? 0) + 1);
  clusterMap.set(s.clusterKey, c);
}
const clusters = [...clusterMap.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
const ge2 = clusters.filter((c) => c.count >= 2);
const ge5 = clusters.filter((c) => c.count >= 5);
const sum = (arr) => arr.reduce((n, c) => n + c.count, 0);
const singletons = clusters.filter((c) => c.count === 1);

function objectLiteralText(c) {
  const entries = c.props.map((p) => `${/^[A-Za-z_$][\w$]*$/.test(p.key) ? p.key : JSON.stringify(p.key)}: ${p.valueType === "string" ? JSON.stringify(p.valueText) : p.valueText}`);
  return `{ ${entries.join(", ")} }`;
}
function clusterProfile(c) {
  const cats = {};
  for (const p of c.props) cats[p.category] = (cats[p.category] ?? 0) + 1;
  return cats;
}
function clusterRecord(c, withSites) {
  const rec = {
    object: objectLiteralText(c),
    count: c.count,
    fileCount: c.files.size,
    topFiles: sortedEntries(c.files).slice(0, 5).map(([f, n]) => ({ file: f, count: n })),
    tags: Object.fromEntries(sortedEntries(c.tags).slice(0, 5)),
    classNameKinds: Object.fromEntries(c.classNameKinds),
    propertyCategories: clusterProfile(c),
    properties: c.props.length,
  };
  if (withSites) rec.sites = c.sites;
  return rec;
}

// alt cluster normalisations to explain differences from the earlier count of 346 distinct objects
function altDistinct(normalise) {
  const set = new Set();
  for (const s of staticSites) {
    const key = s.props
      .map((p) => `${p.key}:${normalise(p)}`)
      .sort()
      .join(";");
    set.add(key);
  }
  return set.size;
}
const distinctStrict = clusters.length;
const distinctNumericAsString = altDistinct((p) => (p.valueType === "number" ? `${p.valueText}px` : p.valueText)); // 8 == "8px"
const distinctNoQuotesType = altDistinct((p) => String(p.valueText).trim()); // 8 == "8"
const distinctCaseInsens = altDistinct((p) => String(p.valueText).trim().toLowerCase());

// css variables referenced inside inline styles (and '--x' keys defined inline)
const varsReferenced = [...varCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, siteCount]) => ({ name, sites: siteCount }));
const inlineDefinedVars = new Set();
for (const s of sites) for (const p of s.props) if (p.key.startsWith("--")) inlineDefinedVars.add(p.key);

const git = gitInfo();
const generatedAt = new Date().toISOString();

const metrics = {
  totalStyleAttributes: total,
  staticInlineStyles: staticSites.length,
  dynamicInlineStyles: dynamicSites.length,
  rawColourSites: rawColourSitesList.length,
  rawColourLiterals: rawColourLiterals.length,
  filesWithStyleAttributes: perFile.length,
};

const ledger = {
  tool: "web-e2e/tools/inline-style-ledger.mjs",
  generatedAt,
  git,
  scanned: { srcDir: rel(SRC), tsxFiles: files.length, typescript: ts.version },
  metrics,
  headline: {
    ...metrics,
    objectLiteralSites,
    conditionalSites,
    otherExpressionSites: otherKindSites,
    dynamicObjectLiteralSites: dynamicObjectSites,
    staticShare: pct(staticSites.length, total),
    distinctStaticObjects: distinctStrict,
    clustersRecurringGE2: { clusters: ge2.length, sites: sum(ge2), shareOfStatic: pct(sum(ge2), staticSites.length) },
    clustersRecurringGE5: { clusters: ge5.length, sites: sum(ge5), shareOfStatic: pct(sum(ge5), staticSites.length) },
    singletonClusters: singletons.length,
  },
  reproduction: Object.entries({
    totalStyleAttributes: [PRIOR.totalStyleAttributes, total],
    objectLiteralSites: [PRIOR.objectLiteralSites, objectLiteralSites],
    conditionalSites: [PRIOR.conditionalSites, conditionalSites],
    files: [PRIOR.files, perFile.length],
    pureLiteralSites: [PRIOR.pureLiteralSites, staticSites.length],
    distinctStaticObjects: [PRIOR.distinctStaticObjects, distinctStrict],
    clustersGE2: [PRIOR.clustersGE2, ge2.length],
    clustersGE2Sites: [PRIOR.clustersGE2Sites, sum(ge2)],
    clustersGE5: [PRIOR.clustersGE5, ge5.length],
    clustersGE5Sites: [PRIOR.clustersGE5Sites, sum(ge5)],
    rawColourSites: [PRIOR.rawColourLiterals, rawColourSitesList.length],
  }).map(([metric, [previous, measured]]) => ({ metric, previous, measured, match: previous === measured })),
  distinctnessVariants: {
    strict: distinctStrict,
    "number N == string 'Npx'": distinctNumericAsString,
    "number N == string 'N' (type ignored)": distinctNoQuotesType,
    "case-insensitive values": distinctCaseInsens,
  },
  kinds: Object.fromEntries(sortedEntries(byKind)),
  dynamic: {
    total: dynamicSites.length,
    byTopLevelKind: Object.fromEntries(sortedEntries(dynamicByTop)),
    byClass: Object.fromEntries(sortedEntries(dynamicClassCounts)),
    dynamicPropertyReasons: Object.fromEntries(sortedEntries(dynamicPropReasons).slice(0, 40)),
    backgroundImageDynamicSites,
    backgroundImageInConditionals,
  },
  classNameCoOccurrence: { allSites: classNameCounts, staticSites: classNameStaticCounts },
  colours: {
    rawColourSites: rawColourSitesList.length,
    rawColourSitesExcludingVarFallbacks: rawColourSitesNoFallback,
    rawColourLiterals: rawColourLiterals.length,
    rawColourLiteralsExcludingVarFallbacks: rawColourLiteralsNoFallback.length,
    rawByKind,
    varUsageSites: varSites.length,
    sitesWithBothRawAndVar: bothRawAndVar,
    sitesWithNeither: total - new Set([...rawColourSitesList, ...varSites]).size,
    rawColourList: rawColourLiterals.map((c) => ({ file: c.file, line: c.siteLine, property: c.property, kind: c.kind, value: c.value, inVarFallback: c.inFallback })),
    cssVariablesReferenced: varsReferenced,
    cssVariablesDefinedInline: [...inlineDefinedVars].sort(),
  },
  propertyClassification: {
    rules:
      "colour = colour properties and shorthands (background/border/outline) whose value carries a colour or var(); layout = display/position/flex/grid/size/overflow/z-index; spacing = margin/padding/gap; typography = font*/text*/line-height/letter-spacing/white-space; one-off = everything else (cursor, opacity, transform, transition, border-radius, ...); dynamic = property value is not a literal.",
    byCategory: categoryTable,
    siteProfiles: siteProfile,
    properties: propList.map((p) => ({
      property: p.key,
      category: p.category,
      staticCategoryMix: Object.fromEntries(p.cats),
      staticUses: p.staticCount,
      dynamicUses: p.dynamicCount,
      distinctValues: p.values.size,
      topValues: sortedEntries(p.values).slice(0, 5).map(([v, n]) => `${v} (${n})`),
    })),
    valueScales,
  },
  clusters: {
    note: "Clusters are static (pure-literal) style objects grouped after normalising key order. Value text is compared strictly (8 and '8px' differ).",
    recurringGE2: ge2.map((c) => clusterRecord(c, true)),
    singletons: singletons.map((c) => ({ object: objectLiteralText(c), site: c.sites[0] })),
  },
  perFile,
  sites: sites.map((s) => ({
    file: s.file,
    line: s.line,
    tag: s.tag,
    kind: s.topKind,
    static: s.static,
    className: s.classNameKind,
    properties: s.propCount,
    rawColours: s.rawColours.length,
    usesVar: s.usesVar,
    dynamicClass: s.dynamicClass ?? null,
  })),
};

// ---------- ratchet baseline ----------
function buildBaseline() {
  const pf = {};
  for (const f of perFile) pf[f.file] = { total: f.total, static: f.static, rawColourSites: f.rawColourSites };
  return {
    schema: 1,
    description: "Inline-style ratchet baseline. `--check` fails if staticInlineStyles or rawColourSites increase.",
    commit: git.commit,
    generatedAt,
    metrics: {
      totalStyleAttributes: total,
      staticInlineStyles: staticSites.length,
      dynamicInlineStyles: dynamicSites.length,
      rawColourSites: rawColourSitesList.length,
      rawColourLiterals: rawColourLiterals.length,
    },
    perFile: pf,
  };
}

// ---------- markdown ----------
function mdLedger() {
  const L = [];
  L.push("# Inline-style ledger (before-numbers)");
  L.push("");
  L.push(`Generated ${generatedAt} from commit \`${git.commit ?? "unknown"}\` (${git.describe ?? ""}) by \`web-e2e/tools/inline-style-ledger.mjs\`.`);
  L.push(`Scope: every \`*.tsx\` under \`${rel(SRC)}\` (${files.length} files), TypeScript ${ts.version} compiler API, read-only. Evidence label: **observed** (AST scan, run locally).`);
  L.push("");
  L.push("## Headline");
  L.push("");
  L.push(
    mdTable(
      ["Metric", "Value"],
      [
        ["JSX `style={...}` attributes", total],
        ["  object literals / conditionals / other expression", `${objectLiteralSites} / ${conditionalSites} / ${otherKindSites}`],
        ["Files containing at least one", perFile.length],
        ["Static (pure-literal) sites", `${staticSites.length} (${pct(staticSites.length, total)})`],
        ["Dynamic sites", `${dynamicSites.length} (${dynamicObjectSites} object literals with a non-literal value + ${conditionalSites} conditional + ${otherKindSites} other)`],
        ["Distinct static objects (key order normalised)", distinctStrict],
        ["Clusters recurring >= 2 times", `${ge2.length} clusters covering ${sum(ge2)} sites (${pct(sum(ge2), staticSites.length)} of static)`],
        ["Clusters recurring >= 5 times", `${ge5.length} clusters covering ${sum(ge5)} sites (${pct(sum(ge5), staticSites.length)} of static)`],
        ["One-off (singleton) objects", singletons.length],
        ["Sites with a raw colour literal (hex / rgb / hsl / named)", `${rawColourSitesList.length} sites, ${rawColourLiterals.length} literals (${rawColourLiteralsNoFallback.length} outside var() fallbacks)`],
        ["Sites referencing var(--x)", varSites.length],
      ]
    )
  );
  L.push("");
  L.push("### Reproduction of the earlier agent's numbers");
  L.push("");
  L.push(mdTable(["Metric", "Earlier", "Measured here", "Match"], ledger.reproduction.map((r) => [r.metric, r.previous, r.measured, r.match ? "yes" : "NO"])));
  L.push("");
  const mism = ledger.reproduction.filter((r) => !r.match);
  if (!mism.length) {
    L.push("All earlier figures are reproduced exactly (sites, files, distinct objects, cluster counts and the 24 raw-colour sites).");
    L.push("");
    L.push(
      `Distinctness is robust to value normalisation: strict = ${distinctStrict}, number N as "Npx" = ${distinctNumericAsString}, literal type ignored = ${distinctNoQuotesType}, case-insensitive = ${distinctCaseInsens}. The 24 raw-colour **sites** hold ${rawColourLiterals.length} literals (${rawColourLiteralsNoFallback.length} outside var() fallbacks).`
    );
  }
  if (mism.length) {
    L.push("Differences explained:");
    L.push("");
    L.push("See the rows marked NO above; the definitions used here are listed under Method and caveats.");
  }
  L.push("");
  L.push("## Static vs dynamic");
  L.push("");
  L.push(mdTable(["Top-level expression kind", "Sites"], sortedEntries(byKind).map(([k, n]) => [k, n])));
  L.push("");
  L.push("Dynamic sites by class (heuristic, based on the property names and value kinds):");
  L.push("");
  L.push(mdTable(["Class", "Sites"], sortedEntries(dynamicClassCounts).map(([k, n]) => [k, n])));
  L.push("");
  L.push(
    `Sites whose style sets a \`backgroundImage\` from data (poster/banner URLs): ${backgroundImageDynamicSites} (${backgroundImageInConditionals} inside whole-object ternaries, ${backgroundImageDynamicSites - backgroundImageInConditionals} as a template-literal value). This is the "18 backgroundImage url()" group in the earlier report: it is spread across the ${conditionalSites} conditional sites and the ${dynamicObjectSites} dynamic object literals, not separate from them.`
  );
  L.push("");
  L.push("Most common dynamic property / value-kind pairs (object-literal sites):");
  L.push("");
  L.push(mdTable(["Property (value kind)", "Occurrences"], sortedEntries(dynamicPropReasons).slice(0, 20).map(([k, n]) => [k, n])));
  L.push("");
  L.push("## className co-occurrence");
  L.push("");
  L.push(
    mdTable(
      ["className on the same element", "All sites", "Static sites"],
      ["none", "string-literal", "expression"].map((k) => [k, `${classNameCounts[k]} (${pct(classNameCounts[k], total)})`, `${classNameStaticCounts[k]} (${pct(classNameStaticCounts[k], staticSites.length)})`])
    )
  );
  L.push("");
  L.push("## Colour: raw literals vs var(--x)");
  L.push("");
  L.push(`- Sites using \`var(--x)\`: **${varSites.length}** of ${total} (${pct(varSites.length, total)}).`);
  L.push(`- Sites with a raw colour literal: **${rawColourSitesList.length}** (${rawColourLiterals.length} literals; by kind ${JSON.stringify(rawByKind)}); sites with both raw and var: ${bothRawAndVar}.`);
  L.push("");
  L.push("### Every raw colour literal");
  L.push("");
  L.push(
    mdTable(
      ["File:line", "Property", "Kind", "Value", "In var() fallback"],
      rawColourLiterals.map((c) => [`${c.file}:${c.siteLine}`, c.property ?? "-", c.kind, c.value, c.inFallback ? "yes" : "no"])
    )
  );
  L.push("");
  L.push("### CSS variables referenced inside inline styles");
  L.push("");
  L.push(mdTable(["Variable", "Sites"], varsReferenced.map((v) => [v.name, v.sites])));
  if (inlineDefinedVars.size) {
    L.push("");
    L.push(`Custom properties **defined** by inline style keys: ${[...inlineDefinedVars].sort().join(", ")}.`);
  }
  L.push("");
  L.push("## Property classification");
  L.push("");
  L.push(ledger.propertyClassification.rules);
  L.push("");
  L.push(mdTable(["Category", "Property occurrences", "Sites touching"], categoryTable.map((r) => [r.category, r.propertyOccurrences, r.sitesTouching])));
  L.push("");
  L.push("Static-site profiles (a site can appear in several rows):");
  L.push("");
  L.push(mdTable(["Profile", "Sites"], Object.entries(siteProfile)));
  L.push("");
  L.push("### Properties (top 40 by use)");
  L.push("");
  L.push(
    mdTable(
      ["Property", "Category", "Static uses", "Dynamic uses", "Distinct values", "Top values"],
      propList.slice(0, 40).map((p) => [p.key, [...p.cats].map(([c, n]) => (p.cats.size > 1 ? `${c} ${n}` : c)).join(" / ") || p.category + " (dynamic only)", p.staticCount, p.dynamicCount, p.values.size, sortedEntries(p.values).slice(0, 4).map(([v, n]) => `${v} (${n})`).join(", ")])
    )
  );
  L.push("");
  L.push("### Value scales");
  L.push("");
  L.push(mdTable(["Property", "Uses", "Distinct", "Top values"], Object.entries(valueScales).map(([k, v]) => [k, v.uses, v.distinctValues, v.top.map((t) => `${t.value} (${t.count})`).join(", ")])));
  L.push("");
  L.push("## Clusters");
  L.push("");
  L.push(`${distinctStrict} distinct static objects; ${ge2.length} recur at least twice; ${ge5.length} recur at least five times. Size distribution:`);
  L.push("");
  const buckets = [
    ["1 (one-off)", (n) => n === 1],
    ["2-4", (n) => n >= 2 && n <= 4],
    ["5-9", (n) => n >= 5 && n <= 9],
    ["10-19", (n) => n >= 10 && n <= 19],
    ["20+", (n) => n >= 20],
  ];
  L.push(mdTable(["Recurrence", "Clusters", "Sites"], buckets.map(([name, f]) => { const cs = clusters.filter((c) => f(c.count)); return [name, cs.length, sum(cs)]; })));
  L.push("");
  L.push("### Top 30 clusters");
  L.push("");
  L.push(
    mdTable(
      ["#", "Sites", "Files", "Literal object", "Typical element", "className on element"],
      clusters.slice(0, 30).map((c, i) => [i + 1, c.count, c.files.size, "`" + objectLiteralText(c) + "`", sortedEntries(c.tags)[0][0], [...c.classNameKinds].map(([k, n]) => `${k}:${n}`).join(" ")])
    )
  );
  L.push("");
  L.push(`All ${ge2.length} recurring clusters with their site lists are in \`inline-style-ledger.json\` under \`clusters.recurringGE2\`.`);
  L.push("");
  L.push("## Per-file counts");
  L.push("");
  L.push(mdTable(["File", "Total", "Static", "Dynamic", "Raw-colour sites", "var() sites"], perFile.map((f) => [f.file, f.total, f.static, f.dynamic, f.rawColourSites, f.usesVarSites])));
  L.push("");
  L.push("## Method and caveats");
  L.push("");
  L.push("- A site is one JSX `style` attribute (including `style` passed to components). Static means the attribute is an object literal whose every property is a plain `key: literal` pair (string, number, negative number, boolean, null); anything else (template literals with expressions, identifiers, ternaries, spreads, shorthand properties, whole-object ternaries) is dynamic.");
  L.push("- className co-occurrence reads the same element's `className`; a `{...props}` spread that might carry className is not followed.");
  L.push("- Named colours are only recognised in colour-bearing properties, so words such as `center` or font names are not miscounted. `var(--x, #fff)` fallbacks count as raw literals and are flagged.");
  L.push("- This is a static scan: it cannot see styles applied through `element.style.*` in code, `<style>` strings, or CSS Modules, and it does not execute anything.");
  L.push("");
  L.push("Ratchet: `node web-e2e/tools/inline-style-ledger.mjs --check` fails when static inline styles or raw-colour sites exceed `web-e2e/baselines/ledger-baseline.json`.");
  L.push("");
  return L.join("\n");
}

// ---------- modes ----------
const quiet = !!args.quiet;
const log = (...a) => {
  if (!quiet) console.log(...a);
};

if (args.check) {
  if (!fs.existsSync(BASELINE)) {
    console.error(`No baseline at ${rel(BASELINE)}. Run with --update-baseline first.`);
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const b = base.metrics;
  const cur = buildBaseline();
  const c = cur.metrics;
  const rows = [
    ["staticInlineStyles", b.staticInlineStyles, c.staticInlineStyles, true],
    ["rawColourSites", b.rawColourSites, c.rawColourSites, true],
    ["totalStyleAttributes", b.totalStyleAttributes, c.totalStyleAttributes, !!args.strict],
    ["dynamicInlineStyles", b.dynamicInlineStyles, c.dynamicInlineStyles, false],
    ["rawColourLiterals", b.rawColourLiterals, c.rawColourLiterals, false],
  ];
  let failed = false;
  console.log(`Ratchet check against ${rel(BASELINE)} (baseline commit ${base.commit}, now ${git.commit})`);
  for (const [name, was, now, gating] of rows) {
    const delta = now - was;
    const status = delta > 0 ? (gating ? "FAIL (increased)" : "warn (increased, not gating)") : delta < 0 ? "improved" : "ok";
    console.log(`  ${name.padEnd(22)} baseline ${String(was).padStart(5)}  now ${String(now).padStart(5)}  ${delta >= 0 ? "+" : ""}${delta}  ${status}`);
    if (delta > 0 && gating) failed = true;
  }
  // per-file regressions
  const regress = [];
  for (const [file, rec] of Object.entries(cur.perFile)) {
    const was = base.perFile[file] ?? { static: 0, rawColourSites: 0 };
    if (rec.static > was.static || rec.rawColourSites > was.rawColourSites) regress.push(`  ${file}: static ${was.static} -> ${rec.static}, raw-colour sites ${was.rawColourSites} -> ${rec.rawColourSites}`);
  }
  if (regress.length) {
    console.log("Files that grew:");
    regress.slice(0, 20).forEach((r) => console.log(r));
    if (regress.length > 20) console.log(`  ... and ${regress.length - 20} more`);
  }
  if (!failed && rows.some(([, was, now, gating]) => gating && now < was)) console.log("Counts went down: run --update-baseline to lock in the improvement.");
  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(failed ? 1 : 0);
}

writeJson(path.join(OUT, "inline-style-ledger.json"), ledger);
writeText(path.join(OUT, "inline-style-ledger.md"), mdLedger());
log(`Wrote ${rel(path.join(OUT, "inline-style-ledger.json"))} and ${rel(path.join(OUT, "inline-style-ledger.md"))}`);
if (args["update-baseline"]) {
  writeJson(BASELINE, buildBaseline());
  log(`Wrote baseline ${rel(BASELINE)}`);
}
log(
  `style attributes ${total} | static ${staticSites.length} | dynamic ${dynamicSites.length} | files ${perFile.length} | distinct static ${distinctStrict} | >=2: ${ge2.length} clusters/${sum(ge2)} sites | >=5: ${ge5.length} clusters/${sum(ge5)} sites | raw-colour sites ${rawColourSitesList.length} (${rawColourLiterals.length} literals) | var sites ${varSites.length}`
);
