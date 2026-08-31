import { useEffect, useRef, type ReactNode } from "react";

/** Shared popup shell — dark overlay + centered panel. Used by every "Add X" flow that used to be
 * an always-visible inline form at the top of its list page (Starr-app style: a button opens
 * this instead). */
export default function Modal({
  title,
  onClose,
  children,
  maxWidth = 480,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2)}`).current;

  // Deliberately separate from the keydown-handling effect below, and deliberately empty deps:
  // this must run exactly once per modal open, not on every render. Callers almost always pass
  // onClose as an inline arrow function (`onClose={() => setMode(null)}`), which is a brand-new
  // function identity on every parent re-render — typing into any controlled field inside the
  // modal re-renders the parent, so if this effect depended on `onClose` (as it originally did),
  // it re-ran on every keystroke and yanked focus back to the first field mid-type. The keydown
  // effect below still depends on onClose (harmless — resubscribing a listener doesn't touch
  // focus), so Escape/Tab-trap behavior always sees the latest onClose regardless.
  useEffect(() => {
    // Whatever had focus when the modal opened (almost always the button that triggered it) gets
    // it back on close — without this, focus silently drops to <body>, leaving a keyboard user
    // with no idea where they are on the page.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // The panel itself is focused first, THEN autofocus hands off to the first real field — this
    // guarantees focus starts somewhere inside the dialog even for a modal with no focusable
    // content (a confirm-only dialog), which a plain "focus the first input" approach would miss.
    // Searched within contentRef (the children only), not the whole panel — the header's own close
    // button sits earlier in the DOM than any form field, so searching the whole panel would always
    // focus "✕" first regardless of what the modal's actual content is.
    panelRef.current?.focus();
    const firstField = contentRef.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]), textarea, select, button:not([disabled])"
    );
    firstField?.focus();

    return () => {
      previouslyFocused?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // A focus trap: Tab/Shift+Tab cycle within the dialog's own focusable elements instead of
      // escaping to whatever's behind the overlay — a screen reader or keyboard-only user tabbing
      // past the last field would otherwise land on inert page content they can't see is covered.
      if (e.key === "Tab" && panelRef.current) {
        const focusable = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8vh",
        zIndex: 1000,
      }}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="form-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ maxWidth, width: "90%", maxHeight: "80vh", overflowY: "auto", position: "relative" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 id={titleId} style={{ margin: 0 }}>
            {title}
          </h2>
          <button type="button" className="secondary" onClick={onClose} aria-label="Close dialog" style={{ padding: "2px 10px" }}>
            ✕
          </button>
        </div>
        <div ref={contentRef}>{children}</div>
      </div>
    </div>
  );
}
