import { Icon } from "./NavIcons.js";

/**
 * Action-button icons (Sonarr/Radarr-style icon-only buttons) — same 18px stroke-SVG shape as
 * NavIcons.tsx, kept in a separate file since these are for row/toolbar actions rather than
 * navigation. See NavIcons.tsx for icons already reusable as action buttons too (SearchIcon,
 * DownloadIcon, RotateCcwIcon, PlusCircleIcon, ZapIcon, SlashIcon, InboxIcon, etc.).
 */

export function TrashIcon() {
  return (
    <Icon>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </Icon>
  );
}

export function XIcon() {
  return (
    <Icon>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon>
      <polyline points="20 6 9 17 4 12" />
    </Icon>
  );
}

export function SaveIcon() {
  return (
    <Icon>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </Icon>
  );
}

export function ChevronsDownIcon() {
  return (
    <Icon>
      <polyline points="7 13 12 18 17 13" />
      <polyline points="7 6 12 11 17 6" />
    </Icon>
  );
}

export function ChevronsUpIcon() {
  return (
    <Icon>
      <polyline points="17 11 12 6 7 11" />
      <polyline points="17 18 12 13 7 18" />
    </Icon>
  );
}

export function PencilIcon() {
  return (
    <Icon>
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </Icon>
  );
}

export function ArrowLeftIcon() {
  return (
    <Icon>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </Icon>
  );
}

/** "Open"/"go to" a row's own detail page — the forward-navigation pairing for ArrowLeftIcon's
 * "back". */
export function ArrowRightIcon() {
  return (
    <Icon>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </Icon>
  );
}

export function ChevronLeftIcon() {
  return (
    <Icon>
      <polyline points="15 18 9 12 15 6" />
    </Icon>
  );
}

export function ChevronRightIcon() {
  return (
    <Icon>
      <polyline points="9 18 15 12 9 6" />
    </Icon>
  );
}

export function ArrowUpIcon() {
  return (
    <Icon>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </Icon>
  );
}

export function ArrowDownIcon() {
  return (
    <Icon>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </Icon>
  );
}

export function FolderIcon() {
  return (
    <Icon>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </Icon>
  );
}

export function EyeIcon() {
  return (
    <Icon>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

/** 2x2 tile grid — a view-mode switcher's "tiles/grid" option, paired with ListIcon's "list" option. */
export function GridIcon() {
  return (
    <Icon>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </Icon>
  );
}

/** Horizontal rows with a leading thumbnail block — the "Overview" library view-mode option
 * (a row per item with a small poster), distinct from GridIcon's poster wall and TableIcon's
 * plain grid. */
export function RowsIcon() {
  return (
    <Icon>
      <rect x="3" y="4" width="4" height="4" />
      <line x1="10" y1="6" x2="21" y2="6" />
      <rect x="3" y="10" width="4" height="4" />
      <line x1="10" y1="12" x2="21" y2="12" />
      <rect x="3" y="16" width="4" height="4" />
      <line x1="10" y1="18" x2="21" y2="18" />
    </Icon>
  );
}

/** Grid with a header row — the "Table" library view-mode option. */
export function TableIcon() {
  return (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="9" x2="9" y2="20" />
      <line x1="15" y1="9" x2="15" y2="20" />
    </Icon>
  );
}

/** Funnel — the Starr "Filters" toolbar/menu button. */
export function FilterIcon() {
  return (
    <Icon>
      <polygon points="4 4 20 4 14 12 14 19 10 21 10 12 4 4" />
    </Icon>
  );
}

/** Up/down paired arrows — the Starr "Sort" toolbar/menu button. */
export function SortIcon() {
  return (
    <Icon>
      <line x1="6" y1="20" x2="6" y2="4" />
      <polyline points="3 7 6 4 9 7" />
      <line x1="18" y1="4" x2="18" y2="20" />
      <polyline points="15 17 18 20 21 17" />
    </Icon>
  );
}

/** Circular refresh arrows — distinct from RotateCcwIcon's single undo arrow (NavIcons.tsx),
 * for a Starr-style "Refresh & Scan" toolbar button. */
export function RefreshIcon() {
  return (
    <Icon>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </Icon>
  );
}
