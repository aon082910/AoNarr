import { useEffect, useState } from "react";

/** Floating "scroll to top" / "scroll to bottom" buttons, mounted once in App.tsx so they show up
 * on every page without each page needing its own copy — the app has a single window-level scroll
 * (.content has no overflow-y of its own; see styles.css), so this listens on window/document
 * rather than any specific page element. Hidden entirely on a page short enough that there's
 * nothing to scroll; each button individually disables once you're already at that end. */
export default function ScrollButtons() {
  const [scrollable, setScrollable] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    function update() {
      const doc = document.documentElement;
      const TOLERANCE = 40;
      setScrollable(doc.scrollHeight > window.innerHeight + TOLERANCE);
      setAtTop(window.scrollY < TOLERANCE);
      setAtBottom(window.scrollY + window.innerHeight >= doc.scrollHeight - TOLERANCE);
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    // A page's content can grow after mount (an async list finishing its first load) with no
    // scroll/resize event of its own to trigger a re-check — a light poll covers that instead of
    // wiring a ResizeObserver into every page that might grow.
    const interval = setInterval(update, 1000);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      clearInterval(interval);
    };
  }, []);

  if (!scrollable) return null;

  return (
    <div className="scroll-buttons">
      <button
        type="button"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        disabled={atTop}
        title="Scroll to top"
        aria-label="Scroll to top"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}
        disabled={atBottom}
        title="Scroll to bottom"
        aria-label="Scroll to bottom"
      >
        ↓
      </button>
    </div>
  );
}
