import { ChevronLeftIcon, ChevronRightIcon } from "./ActionIcons.js";

export const DEFAULT_PAGE_SIZE_OPTIONS = [30, 60, 100, 250] as const;

/**
 * Shared Prev/Next + "Page X of Y (N total)" + items-per-page control — the exact shape
 * LibraryType.tsx (the original) and AuditLog.tsx already used, pulled out so every other
 * paginated list page gets the identical layout/wording instead of each one hand-rolling it.
 * Page-number math (0-indexed vs 1-indexed, what "page" means to the caller's own state) stays
 * with the caller — this only renders `page`/`totalPages` as given and calls `onPrev`/`onNext`.
 */
export default function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
}) {
  return (
    <div className="toolbar" style={{ justifyContent: "center", marginTop: 20 }}>
      {total > pageSize && (
        <>
          <button type="button" className="icon-button" onClick={onPrev} disabled={!hasPrev} title="Previous page" aria-label="Previous page">
            <ChevronLeftIcon />
          </button>
          <span className="sub">
            Page {page} of {totalPages} ({total} total)
          </span>
          <button type="button" className="icon-button" onClick={onNext} disabled={!hasNext} title="Next page" aria-label="Next page">
            <ChevronRightIcon />
          </button>
        </>
      )}
      <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))} style={{ maxWidth: 140 }} title="Items per page">
        {pageSizeOptions.map((n) => (
          <option key={n} value={n}>
            {n} per page
          </option>
        ))}
      </select>
    </div>
  );
}
