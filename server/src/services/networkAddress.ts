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

/** An IPv6 address as one number, or null when the text is not one. Handles "::" and a trailing dotted IPv4 part. */
export function v6ToBigInt(address: string): bigint | null {
  let text = cleanHost(address);
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!net.isIPv6(text)) return null;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = v4ToNumber(dotted[2]);
    if (n == null) return null;
    text = `${dotted[1]}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill("0"), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** The number after the slash of a range: digits only ("" and "+8" are not numbers here; Number("") would be 0, "everything"). */
function prefixLength(text: string): number {
  return /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN;
}

export type FilterEntry =
  | { kind: "name"; pieces: string[] }
  | { kind: "net"; start: number; end: number }
  | { kind: "net6"; start: bigint; end: bigint };

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
 * Parses "localhost, *.example.com, .example.org, 192.168.1.0/24, fd00::/8, ::1" into entries. An item that
 * cannot be used (a bad prefix length, an address that is not one) is dropped and handed to `onDropped`, so
 * the caller can tell the admin instead of ignoring it.
 */
export function parseBypassFilter(filter: string | null | undefined, onDropped?: (item: string) => void): FilterEntry[] {
  const entries: FilterEntry[] = [];
  for (const raw of (filter ?? "").split(/[,;\s]+/)) {
    let item = raw.trim().toLowerCase();
    if (!item) continue;
    if (item.startsWith("[") && item.endsWith("]")) item = item.slice(1, -1);
    const slash = item.indexOf("/");
    if (slash > 0 && item.slice(0, slash).includes(":")) {
      // An IPv6 range.
      const start = v6ToBigInt(item.slice(0, slash));
      const bits = prefixLength(item.slice(slash + 1));
      if (start == null || !Number.isInteger(bits) || bits < 0 || bits > 128) {
        onDropped?.(raw.trim());
        continue;
      }
      const size = 1n << BigInt(128 - bits);
      const first = (start / size) * size;
      entries.push({ kind: "net6", start: first, end: first + size - 1n });
    } else if (slash > 0) {
      const start = v4ToNumber(item.slice(0, slash));
      const bits = prefixLength(item.slice(slash + 1));
      if (start == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
        onDropped?.(raw.trim());
        continue;
      }
      const size = 2 ** (32 - bits);
      const first = Math.floor(start / size) * size;
      entries.push({ kind: "net", start: first, end: first + size - 1 });
    } else if (item.includes(":") && !item.includes("*")) {
      // A single IPv6 address (any spelling of it).
      const address = v6ToBigInt(item);
      if (address == null) {
        onDropped?.(raw.trim());
        continue;
      }
      entries.push({ kind: "net6", start: address, end: address });
    } else if (net.isIPv4(item)) {
      // A single IPv4 address is a range of one.
      const address = v4ToNumber(item)!;
      entries.push({ kind: "net", start: address, end: address });
    } else if (item.startsWith(".")) {
      entries.push({ kind: "name", pieces: ["", item] }, { kind: "name", pieces: [item.slice(1)] });
    } else {
      entries.push({ kind: "name", pieces: item.split("*") });
    }
  }
  return entries;
}

/** Domains anyone can register a name under: a wildcard over one of them would let in the attacker's own names. */
const SHARED_DOMAINS = new Set(["duckdns.org", "dyndns.org", "no-ip.com", "no-ip.org", "ddns.net", "nip.io", "sslip.io", "xip.io", "github.io", "herokuapp.com", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "workers.dev", "pages.dev", "vercel.app", "netlify.app", "myftp.org", "hopto.org", "zapto.org", "serveo.net"]);

/**
 * Why a host name pattern (for "allowed host names") is too loose to use, or null. A name without a wildcard is always fine.
 * A wildcard must stand for whole labels at the end ("*.example.com", "nas-*.example.com"), at most three of them, in front of a
 * domain of at least two labels that is not a shared one: "*", "*.com" or "*.duckdns.org" would accept names an attacker can register.
 */
export function hostPatternProblem(pattern: string): string | null {
  const text = pattern.trim().toLowerCase();
  if (!text.includes("*") && !text.startsWith(".")) return null;
  if ((text.match(/\*/g) ?? []).length > 3) return "has more than three wildcards";
  const star = text.lastIndexOf("*");
  const tail = text.slice(star + 1);
  if (star >= 0 && tail !== "" && !tail.startsWith(".")) return "must have the wildcard end at a dot, such as *.example.com";
  const domain = tail.replace(/^\./, "");
  if (domain.split(".").filter(Boolean).length < 2) return "must name a domain of at least two labels after the wildcard, such as *.example.com";
  if ([...SHARED_DOMAINS].some((shared) => domain === shared || domain.endsWith(`.${shared}`))) return `covers a domain anyone can register a name under (${domain})`;
  return null;
}

export function matchesBypassFilter(hostname: string, entries: FilterEntry[]): boolean {
  const host = cleanHost(hostname);
  if (!host || entries.length === 0) return false;
  const numeric = v4ToNumber(host);
  const numeric6 = net.isIPv6(host) ? v6ToBigInt(host) : null;
  // An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is also matched as the IPv4 address it carries.
  let mapped: number | null = null;
  if (numeric6 != null && numeric6 >> 32n === 0xffffn) mapped = Number(numeric6 & 0xffffffffn);
  return entries.some((entry) => {
    if (entry.kind === "net") return (numeric != null && numeric >= entry.start && numeric <= entry.end) || (mapped != null && mapped >= entry.start && mapped <= entry.end);
    if (entry.kind === "net6") return numeric6 != null && numeric6 >= entry.start && numeric6 <= entry.end;
    return matchesGlob(entry.pieces, host);
  });
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
