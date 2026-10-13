// Self-contained placeholder artwork: every poster/backdrop/cover in the seed is a data: URI SVG,
// so screenshots never depend on (or leak requests to) an external image host. The container's CSP
// already allows `img-src data:`.
//
// Deterministic: the same title always yields the same colours and layout. Text uses the generic
// `sans-serif` family, so glyph shapes follow the host's default font (stable on one machine).

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Greedy word wrap on a character budget; a single over-long word is kept whole. */
function wrap(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, "") + "...";
    return kept;
  }
  return lines;
}

function toDataUri(svg) {
  // encodeURIComponent leaves ( ) ' ! * unescaped, which break an unquoted/single-quoted CSS url().
  const encoded = encodeURIComponent(svg)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/'/g, "%27")
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A");
  return `data:image/svg+xml;utf8,${encoded}`;
}

/**
 * @param {string} title
 * @param {{ kind?: "poster"|"backdrop"|"square", subtitle?: string }} [opts]
 */
export function artwork(title, opts = {}) {
  const kind = opts.kind ?? "poster";
  const h = hash(title);
  const hue1 = h % 360;
  const hue2 = (hue1 + 35 + ((h >>> 9) % 50)) % 360;
  const [w, hgt] = kind === "backdrop" ? [1280, 720] : kind === "square" ? [400, 400] : [300, 450];
  const maxChars = kind === "backdrop" ? 26 : kind === "square" ? 14 : 12;
  const fontSize = kind === "backdrop" ? 64 : kind === "square" ? 38 : 34;
  const lines = wrap(title, maxChars, kind === "backdrop" ? 3 : 5);
  const lineH = Math.round(fontSize * 1.18);
  const blockH = lines.length * lineH;
  const startY = Math.round((hgt - blockH) / 2 + fontSize * 0.85);
  const cx = 20 + ((h >>> 3) % 60);
  const text = lines
    .map(
      (l, i) =>
        `<text x="${Math.round(w / 2)}" y="${startY + i * lineH}" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${fontSize}" fill="#fff" fill-opacity="0.96">${xml(l)}</text>`
    )
    .join("");
  const sub = opts.subtitle
    ? `<text x="${Math.round(w / 2)}" y="${hgt - Math.round(hgt * 0.07)}" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(fontSize * 0.5)}" fill="#fff" fill-opacity="0.78">${xml(opts.subtitle)}</text>`
    : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${hgt}" width="${w}" height="${hgt}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue1},62%,34%)"/><stop offset="1" stop-color="hsl(${hue2},58%,18%)"/></linearGradient></defs>` +
    `<rect width="${w}" height="${hgt}" fill="url(#g)"/>` +
    `<circle cx="${Math.round(w * (cx / 100))}" cy="${Math.round(hgt * 0.18)}" r="${Math.round(Math.min(w, hgt) * 0.34)}" fill="hsl(${hue2},70%,62%)" fill-opacity="0.18"/>` +
    `<circle cx="${Math.round(w * 0.82)}" cy="${Math.round(hgt * 0.86)}" r="${Math.round(Math.min(w, hgt) * 0.22)}" fill="hsl(${hue1},70%,70%)" fill-opacity="0.14"/>` +
    text +
    sub +
    `</svg>`;
  return toDataUri(svg);
}

export const poster = (title, subtitle) => artwork(title, { kind: "poster", subtitle });
export const backdrop = (title, subtitle) => artwork(title, { kind: "backdrop", subtitle });
export const square = (title, subtitle) => artwork(title, { kind: "square", subtitle });
