// Screenshot helpers. Classic is the only blocking pixel baseline (expect(page).toHaveScreenshot); every other
// design only CAPTURES into .tmp/captures/<project>/ for human review.
import fs from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { PATHS } from "../../config/shared";
import type { Route } from "../routes";

/** Same options for the real comparison, the captures and the self-test, so they cannot drift apart. */
export function screenshotOptions(page: Page, route?: Pick<Route, "maskText" | "maxHeight">) {
  const mask: Locator[] = [];
  for (const re of route?.maskText ?? []) mask.push(page.locator("#root").getByText(re));
  // A page of unbounded length (the changelog) is captured from the top down to maxHeight only.
  const vp = page.viewportSize();
  const clip = route?.maxHeight && vp ? { x: 0, y: 0, width: vp.width, height: route.maxHeight } : undefined;
  return {
    fullPage: true,
    ...(clip ? { clip } : {}),
    animations: "disabled" as const,
    caret: "hide" as const,
    scale: "css" as const,
    mask,
  };
}

export function snapshotName(route: Pick<Route, "id">): string[] {
  return [`${route.id}.png`];
}

/** Blocking comparison against baselines/screens/<platform>/<project>/<route>.png. */
export async function expectMatchesBaseline(page: Page, route: Route): Promise<void> {
  await expect(page).toHaveScreenshot(snapshotName(route), screenshotOptions(page, route));
}

/** Non-blocking capture for the redesigns. Returns the written path. */
export async function capture(page: Page, route: Route, project: string): Promise<string> {
  const file = path.join(PATHS.captures, project, `${route.id}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // No masks on a capture: nothing is compared, and the owner wants to SEE the live values (a mask paints big magenta blocks over them).
  await page.screenshot({ ...screenshotOptions(page, route), mask: [], path: file });
  return file;
}

export function attachNote(testInfo: TestInfo, name: string, body: unknown) {
  return testInfo.attach(name, { body: JSON.stringify(body, null, 2), contentType: "application/json" });
}
