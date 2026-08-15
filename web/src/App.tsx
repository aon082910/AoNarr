import { NavLink, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard.js";
import Library from "./pages/Library.js";
import MediaDetail from "./pages/MediaDetail.js";
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

export default function App() {
  const { auth, logout } = useAuth();
  const isAdmin = auth.isAdmin;

  return (
    <div className="app">
      <CommandPalette />
      <nav className="sidebar">
        <div className="brand">AoNarr</div>
        <div style={{ fontSize: "0.7rem", color: "var(--muted)", padding: "0 12px 8px" }} title="Ctrl/Cmd+K to jump anywhere, / to search">
          ⌘K to jump · / to search
        </div>
        <NavLink to="/" end>
          Dashboard
        </NavLink>
        <NavLink to="/library">Library</NavLink>
        <NavLink to="/search">Search</NavLink>
        <NavLink to="/collections">Collections</NavLink>
        {isAdmin && <NavLink to="/add">Add Media</NavLink>}
        {isAdmin && <NavLink to="/recommendations">Recommendations</NavLink>}
        {isAdmin && <NavLink to="/watchlist-import">Watchlist Import</NavLink>}
        <NavLink to="/requests">Requests</NavLink>
        <NavLink to="/changelog">What's New</NavLink>
        {isAdmin && <NavLink to="/calendar">Calendar</NavLink>}
        {isAdmin && <NavLink to="/missing">Missing</NavLink>}
        {isAdmin && <NavLink to="/activity">Activity</NavLink>}
        {isAdmin && <NavLink to="/indexers">Indexers</NavLink>}
        {isAdmin && <NavLink to="/download-clients">Download Clients</NavLink>}
        {isAdmin && <NavLink to="/users">Users</NavLink>}
        {isAdmin && <NavLink to="/audit-log">Audit Log</NavLink>}
        {isAdmin && <NavLink to="/settings">Settings</NavLink>}
        {isAdmin && <NavLink to="/system">System</NavLink>}
        {isAdmin && <NavLink to="/api-docs">API Docs</NavLink>}
        {isAdmin && <NavLink to="/remote-library">Remote Library</NavLink>}
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
          <Route path="/" element={<Dashboard />} />
          <Route path="/library" element={<Library />} />
          <Route path="/media/:id" element={<MediaDetail />} />
          <Route path="/people/:tmdbId" element={<Person />} />
          <Route path="/search" element={<GlobalSearch />} />
          <Route path="/collections" element={<Collections />} />
          <Route path="/collections/:id" element={<CollectionDetail />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/changelog" element={<Changelog />} />
          {isAdmin && <Route path="/add" element={<AddMedia />} />}
          {isAdmin && <Route path="/recommendations" element={<Recommendations />} />}
          {isAdmin && <Route path="/watchlist-import" element={<WatchlistImport />} />}
          {isAdmin && <Route path="/calendar" element={<Calendar />} />}
          {isAdmin && <Route path="/missing" element={<Missing />} />}
          {isAdmin && <Route path="/activity" element={<Activity />} />}
          {isAdmin && <Route path="/indexers" element={<Indexers />} />}
          {isAdmin && <Route path="/download-clients" element={<DownloadClients />} />}
          {isAdmin && <Route path="/users" element={<Users />} />}
          {isAdmin && <Route path="/audit-log" element={<AuditLog />} />}
          {isAdmin && <Route path="/settings" element={<Settings />} />}
          {isAdmin && <Route path="/system" element={<System />} />}
          {isAdmin && <Route path="/api-docs" element={<ApiDocs />} />}
          {isAdmin && <Route path="/remote-library" element={<RemoteLibrary />} />}
        </Routes>
      </main>
    </div>
  );
}
