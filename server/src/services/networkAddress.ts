import net from "node:net";

// Host classification used by the outbound proxy routing and the certificate check.
// Only the host text is looked at; no DNS lookup is made.

type Cidr4 = readonly [base: string, bits: number];

const LOCAL_V4_RANGES: readonly Cidr4[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
];

const LOCAL_NAME_SUFFIXES = [".localhost", ".local", ".lan", ".internal", ".home.arpa"];

function cleanHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function v4ToNumber(address: string): number | null {
  if (!net.isIPv4(address)) return null;
  return address.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

function inV4Range(address: number, [base, bits]: Cidr4): boolean {
  const start = v4ToNumber(base);
  if (start == null) return false;
  const size = 2 ** (32 - bits);
  return address >= start && address < start + size;
}

function isLocalV4(address: string): boolean {
  const n = v4ToNumber(address);
  return n != null && LOCAL_V4_RANGES.some((range) => inV4Range(n, range));
}

function isLocalV6(address: string): boolean {
  if (address === "::1" || address === "::") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return isLocalV4(mapped[1]);
  // new URL() writes a mapped address in hex ("::ffff:c0a8:105"), so that form is read too.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isLocalV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const head = parseInt(address.split(":")[0] || "0", 16);
  // fc00::/7 and fe80::/10
  return (head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80;
}

export function isLocalAddress(hostname: string): boolean {
  const host = cleanHost(hostname);
  if (!host) return false;
  const kind = net.isIP(host);
  if (kind === 4) return isLocalV4(host);
  if (kind === 6) return isLocalV6(host);
  if (host === "localhost") return true;
  if (LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // A name with no dot is a LAN or container name.
  return !host.includes(".");
}

export type FilterEntry = { kind: "name"; pieces: string[] } | { kind: "net"; start: number; end: number };

/** A `*` wildcard match on the pieces between the stars, walked with indexOf so it cannot backtrack. */
function matchesGlob(pieces: string[], host: string): boolean {
  if (pieces.length === 1) return host === pieces[0];
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (host.length < first.length + last.length || !host.startsWith(first) || !host.endsWith(last)) return false;
  let at = first.length;
  const end = host.length - last.length;
  for (const piece of pieces.slice(1, -1)) {
    const found = host.indexOf(piece, at);
    if (found < 0 || found + piece.length > end) return false;
    at = found + piece.length;
  }
  return true;
}

/**
 * Parses "localhost, *.example.com, .example.org, 192.168.1.0/24" into entries. An item that cannot
 * be used (an IPv6 range, a bad prefix length) is dropped and handed to `onDropped`, so the caller can
 * tell the admin instead of ignoring it.
 */
export function parseBypassFilter(filter: string | null | undefined, onDropped?: (item: string) => void): FilterEntry[] {
  const entries: FilterEntry[] = [];
  for (const raw of (filter ?? "").split(/[,;\s]+/)) {
    let item = raw.trim().toLowerCase();
    if (!item) continue;
    if (item.startsWith("[") && item.endsWith("]")) item = item.slice(1, -1);
    const slash = item.indexOf("/");
    if (slash > 0) {
      const start = v4ToNumber(item.slice(0, slash));
      const bits = Number(item.slice(slash + 1));
      if (start == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
        onDropped?.(raw.trim());
        continue;
      }
      const size = 2 ** (32 - bits);
      const first = Math.floor(start / size) * size;
      entries.push({ kind: "net", start: first, end: first + size - 1 });
    } else if (item.startsWith(".")) {
      entries.push({ kind: "name", pieces: ["", item] }, { kind: "name", pieces: [item.slice(1)] });
    } else {
      entries.push({ kind: "name", pieces: item.split("*") });
    }
  }
  return entries;
}

export function matchesBypassFilter(hostname: string, entries: FilterEntry[]): boolean {
  const host = cleanHost(hostname);
  if (!host || entries.length === 0) return false;
  const numeric = v4ToNumber(host);
  return entries.some((entry) =>
    entry.kind === "net" ? numeric != null && numeric >= entry.start && numeric <= entry.end : matchesGlob(entry.pieces, host)
  );
}

/** Proxy URL schemes the outbound dispatcher can use. */
export const PROXY_SCHEMES: ReadonlySet<string> = new Set(["socks5:", "socks:", "socks5h:", "socks4:", "socks4a:", "http:", "https:"]);

/** Why a proxy URL cannot be used, or null. An empty value is fine: that means no proxy. */
export function proxyUrlProblem(url: string): string | null {
  if (url.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "must be a URL such as socks5://host:1080 or http://host:3128";
  }
  if (!PROXY_SCHEMES.has(parsed.protocol)) return "must start with socks5://, socks4://, http:// or https://";
  if (!parsed.hostname) return "has no host name";
  return null;
}

/** The URL with any user name and password replaced, for a log line. */
export function redactProxyUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, "//***@");
}
