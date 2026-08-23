import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
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
import NetworkStats from "./pages/NetworkStats.js";
import { useMediaTypes } from "./hooks/useMediaTypes.js";

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

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<any[]>("/root-folders")
      .then((rows) => setShowOnboarding(shouldShowOnboarding(rows.length)))
      .catch(() => {});
  }, [isAdmin]);

  return (
    <div className="app">
      <CommandPalette />
      <nav className="sidebar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          AoNarr
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

        {isAdmin && (
          <NavGroup label="Manage">
            <NavLink to="/add">Add Media</NavLink>
            <NavLink to="/recommendations">Recommendations</NavLink>
            <NavLink to="/watchlist-import">Watchlist Import</NavLink>
            <NavLink to="/import-lists">Import Lists</NavLink>
            <NavLink to="/calendar">Calendar</NavLink>
            <NavLink to="/missing">Missing</NavLink>
            <NavLink to="/activity">Activity</NavLink>
          </NavGroup>
        )}

        {isAdmin && (
          <NavGroup label="Configuration">
            <NavLink to="/indexers">Indexers</NavLink>
            <NavLink to="/download-clients">Download Clients</NavLink>
            <NavLink to="/users">Users</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </NavGroup>
        )}

        {isAdmin && (
          <NavGroup label="System">
            <NavLink to="/system">Status &amp; Health</NavLink>
            <NavLink to="/jobs">Jobs</NavLink>
            <NavLink to="/recycle-bin">Recycle Bin</NavLink>
            <NavLink to="/network-stats">Network Stats</NavLink>
            <NavLink to="/audit-log">Audit Log</NavLink>
            <NavLink to="/api-docs">API Docs</NavLink>
            <NavLink to="/remote-library">Remote Library</NavLink>
            <NavLink to="/friend-libraries">Friend Libraries</NavLink>
          </NavGroup>
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
          {isAdmin && <Route path="/network-stats" element={<NetworkStats />} />}
          {isAdmin && <Route path="/api-docs" element={<ApiDocs />} />}
          {isAdmin && <Route path="/remote-library" element={<RemoteLibrary />} />}
          {isAdmin && <Route path="/friend-libraries" element={<FriendLibraries />} />}
        </Routes>
      </main>
    </div>
  );
}
