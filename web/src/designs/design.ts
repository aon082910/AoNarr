import { useSyncExternalStore } from "react";

/**
 * UI designs. "classic" is the original look (no data-design attribute at all — styles.css alone);
 * every other id is a token set in designs/<id>.css layered on designs/modern.css, selected by
 * `<html data-design="<id>">`. Per-browser (localStorage), same as the light/dark theme and the
 * layout-width toggle.
 *
 * KEEP IN SYNC: the same id list is repeated in public/theme-init.js (which has to run before React
 * to avoid a flash of the wrong design, and can't import this module). An id not in that list is
 * ignored rather than applied — an attribute with no matching CSS would leave every design token
 * undefined.
 */
export const DESIGN_STORAGE_KEY = "aonarr_design";
const CHANGE_EVENT = "aonarr-design-change";

export const DESIGNS = [
  { id: "classic", name: "Classic", tagline: "The original AoNarr look." },
  { id: "midnight", name: "Midnight", tagline: "Clean slate-blue with soft depth. Brand-faithful." },
  { id: "aurora", name: "Aurora", tagline: "Violet and teal glow, big rounded cards." },
  { id: "ember", name: "Ember", tagline: "Warm charcoal with an amber accent." },
  { id: "noir", name: "Noir", tagline: "True black and gold. Posters first." },
  { id: "paper", name: "Paper", tagline: "Editorial ink on paper. Sharp and quiet." },
  { id: "terminal", name: "Terminal", tagline: "Monospace, dense, green on black." },
] as const;

export type DesignId = (typeof DESIGNS)[number]["id"];

function isDesignId(v: string | null): v is DesignId {
  return !!v && DESIGNS.some((d) => d.id === v);
}

export function getDesign(): DesignId {
  try {
    const v = localStorage.getItem(DESIGN_STORAGE_KEY);
    return isDesignId(v) ? v : "classic";
  } catch {
    return "classic";
  }
}

function apply(id: DesignId) {
  if (id === "classic") document.documentElement.removeAttribute("data-design");
  else document.documentElement.setAttribute("data-design", id);
}

export function setDesign(id: DesignId) {
  try {
    if (id === "classic") localStorage.removeItem(DESIGN_STORAGE_KEY);
    else localStorage.setItem(DESIGN_STORAGE_KEY, id);
  } catch {
    // storage blocked — still apply for this page view
  }
  apply(id);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** Current design id, re-rendering on change (including a change made in another tab). */
export function useDesign(): DesignId {
  return useSyncExternalStore(subscribe, getDesign, () => "classic");
}
