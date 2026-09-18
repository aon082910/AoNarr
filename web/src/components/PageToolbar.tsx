import type { ReactNode } from "react";

/**
 * Sonarr/Radarr-style page toolbar: a full-content-width bar directly under a page's <h1>,
 * split into a left group (page-level actions) and a right group (view mode / sort / filter /
 * search). `ToolbarButton` renders the icon-over-label buttons Starr apps use at this level —
 * distinct from the icon-only `.icon-button` convention (styles.css), which stays reserved for
 * per-row/in-context actions (a table row's Search icon, a card's Delete icon, etc.). Bleeds to
 * the edges of `.content` the same way `.media-backdrop` does, so it still respects the
 * centered/full-width layout preference (LayoutWidthToggle.tsx) automatically.
 */
export function PageToolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="page-toolbar">
      <div className="toolbar-group">{left}</div>
      <div className="toolbar-group">{right}</div>
    </div>
  );
}

/** Vertical divider between logically-grouped buttons within one PageToolbar side. */
export function ToolbarSeparator() {
  return <span className="toolbar-separator" />;
}

export function ToolbarButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
  spinning,
  title,
  type = "button",
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  spinning?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={`toolbar-button${danger ? " danger" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
    >
      <span className={spinning ? "spin" : undefined}>{icon}</span>
      <span className="toolbar-button-label">{label}</span>
    </button>
  );
}
