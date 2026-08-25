import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client.js";
import Dashboard from "./pages/Dashboard.js";
import Onboarding, { shouldShowOnboarding } from "./pages/Onboarding.js";
import LibraryHome from "./pages/LibraryHome.js";
import LibraryType from "./pages/LibraryType.js";
import LibraryUngrouped from "./pages/LibraryUngrouped.js";
import MediaDetail from "./pages/MediaDetail.js";
import EpisodeDetail from "./pages/EpisodeDetail.js";
import SubItemDetail from "./pages/SubItemDetail.js";
import TrackDetail from "./pages/TrackDetail.js";
import AddMedia from "./pages/AddMedia.js";
import Calendar from "./pages/Calendar.js";
import CalendarDay from "./pages/CalendarDay.js";
import Missing from "./pages/Missing.js";
import Indexers from "./pages/Indexers.js";
import DownloadClients from "./pages/DownloadClients.js";
import Settings from "./pages/Settings.js";
import Activity from "./pages/Activity.js";
import System from "./pages/System.js";
import GlobalSearch from "./pages/GlobalSearch.js";
import Collections from "./pages/Collections.js";
import CollectionDetail from "./pages/CollectionDetail.js";
import Requests from "./pages/Requests.js";
import Discover from "./pages/Discover.js";
import AiProviders from "./pages/AiProviders.js";
import CustomColumns from "./pages/CustomColumns.js";
import IptvPlaylists from "./pages/IptvPlaylists.js";
import Users from "./pages/Users.js";
import Recommendations from "./pages/Recommendations.js";
import AuditLog from "./pages/AuditLog.js";
import WatchlistImport from "./pages/WatchlistImport.js";
import ImportReview from "./pages/ImportReview.js";
import { useAuth } from "./context/AuthContext.js";
import NotificationsToggle from "./components/NotificationsToggle.js";
import ThemeToggle from "./components/ThemeToggle.js";
import LayoutWidthToggle from "./components/LayoutWidthToggle.js";
import CommandPalette from "./components/CommandPalette.js";
import DropdownMenu from "./components/DropdownMenu.js";
import ApiDocs from "./pages/ApiDocs.js";
import Changelog from "./pages/Changelog.js";
import Person from "./pages/Person.js";
import RemoteLibrary from "./pages/RemoteLibrary.js";
import FriendLibraries from "./pages/FriendLibraries.js";
import ImportLists from "./pages/ImportLists.js";
import Account from "./pages/Account.js";
import Jobs from "./pages/Jobs.js";
import RecycleBin from "./pages/RecycleBin.js";
import Duplicates from "./pages/Duplicates.js";
import NetworkStats from "./pages/NetworkStats.js";
import MediaAnalyzer from "./pages/MediaAnalyzer.js";
import { useMediaTypes } from "./hooks/useMediaTypes.js";
import { useCustomizableLayout } from "./hooks/useCustomizableLayout.js";

/** Plain <BrowserRouter>/<Routes> (not the data-router API) never touches scroll position on
 * navigation on its own — this is what actually resets it back to the top of the new page. */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function NavGroup({
  label,
  defaultOpen,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div>
      <a onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer", display: "flex", justifyContent: "space-between" }}>
        <span>{label}</span>
        <span>{open ? "▾" : "▸"}</span>
      </a>
      {open && <div style={{ paddingLeft: 12 }}>{children}</div>}
    </div>
  );
}

interface NavLinkDef {
  to: string;
  label: string;
  end?: boolean;
}

/** Sidebar rendering for one admin group: the existing expandable-accordion look. */
function SidebarGroup({ label, links, defaultOpen }: { label: string; links: NavLinkDef[]; defaultOpen?: boolean }) {
  return (
    <NavGroup label={label} defaultOpen={defaultOpen}>
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end}>
          {l.label}
        </NavLink>
      ))}
    </NavGroup>
  );
}

/** Top-bar rendering for one admin group: a click-to-open dropdown instead of an inline
 * accordion, since a horizontal bar has no room to expand a section in place the way the
 * sidebar's vertical list does. */
function TopbarGroup({ label, links }: { label: string; links: NavLinkDef[] }) {
  return (
    <DropdownMenu label={label} buttonClassName="topbar-trigger">
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end}>
          {l.label}
        </NavLink>
      ))}
    </DropdownMenu>
  );
}

export default function App() {
  const { auth, logout } = useAuth();
  const { pathname } = useLocation();
  const isAdmin = auth.isAdmin;
  const [showOnboarding, setShowOnboarding] = useState(false);
  const mediaTypes = useMediaTypes().filter((t) => isAdmin || auth.user?.allowedTypes.includes(t.key));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const stored = localStorage.getItem("aonarr_sidebar_collapsed");
    if (stored !== null) return stored === "1";
    // No saved preference yet (first visit on this device) — default collapsed on a narrow/mobile
    // viewport, where the sidebar's fixed 220px would otherwise eat most of the screen. Desktop's
    // default (expanded) is unchanged; this only picks a different first-run default, it never
    // overrides a choice the user already made.
    return typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;
  });
  const [customizingSidebar, setCustomizingSidebar] = useState(false);
  const [navPosition, setNavPosition] = useState<"side" | "top">(
    () => (localStorage.getItem("aonarr_nav_position") as "side" | "top") || "side"
  );

  useEffect(() => {
    localStorage.setItem("aonarr_sidebar_collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem("aonarr_nav_position", navPosition);
  }, [navPosition]);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<any[]>("/root-folders")
      .then((rows) => setShowOnboarding(shouldShowOnboarding(rows.length)))
      .catch(() => {});
  }, [isAdmin]);

  const libraryLinks: NavLinkDef[] = [
    { to: "/library", label: "Overview", end: true },
    ...mediaTypes.map((t) => ({ to: `/library/${t.key}`, label: t.label })),
  ];
  // Search is rendered as its own hardcoded link (like Dashboard) rather than living in this array,
  // since it belongs between Dashboard and Library in the fixed top-level order — everything else
  // that isn't Library renders after Library, so it can't get there through this array alone.
  // Admins reach Discover/Requests through the "Manage" group below; household accounts have no
  // such group at all, so without these they'd have no way to reach either page short of typing
  // the URL by hand — Requests.tsx already renders a full submission form for them, it just had no
  // nav link pointing at it before Discover made that gap obvious.
  const standaloneLinks: NavLinkDef[] = isAdmin
    ? [{ to: "/account", label: "Account" }]
    : [
        { to: "/discover", label: "Discover" },
        { to: "/requests", label: "Requests" },
        { to: "/account", label: "Account" },
      ];

  // Only the admin-only section groups are reorderable — Library stays pinned right after
  // Dashboard since every account (including household logins) relies on it being there, and
  // reordering/hiding it would just be a way to accidentally lose your own library nav. Plain
  // link data rather than pre-rendered JSX, since the sidebar and top-bar layouts render the same
  // groups two different ways (an accordion vs. a dropdown) — see SidebarGroup/TopbarGroup above.
  const adminGroupDefs: { key: string; label: string; links: NavLinkDef[] }[] = [
    {
      key: "manage",
      label: "Manage",
      links: [
        { to: "/add", label: "Add Media" },
        { to: "/activity", label: "Activity" },
        { to: "/calendar", label: "Calendar" },
        { to: "/collections", label: "Collections" },
        { to: "/discover", label: "Discover" },
        { to: "/iptv-playlists", label: "IPTV Playlists" },
        { to: "/import-lists", label: "Import Lists" },
        { to: "/import-review", label: "Import Review" },
        { to: "/missing", label: "Missing" },
        { to: "/recommendations", label: "Recommendations" },
        { to: "/requests", label: "Requests" },
        { to: "/watchlist-import", label: "Watchlist Import" },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    },
    {
      key: "configuration",
      label: "Configuration",
      links: [
        { to: "/ai-providers", label: "AI Providers" },
        { to: "/custom-columns", label: "Custom Columns" },
        { to: "/download-clients", label: "Download Clients" },
        { to: "/indexers", label: "Indexers" },
        { to: "/settings", label: "Settings" },
        { to: "/users", label: "Users" },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    },
    {
      key: "system",
      label: "System",
      links: [
        { to: "/api-docs", label: "API Docs" },
        { to: "/audit-log", label: "Audit Log" },
        { to: "/duplicates", label: "Duplicates" },
        { to: "/friend-libraries", label: "Friend Libraries" },
        { to: "/jobs", label: "Jobs" },
        { to: "/media-analyzer", label: "Media Analyzer" },
        { to: "/network-stats", label: "Network Stats" },
        { to: "/recycle-bin", label: "Recycle Bin" },
        { to: "/remote-library", label: "Remote Library" },
        { to: "/system", label: "Status & Health" },
        { to: "/changelog", label: "What's New" },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    },
  ];
  const { orderedItems: orderedGroups, visibleItems: visibleGroups, hidden: hiddenGroups, moveUp: moveGroupUp, moveDown: moveGroupDown, toggleHidden: toggleGroupHidden } =
    useCustomizableLayout(
      "aonarr_sidebar_groups",
      adminGroupDefs.map((g) => ({ key: g.key, label: g.label }))
    );
  const groupByKey = new Map(adminGroupDefs.map((g) => [g.key, g]));

  const customizePanel = (
    <div style={{ padding: navPosition === "side" ? "4px 20px 8px" : "8px 4px" }}>
      {orderedGroups.map((item, idx) => (
        <div key={item.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", gap: 12 }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              margin: 0,
              fontSize: "0.8rem",
              color: hiddenGroups.has(item.key) ? "var(--muted)" : "var(--text)",
            }}
          >
            <input type="checkbox" checked={!hiddenGroups.has(item.key)} onChange={() => toggleGroupHidden(item.key)} />
            {item.label}
          </label>
          <div style={{ display: "flex", gap: 2 }}>
            <button
              type="button"
              className="secondary"
              onClick={() => moveGroupUp(item.key)}
              disabled={idx === 0}
              aria-label={`Move ${item.label} up`}
              style={{ padding: "1px 7px", margin: 0, fontSize: "0.75rem" }}
            >
              ↑
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => moveGroupDown(item.key)}
              disabled={idx === orderedGroups.length - 1}
              aria-label={`Move ${item.label} down`}
              style={{ padding: "1px 7px", margin: 0, fontSize: "0.75rem" }}
            >
              ↓
            </button>
          </div>
        </div>
      ))}
      <label style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0 0", fontSize: "0.8rem" }}>
        Nav position:
        <select
          value={navPosition}
          onChange={(e) => setNavPosition(e.target.value as "side" | "top")}
          style={{ width: "auto", height: 26, padding: "0 22px 0 6px", fontSize: "0.8rem" }}
        >
          <option value="side">Sidebar</option>
          <option value="top">Top bar</option>
        </select>
      </label>
    </div>
  );

  return (
    <div className={navPosition === "top" ? "app app--top" : "app"}>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <ScrollToTop />
      <CommandPalette />

      {navPosition === "side" && (
        <>
          <button
            type="button"
            className="secondary"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            style={{
              position: "fixed",
              top: 12,
              left: 12,
              zIndex: 30,
              padding: 0,
              margin: 0,
              width: 40,
              height: 40,
              fontSize: "1.1rem",
              display: sidebarCollapsed ? "flex" : "none",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ☰
          </button>
          {/* On a narrow viewport the sidebar sits above content as a full-width overlay while
              expanded (rather than squeezing content into the leftover ~150px next to a fixed
              220px column) — dismissed the same way it's opened, via the ☰ toggle. */}
          <nav
            className="sidebar"
            style={
              sidebarCollapsed
                ? { display: "none" }
                : window.matchMedia("(max-width: 768px)").matches
                  ? { position: "fixed", inset: 0, width: "100%", zIndex: 25, overflowY: "auto" }
                  : undefined
            }
          >
            <div className="brand" style={{ justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <img src="/icon.svg" alt="" width={28} height={28} />
                AoNarr
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => setSidebarCollapsed(true)}
                title="Hide sidebar"
                style={{ padding: "2px 8px", margin: 0, fontSize: "0.8rem" }}
              >
                ☰
              </button>
            </div>
            <div style={{ fontSize: "0.7rem", color: "var(--muted)", padding: "0 12px 8px" }} title="Ctrl/Cmd+K to jump anywhere, / to search">
              ⌘K to jump · / to search
            </div>
            <NavLink to="/" end>
              Dashboard
            </NavLink>
            <NavLink to="/search">Search</NavLink>

            <SidebarGroup label="Library" links={libraryLinks} defaultOpen />

            {standaloneLinks.map((l) => (
              <NavLink key={l.to} to={l.to}>
                {l.label}
              </NavLink>
            ))}

            {isAdmin && visibleGroups.map((g) => <SidebarGroup key={g.key} label={g.label} links={groupByKey.get(g.key)?.links ?? []} />)}

            {isAdmin && (
              <>
                <a onClick={() => setCustomizingSidebar((v) => !v)} style={{ cursor: "pointer", fontSize: "0.85rem" }}>
                  {customizingSidebar ? "Done customizing" : "Customize sections..."}
                </a>
                {customizingSidebar && customizePanel}
              </>
            )}

            <div style={{ marginTop: "auto", display: "flex", flexDirection: "column" }}>
              <ThemeToggle />
              <LayoutWidthToggle />
              <NotificationsToggle />
              <a onClick={logout} style={{ cursor: "pointer" }}>
                Log out
              </a>
            </div>
          </nav>
        </>
      )}

      {navPosition === "top" && (
        <header className="topbar">
          <span className="brand">
            <img src="/icon.svg" alt="" width={24} height={24} />
            AoNarr
          </span>
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/search">Search</NavLink>
          <TopbarGroup label="Library" links={libraryLinks} />
          {standaloneLinks.map((l) => (
            <NavLink key={l.to} to={l.to}>
              {l.label}
            </NavLink>
          ))}
          {isAdmin && visibleGroups.map((g) => <TopbarGroup key={g.key} label={g.label} links={groupByKey.get(g.key)?.links ?? []} />)}
          <div className="topbar-spacer" style={{ position: "relative" }}>
            {isAdmin && (
              <>
                <button type="button" className="secondary" onClick={() => setCustomizingSidebar((v) => !v)} title="Layout options">
                  ⚙
                </button>
                {customizingSidebar && (
                  <div className="dropdown-menu" style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, left: "auto", minWidth: 260 }}>
                    {customizePanel}
                  </div>
                )}
              </>
            )}
            <ThemeToggle />
            <LayoutWidthToggle />
            <NotificationsToggle />
            <a onClick={logout} style={{ cursor: "pointer" }}>
              Log out
            </a>
          </div>
        </header>
      )}

      <main className="content" id="main-content" tabIndex={-1}>
        <Routes>
          <Route
            path="/"
            element={
              isAdmin && showOnboarding ? <Onboarding onDone={() => setShowOnboarding(false)} /> : <Dashboard />
            }
          />
          <Route path="/library" element={<LibraryHome />} />
          <Route path="/library/:type" element={<LibraryType />} />
          <Route path="/library/:type/g/:groupId" element={<LibraryType />} />
          <Route path="/library/:type/ungrouped" element={<LibraryUngrouped />} />
          <Route path="/media/:id" element={<MediaDetail />} />
          <Route path="/media/:mediaId/episode/:episodeId" element={<EpisodeDetail />} />
          <Route path="/media/:mediaId/item/:subItemId" element={<SubItemDetail />} />
          <Route path="/media/:mediaId/item/:subItemId/track/:trackId" element={<TrackDetail />} />
          <Route path="/people/:tmdbId" element={<Person />} />
          <Route path="/search" element={<GlobalSearch />} />
          <Route path="/collections" element={<Collections />} />
          <Route path="/collections/:id" element={<CollectionDetail />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/discover" element={<Discover />} />
          {isAdmin && <Route path="/ai-providers" element={<AiProviders />} />}
          {isAdmin && <Route path="/custom-columns" element={<CustomColumns />} />}
          {isAdmin && <Route path="/iptv-playlists" element={<IptvPlaylists />} />}
          <Route path="/changelog" element={<Changelog />} />
          <Route path="/account" element={<Account />} />
          {isAdmin && <Route path="/add" element={<AddMedia />} />}
          {isAdmin && <Route path="/recommendations" element={<Recommendations />} />}
          {isAdmin && <Route path="/watchlist-import" element={<WatchlistImport />} />}
          {isAdmin && <Route path="/import-review" element={<ImportReview />} />}
          {isAdmin && <Route path="/import-lists" element={<ImportLists />} />}
          {isAdmin && <Route path="/calendar" element={<Calendar />} />}
          {isAdmin && <Route path="/calendar/:date" element={<CalendarDay />} />}
          {isAdmin && <Route path="/missing" element={<Missing />} />}
          {isAdmin && <Route path="/activity" element={<Activity />} />}
          {isAdmin && <Route path="/indexers" element={<Indexers />} />}
          {isAdmin && <Route path="/download-clients" element={<DownloadClients />} />}
          {isAdmin && <Route path="/users" element={<Users />} />}
          {isAdmin && <Route path="/audit-log" element={<AuditLog />} />}
          {isAdmin && <Route path="/settings" element={<Settings />} />}
          {isAdmin && <Route path="/system" element={<System />} />}
          {isAdmin && <Route path="/jobs" element={<Jobs />} />}
          {isAdmin && <Route path="/recycle-bin" element={<RecycleBin />} />}
          {isAdmin && <Route path="/duplicates" element={<Duplicates />} />}
          {isAdmin && <Route path="/network-stats" element={<NetworkStats />} />}
          {isAdmin && <Route path="/media-analyzer" element={<MediaAnalyzer />} />}
          {isAdmin && <Route path="/api-docs" element={<ApiDocs />} />}
          {isAdmin && <Route path="/remote-library" element={<RemoteLibrary />} />}
          {isAdmin && <Route path="/friend-libraries" element={<FriendLibraries />} />}
        </Routes>
      </main>
    </div>
  );
}
