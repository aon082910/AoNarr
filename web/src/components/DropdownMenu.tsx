import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A button that opens a small menu of actions below it — closes on an outside click, Escape, or
 * when any menu item is clicked. Menu items are just plain <button>s passed as children; styling
 * comes from the .dropdown/.dropdown-menu classes in styles.css.
 */
export default function DropdownMenu({
  label,
  children,
  buttonClassName = "select-like",
}: {
  label: string;
  children: ReactNode;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className={buttonClassName}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {label} {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="dropdown-menu" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
