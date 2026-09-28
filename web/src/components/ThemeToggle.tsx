import { useState } from "react";
import { MoonIcon, SunIcon } from "./NavIcons.js";

const STORAGE_KEY = "aonarr_theme";

function getStoredTheme(): "light" | "dark" {
  return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
}

export default function ThemeToggle({ className = "link-button" }: { className?: string }) {
  const [theme, setTheme] = useState<"light" | "dark">(getStoredTheme());

  function toggle() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    if (next === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  }

  const label = theme === "light" ? "Switch to dark theme" : "Switch to light theme";

  return (
    <button type="button" className={className} onClick={toggle} title={label} aria-label={label}>
      {theme === "light" ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}
