// Constants shared by playwright.config.ts, playwright.meta.config.ts, global setup and the tests.
// Nothing here talks to a browser or a server.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DESIGNS = ["classic", "midnight", "aurora", "ember", "noir", "paper", "terminal"] as const;
export const THEMES = ["dark", "light"] as const;
export type Design = (typeof DESIGNS)[number];
export type Theme = (typeof THEMES)[number];

/** Viewports of the sweep. Mobile = 390x844 with Chromium touch + mobile-viewport emulation. */
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
export const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];

/** The instant every page's clock is frozen to (the seed's FIXED_NOW). */
export const FIXED_NOW = "2026-10-13T12:00:00Z";
export const LOCALE = "en-US";
export const TIMEZONE = "UTC";
/** Same headless mode everywhere. `true` = Chromium headless shell (chromium_headless_shell-<rev>), not new-headless. */
export const HEADLESS = true;
export const DEVICE_SCALE_FACTOR = 1;

export const APP_ORIGIN = "http://127.0.0.1:4173";
export const BACKEND_ORIGIN = process.env.AONARR_E2E_API ?? "http://127.0.0.1:8989";

export const PATHS = {
  e2e: E2E_DIR,
  tmp: path.join(E2E_DIR, ".tmp"),
  auth: path.join(E2E_DIR, ".auth"),
  states: path.join(E2E_DIR, ".auth", "state"),
  creds: path.join(E2E_DIR, ".auth", "test-creds.json"),
  manifest: path.join(E2E_DIR, ".auth", "seed-manifest.json"),
  baselines: path.join(E2E_DIR, "baselines"),
  screenBaselines: path.join(E2E_DIR, "baselines", "screens"),
  captures: path.join(E2E_DIR, ".tmp", "captures"),
  axe: path.join(E2E_DIR, ".tmp", "axe"),
  tabwalk: path.join(E2E_DIR, ".tmp", "tabwalk"),
  inventory: path.join(E2E_DIR, ".tmp", "inventory"),
  smoke: path.join(E2E_DIR, ".tmp", "smoke"),
  runInfo: path.join(E2E_DIR, ".tmp", "run-info.json"),
  axeBaseline: path.join(E2E_DIR, "baselines", "axe-baseline.json"),
  tabwalkBaseline: path.join(E2E_DIR, "baselines", "tabwalk-baseline.json"),
  smokeAllowlist: path.join(E2E_DIR, "baselines", "smoke-allowlist.json"),
} as const;

export function projectName(design: Design, theme: Theme, viewport: ViewportName): string {
  return `${design}-${theme}-${viewport}`;
}

export interface ProjectParts {
  design: Design;
  theme: Theme;
  viewport: ViewportName;
}

export function parseProjectName(name: string): ProjectParts {
  const [design, theme, viewport] = name.split("-");
  if (!(DESIGNS as readonly string[]).includes(design) || !(THEMES as readonly string[]).includes(theme) || !(viewport in VIEWPORTS)) {
    throw new Error(`Not a sweep project name: ${name}`);
  }
  return { design: design as Design, theme: theme as Theme, viewport: viewport as ViewportName };
}

export type Role = "admin" | "public";

/** Per-project storage state: admin = session token + design/theme keys; public = design/theme keys only. */
export function stateFile(name: string, role: Role): string {
  return path.join(PATHS.states, `${name}.${role}.json`);
}

export function platformTag(): string {
  return process.platform;
}

/** True when this run is allowed to rewrite the axe / tab-walk ratchet baselines. */
export function ratchetUpdateRequested(): boolean {
  return process.env.E2E_UPDATE_RATCHETS === "1";
}
