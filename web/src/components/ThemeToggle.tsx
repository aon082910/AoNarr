import { useState } from "react";

const STORAGE_KEY = "aonarr_theme";

function getStoredTheme(): "light" | "dark" {
  return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(getStoredTheme());

  function toggle() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    if (next === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  }

  return (
    <a onClick={toggle} style={{ cursor: "pointer" }}>
      {theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
    </a>
  );
}
