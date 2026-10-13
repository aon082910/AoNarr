// Shared helpers. Every timestamp in the seed derives from FIXED_NOW so a re-seed is byte-stable.

/** The fictional "now" the whole fixture set is anchored to. */
export const FIXED_NOW = new Date("2026-10-13T12:00:00Z");

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** A Date `days`/`hours`/`minutes` before FIXED_NOW (negative values go forward in time). */
export function ago({ days = 0, hours = 0, minutes = 0 } = {}) {
  return new Date(FIXED_NOW.getTime() - days * DAY_MS - hours * HOUR_MS - minutes * MIN_MS);
}

/** "YYYY-MM-DD HH:MM:SS" (UTC) - the shape SQLite's datetime('now') writes and the app compares as text. */
export function sqlTs(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** "YYYY-MM-DD" (UTC). */
export function dayStr(date) {
  return date.toISOString().slice(0, 10);
}

/** FIXED_NOW's calendar day plus `n` days (n may be negative), as "YYYY-MM-DD". */
export function dayOffset(n) {
  return dayStr(new Date(Date.UTC(2026, 9, 13) + n * DAY_MS));
}

/** An absolute "YYYY-MM-DD" plus n days. */
export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return dayStr(new Date(Date.UTC(y, m - 1, d) + n * DAY_MS));
}

/** mulberry32: tiny deterministic PRNG, fixed seed per stream name. */
export function rng(seedName) {
  let a = 0;
  for (const ch of seedName) a = (Math.imul(a, 31) + ch.charCodeAt(0)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GB = 1024 * 1024 * 1024;
export const MB = 1024 * 1024;

/** Filesystem-safe name (the sparse files are real paths inside the container). */
export function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
}

export const pad2 = (n) => String(n).padStart(2, "0");

/** Deterministic hex id from a label (for fake provider ids, tokens that must be stable). */
export function hexId(label, len = 32) {
  let out = "";
  let h = 2166136261;
  for (let round = 0; out.length < len; round++) {
    for (let i = 0; i < label.length; i++) {
      h ^= label.charCodeAt(i) + round;
      h = Math.imul(h, 16777619);
    }
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}
