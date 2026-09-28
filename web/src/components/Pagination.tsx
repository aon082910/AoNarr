import { useEffect, useRef } from "react";
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
  loading = false,
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
  /** Pass the caller's own fetch-in-flight flag, if it tracks one, so the scroll-into-view below
   * waits for the new page's rows to actually be on screen instead of firing the instant `page`
   * changes — done too early, that raced the fetch and a layout shift once the real content
   * arrived would override it, landing back at the top instead. A caller with no loading state at
   * all just gets the immediate (pre-existing) behavior, since `loading` never becomes true. */
  loading?: boolean;
}) {
  // Prev/Next sits at the bottom of the list it paginates — clicking it used to leave the viewport
  // wherever it happened to land (often the top, once the new page's content rendered), so getting
  // to the next/previous page's own bottom (to click Prev/Next again, or just to keep reading from
  // here) meant scrolling all the way down again every time. Scrolling this control itself back
  // into view once a genuine page change's fetch has finished (comparing against the last page
  // actually scrolled to, not a plain "skip first render" flag, so this never fires on mount) keeps
  // you exactly where you'd expect to end up.
  const ref = useRef<HTMLDivElement>(null);
  const lastScrolledPageRef = useRef(page);
  // The pending timer is tracked in its own ref rather than returned as this effect's cleanup
  // function on purpose — see the identical fix and full reasoning in LibraryType.tsx's own copy
  // of this effect: a plain `return () => clearTimeout(timer)` gets invoked on *every* re-run of
  // this effect, including a `loading` flicker unrelated to this page (a second, redundant fetch
  // settling for the page that's already current), which cancelled the pending scroll before it
  // ever fired.
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (loading || lastScrolledPageRef.current === page) return;
    lastScrolledPageRef.current = page;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    // A short delay, not immediate: a caller's own setItems (new rows) and setLoading(false) often
    // land in two separate render commits, so scrolling the instant `loading` clears can still
    // measure the OLD page's (different-length) layout before the new one actually commits.
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      ref.current?.scrollIntoView({ block: "end" });
    }, 80);
  }, [page, loading]);
  useEffect(() => () => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
  }, []);

  return (
    <div ref={ref} className="toolbar" style={{ justifyContent: "center", marginTop: 20 }}>
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
