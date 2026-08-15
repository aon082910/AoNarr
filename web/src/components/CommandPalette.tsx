import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";

interface Command {
  label: string;
  path: string;
  adminOnly?: boolean;
}

const ALL_COMMANDS: Command[] = [
  { label: "Dashboard", path: "/" },
  { label: "Library", path: "/library" },
  { label: "Search", path: "/search" },
  { label: "Collections", path: "/collections" },
  { label: "Add Media", path: "/add", adminOnly: true },
  { label: "Recommendations", path: "/recommendations", adminOnly: true },
  { label: "Watchlist Import", path: "/watchlist-import", adminOnly: true },
  { label: "Requests", path: "/requests" },
  { label: "What's New", path: "/changelog" },
  { label: "Calendar", path: "/calendar", adminOnly: true },
  { label: "Missing", path: "/missing", adminOnly: true },
  { label: "Activity", path: "/activity", adminOnly: true },
  { label: "Indexers", path: "/indexers", adminOnly: true },
  { label: "Download Clients", path: "/download-clients", adminOnly: true },
  { label: "Users", path: "/users", adminOnly: true },
  { label: "Audit Log", path: "/audit-log", adminOnly: true },
  { label: "Settings", path: "/settings", adminOnly: true },
  { label: "System", path: "/system", adminOnly: true },
];

/**
 * Ctrl/Cmd+K opens a fuzzy-filterable jump-to-page palette; "/" from anywhere not already typing
 * in a field jumps straight to Search. Both are ignored while focus is in an input/textarea/select
 * (except the palette's own search box) so they never interfere with normal typing.
 */
export default function CommandPalette() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo(() => ALL_COMMANDS.filter((c) => !c.adminOnly || auth.isAdmin), [auth.isAdmin]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    function isTypingTarget(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
        return;
      }
      if (!open && e.key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault();
        navigate("/search");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, navigate]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  function go(path: string) {
    navigate(path);
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="form-panel"
        style={{ width: 480, maxWidth: "90vw", padding: 0, overflow: "hidden" }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to..."
          style={{ border: "none", borderBottom: "1px solid var(--border)", borderRadius: 0, margin: 0 }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && filtered[activeIndex]) {
              e.preventDefault();
              go(filtered[activeIndex].path);
            }
          }}
        />
        <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
          {filtered.length === 0 && <div style={{ padding: 12, color: "var(--muted)" }}>No matches.</div>}
          {filtered.map((c, idx) => (
            <div
              key={c.path}
              onClick={() => go(c.path)}
              onMouseEnter={() => setActiveIndex(idx)}
              style={{
                padding: "10px 14px",
                cursor: "pointer",
                background: idx === activeIndex ? "var(--border)" : undefined,
              }}
            >
              {c.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
