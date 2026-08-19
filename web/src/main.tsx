import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App.js";
import ApiKeyGate from "./components/ApiKeyGate.js";
import SharePage from "./pages/SharePage.js";
import "./styles.css";

// Fetched and appended at runtime (rather than a static <link> in index.html) so it's guaranteed
// to land after the bundled stylesheet in the DOM regardless of where Vite's build injects that
// stylesheet's own <link>/<style> tag — CSS ties resolve by source order, so this is what actually
// lets an admin's custom theme (Settings -> General) override the built-in one.
fetch("/api/theme.css")
  .then((r) => r.text())
  .then((css) => {
    if (!css.trim()) return;
    const style = document.createElement("style");
    style.id = "aonarr-custom-theme";
    style.textContent = css;
    document.head.appendChild(style);
  })
  .catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/share/:token" element={<SharePage />} />
        <Route
          path="/*"
          element={
            <ApiKeyGate>
              <App />
            </ApiKeyGate>
          }
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("Service worker registration failed:", err));
  });
}
