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
import Users from "./pages/Users.js";
import Recommendations from "./pages/Recommendations.js";
import AuditLog from "./pages/AuditLog.js";
import WatchlistImport from "./pages/WatchlistImport.js";
import ImportReview from "./pages/ImportReview.js";
import { useAuth } from "./context/AuthContext.js";
import NotificationsToggle from "./components/NotificationsToggle.js";
import ThemeToggle from "./components/ThemeToggle.js";
import CommandPalette from "./components/CommandPalette.js";
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

export default function App() {
  const { auth, logout } = useAuth();
  const isAdmin = auth.isAdmin;
  const [showOnboarding, setShowOnboarding] = useState(false);
  const mediaTypes = useMediaTypes().filter((t) => isAdmin || auth.user?.allowedTypes.includes(t.key));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("aonarr_sidebar_collapsed") === "1");
  const [customizingSidebar, setCustomizingSidebar] = useState(false);

  useEffect(() => {
    localStorage.setItem("aonarr_sidebar_collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<any[]>("/root-folders")
      .then((rows) => setShowOnboarding(shouldShowOnboarding(rows.length)))
      .catch(() => {});
  }, [isAdmin]);

  // Only the admin-only section groups are reorderable — Library stays pinned right after
  // Dashboard since every account (including household logins) relies on it being there, and
  // reordering/hiding it would just be a way to accidentally lose your own library nav.
  const adminGroupDefs: { key: string; label: string; render: () => ReactNode }[] = [
    {
      key: "manage",
      label: "Manage",
      render: () => (
        <NavGroup label="Manage">
          <NavLink to="/add">Add Media</NavLink>
          <NavLink to="/recommendations">Recommendations</NavLink>
          <NavLink to="/watchlist-import">Watchlist Import</NavLink>
          <NavLink to="/import-review">Import Review</NavLink>
          <NavLink to="/import-lists">Import Lists</NavLink>
          <NavLink to="/calendar">Calendar</NavLink>
          <NavLink to="/missing">Missing</NavLink>
          <NavLink to="/activity">Activity</NavLink>
        </NavGroup>
      ),
    },
    {
      key: "configuration",
      label: "Configuration",
      render: () => (
        <NavGroup label="Configuration">
          <NavLink to="/indexers">Indexers</NavLink>
          <NavLink to="/download-clients">Download Clients</NavLink>
          <NavLink to="/users">Users</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </NavGroup>
      ),
    },
    {
      key: "system",
      label: "System",
      render: () => (
        <NavGroup label="System">
          <NavLink to="/system">Status &amp; Health</NavLink>
          <NavLink to="/jobs">Jobs</NavLink>
          <NavLink to="/recycle-bin">Recycle Bin</NavLink>
          <NavLink to="/duplicates">Duplicates</NavLink>
          <NavLink to="/network-stats">Network Stats</NavLink>
          <NavLink to="/media-analyzer">Media Analyzer</NavLink>
          <NavLink to="/audit-log">Audit Log</NavLink>
          <NavLink to="/api-docs">API Docs</NavLink>
          <NavLink to="/remote-library">Remote Library</NavLink>
          <NavLink to="/friend-libraries">Friend Libraries</NavLink>
        </NavGroup>
      ),
    },
  ];
  const { orderedItems: orderedGroups, visibleItems: visibleGroups, hidden: hiddenGroups, moveUp: moveGroupUp, moveDown: moveGroupDown, toggleHidden: toggleGroupHidden } =
    useCustomizableLayout(
      "aonarr_sidebar_groups",
      adminGroupDefs.map((g) => ({ key: g.key, label: g.label }))
    );
  const groupByKey = new Map(adminGroupDefs.map((g) => [g.key, g]));

  return (
    <div className="app">
      <ScrollToTop />
      <CommandPalette />
      <button
        type="button"
        className="secondary"
        onClick={() => setSidebarCollapsed((v) => !v)}
        title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        style={{ position: "fixed", top: 12, left: 12, zIndex: 30, padding: "4px 10px", margin: 0, display: sidebarCollapsed ? "block" : "none" }}
      >
        ☰
      </button>
      <nav className="sidebar" style={sidebarCollapsed ? { display: "none" } : undefined}>
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

        <NavGroup label="Library" defaultOpen>
          <NavLink to="/library" end>
            Overview
          </NavLink>
          {mediaTypes.map((t) => (
            <NavLink key={t.key} to={`/library/${t.key}`}>
              {t.label}
            </NavLink>
          ))}
        </NavGroup>

        <NavLink to="/search">Search</NavLink>
        <NavLink to="/collections">Collections</NavLink>
        <NavLink to="/requests">Requests</NavLink>
        <NavLink to="/changelog">What's New</NavLink>
        <NavLink to="/account">Account</NavLink>

        {isAdmin && visibleGroups.map((g) => <div key={g.key}>{groupByKey.get(g.key)?.render()}</div>)}

        {isAdmin && (
          <>
            <a onClick={() => setCustomizingSidebar((v) => !v)} style={{ cursor: "pointer", fontSize: "0.85rem" }}>
              {customizingSidebar ? "Done customizing" : "Customize sections..."}
            </a>
            {customizingSidebar && (
              <div style={{ padding: "4px 20px 8px" }}>
                {orderedGroups.map((item, idx) => (
                  <div key={item.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" }}>
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
                        style={{ padding: "1px 7px", margin: 0, fontSize: "0.75rem" }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => moveGroupDown(item.key)}
                        disabled={idx === orderedGroups.length - 1}
                        style={{ padding: "1px 7px", margin: 0, fontSize: "0.75rem" }}
                      >
                        ↓
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column" }}>
          <ThemeToggle />
          <NotificationsToggle />
          <a onClick={logout} style={{ cursor: "pointer" }}>
            Log out
          </a>
        </div>
      </nav>
      <main className="content">
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
          <Route path="/changelog" element={<Changelog />} />
          <Route path="/account" element={<Account />} />
          {isAdmin && <Route path="/add" element={<AddMedia />} />}
          {isAdmin && <Route path="/recommendations" element={<Recommendations />} />}
          {isAdmin && <Route path="/watchlist-import" element={<WatchlistImport />} />}
          {isAdmin && <Route path="/import-review" element={<ImportReview />} />}
          {isAdmin && <Route path="/import-lists" element={<ImportLists />} />}
          {isAdmin && <Route path="/calendar" element={<Calendar />} />}
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
