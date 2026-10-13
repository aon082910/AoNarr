// Page measurements shared by smoke, tab-walk, the screenshot spec and the judge self-test.
import type { Page } from "@playwright/test";

export interface OverflowReport {
  innerWidth: number;
  scrollWidth: number;
  bodyScrollWidth: number;
  overflowPx: number;
  offenders: { selector: string; overshootPx: number; text: string }[];
}

/** Horizontal overflow: scrollWidth > innerWidth. */
export async function measureOverflow(page: Page): Promise<OverflowReport> {
  return (await page.evaluate(() => (window as any).__e2e.overflow(8))) as OverflowReport;
}

export function hasOverflow(r: OverflowReport): boolean {
  return r.overflowPx > 1;
}

export interface Inventory {
  url: string;
  title: string;
  lang: string;
  attrs: { design: string | null; theme: string | null };
  landmarks: Record<string, number>;
  counts: Record<string, number>;
  headings: { level: string; text: string }[];
  interactive: { role: string; name: string; href: string | null }[];
  textLines: string[];
}

export async function collectInventory(page: Page): Promise<Inventory> {
  return (await page.evaluate(() => (window as any).__e2e.inventory())) as Inventory;
}

export interface InventoryDiff {
  missingText: string[];
  missingInteractive: string[];
  addedText: string[];
}

const interactiveKey = (i: Inventory["interactive"][number]) => `${i.role}|${i.name}|${i.href ?? ""}`;

/** What `before` had that `after` lost (a redesign must not drop text or controls). */
export function diffInventory(before: Inventory, after: Inventory): InventoryDiff {
  const afterText = new Set(after.textLines);
  const beforeText = new Set(before.textLines);
  const afterInteractive = new Set(after.interactive.map(interactiveKey));
  return {
    missingText: before.textLines.filter((t) => !afterText.has(t)),
    missingInteractive: [...new Set(before.interactive.map(interactiveKey))].filter((k) => !afterInteractive.has(k)),
    addedText: after.textLines.filter((t) => !beforeText.has(t)),
  };
}

export function inventoryDropped(d: InventoryDiff): boolean {
  return d.missingText.length > 0 || d.missingInteractive.length > 0;
}
