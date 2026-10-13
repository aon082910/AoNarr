// Env-flagged BREAKAGE injection, used ONLY to prove that the real sweep specs (not just the self-test) can fail.
//   E2E_INJECT_BREAKAGE=hide-sidebar npx playwright test --project=classic-dark-desktop screenshots   (E2E_ROUTES=library-type)
// The damage is a stylesheet added to the page in the browser: nothing under web/ is touched. A normal run (variable unset)
// has no code path that changes the page. The fixture refuses to run with a breakage while any baseline would be written
// (--update-snapshots other than "none", or E2E_UPDATE_RATCHETS=1), so a broken page can never become a baseline.
import type { BrowserContext, TestInfo } from "@playwright/test";

export const BREAKAGES: Record<string, { css: string; expectedToTrip: string }> = {
  "hide-sidebar": { css: ".sidebar{display:none!important}", expectedToTrip: "screenshots (pixel diff)" },
  "wrong-accent": { css: ":root,:root[data-theme=light]{--accent:#ff00aa!important;--accent-dim:#aa0066!important}", expectedToTrip: "screenshots (pixel diff)" },
  "overflow": { css: "body{overflow-x:visible!important;width:200vw!important}", expectedToTrip: "smoke (horizontal overflow)" },
  "low-contrast": { css: "#root *{color:#777!important;background:#808080!important}", expectedToTrip: "a11y (axe ratchet: color-contrast)" },
  "no-focus-ring": { css: "*:focus,*:focus-visible{outline:none!important;box-shadow:none!important;border-color:currentColor!important}", expectedToTrip: "tabwalk (noIndicator ratchet)" },
};

export function requestedBreakage(): string | null {
  const name = (process.env.E2E_INJECT_BREAKAGE ?? "").trim();
  if (!name) return null;
  if (!BREAKAGES[name]) throw new Error(`E2E_INJECT_BREAKAGE=${name} is not one of: ${Object.keys(BREAKAGES).join(", ")}`);
  return name;
}

/** Adds the breakage stylesheet to every document of the context. No-op (returns false) when the variable is unset. */
export async function applyBreakageIfRequested(context: BrowserContext, testInfo: TestInfo): Promise<boolean> {
  const name = requestedBreakage();
  if (!name) return false;
  if (testInfo.config.updateSnapshots !== "none" || process.env.E2E_UPDATE_RATCHETS === "1") {
    throw new Error("E2E_INJECT_BREAKAGE is set together with a baseline-writing flag: refusing, a broken page must never become a baseline.");
  }
  const css = BREAKAGES[name].css;
  await context.addInitScript((text: string) => {
    const add = () => {
      const s = document.createElement("style");
      s.setAttribute("data-e2e-injected-breakage", "1");
      s.textContent = text;
      (document.head ?? document.documentElement).appendChild(s);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add, { once: true });
  }, css);
  testInfo.annotations.push({ type: "INJECTED BREAKAGE", description: `${name}: ${css} (expected to trip: ${BREAKAGES[name].expectedToTrip})` });
  return true;
}
