import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A button that opens a small menu of actions below it — closes on an outside click or when any
 * menu item is clicked. Menu items are just plain <button>s passed as children; styling comes
 * from the .dropdown/.dropdown-menu classes in styles.css.
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

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className={buttonClassName} onClick={() => setOpen((o) => !o)}>
        {label} {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="dropdown-menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
