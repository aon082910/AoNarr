// Runs once per Playwright invocation, after the web server is up:
//   1. logs in through the API as the seeded test admin (ONE login per run: every login adds a session + audit row),
//   2. writes the 28 x 2 storage-state files (admin = session token + design/theme keys, public = design/theme keys only),
//   3. records the environment (platform, browser, headless mode, web build) in .tmp/run-info.json.
// Credentials are read from the gitignored .auth/test-creds.json and are never printed or written anywhere else
// except inside the gitignored .auth/state/*.json files (the token has to live in localStorage there).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import {
  APP_ORIGIN, BACKEND_ORIGIN, DESIGNS, DEVICE_SCALE_FACTOR, FIXED_NOW, HEADLESS, LOCALE, PATHS, THEMES, TIMEZONE, VIEWPORTS, VIEWPORT_NAMES,
  platformTag, projectName, stateFile, type Design, type Role, type Theme,
} from "../config/shared";

function pkgVersion(name: string): string {
  return JSON.parse(fs.readFileSync(path.join(PATHS.e2e, "node_modules", name, "package.json"), "utf8")).version;
}

/** Path of the headless-shell binary Playwright launches for headless:true (cache layout: <cache>/chromium_headless_shell-<rev>/<sub>/<binary>). */
function findHeadlessShell(): string | null {
  try {
    const exe = chromium.executablePath(); // <cache>/chromium-<rev>/.../chrome(.exe)
    const m = /^(.*?)chromium-(\d+)/.exec(exe);
    if (!m) return null;
    const dir = path.join(m[1], `chromium_headless_shell-${m[2]}`);
    for (const sub of fs.readdirSync(dir)) {
      const subDir = path.join(dir, sub);
      if (!fs.statSync(subDir).isDirectory()) continue;
      const bin = fs.readdirSync(subDir).find((f) => /^chrome-headless-shell(\.exe)?$/.test(f));
      if (bin) return path.join(subDir, bin);
    }
  } catch {
    // best effort only
  }
  return null;
}

function storageState(design: Design, theme: Theme, token: string | null) {
  const localStorage: { name: string; value: string }[] = [];
  if (token) localStorage.push({ name: "aonarr_session_token", value: token });
  if (theme === "light") localStorage.push({ name: "aonarr_theme", value: "light" }); // absent = dark
  if (design !== "classic") localStorage.push({ name: "aonarr_design", value: design }); // absent = classic
  return { cookies: [], origins: [{ origin: APP_ORIGIN, localStorage }] };
}

async function login(): Promise<string> {
  if (!fs.existsSync(PATHS.creds)) {
    throw new Error(`Test credentials missing: ${PATHS.creds}. Start the seeded instance first: npm run seed:start`);
  }
  const creds = JSON.parse(fs.readFileSync(PATHS.creds, "utf8")) as { adminUsername: string; adminPassword: string };
  const health = await fetch(`${BACKEND_ORIGIN}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`Seeded instance not reachable at ${BACKEND_ORIGIN}/api/health. Start it with: npm run seed:start`);
  const res = await fetch(`${BACKEND_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "AoNarr" },
    body: JSON.stringify({ username: creds.adminUsername, password: creds.adminPassword }),
  });
  if (!res.ok) throw new Error(`Seeded admin login failed: HTTP ${res.status} (the credentials file is out of date? re-run npm run seed:start)`);
  const body = (await res.json()) as { token?: string; totpRequired?: boolean };
  if (!body.token) throw new Error(`Seeded admin login returned no session token${body.totpRequired ? " (TOTP required)" : ""}`);
  return body.token;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const startedAtMs = Date.now();
  const token = await login();

  fs.mkdirSync(PATHS.states, { recursive: true });
  let written = 0;
  for (const design of DESIGNS) {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORT_NAMES) {
        for (const role of ["admin", "public"] as Role[]) {
          const file = stateFile(projectName(design, theme, viewport), role);
          fs.writeFileSync(file, JSON.stringify(storageState(design, theme, role === "admin" ? token : null), null, 2));
          written++;
        }
      }
    }
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const browserVersion = browser.version();
  await browser.close();

  const buildInfo = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(PATHS.tmp, "web-dist", "build-info.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const info = {
    startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    platform: platformTag(),
    osRelease: os.release(),
    node: process.version,
    playwright: pkgVersion("@playwright/test"),
    axeCore: pkgVersion("axe-core"),
    axePlaywright: pkgVersion("@axe-core/playwright"),
    browser: { name: "chromium", version: browserVersion, headless: HEADLESS, mode: HEADLESS ? "chromium-headless-shell (playwright default for headless:true)" : "headed", headlessShell: findHeadlessShell() },
    context: { locale: LOCALE, timezone: TIMEZONE, deviceScaleFactor: DEVICE_SCALE_FACTOR, reducedMotion: "reduce", serviceWorkers: "block", clock: FIXED_NOW, viewports: VIEWPORTS },
    webBuild: buildInfo,
    stateFiles: written,
    updateSnapshots: config.updateSnapshots,
    updateRatchets: process.env.E2E_UPDATE_RATCHETS === "1",
  };
  fs.mkdirSync(PATHS.tmp, { recursive: true });
  fs.writeFileSync(PATHS.runInfo, JSON.stringify(info, null, 2) + "\n");

  // Baselines are only valid for the renderer that made them: record it next to them whenever they are (re)written.
  if (config.updateSnapshots === "all" || config.updateSnapshots === "changed") {
    const dir = path.join(PATHS.screenBaselines, platformTag());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ENVIRONMENT.json"),
      JSON.stringify({ platform: info.platform, osRelease: info.osRelease, playwright: info.playwright, browser: info.browser, context: info.context, webBuild: info.webBuild, writtenAt: info.startedAt }, null, 2) + "\n",
    );
  }
}
