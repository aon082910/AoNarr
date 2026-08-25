import { useState } from "react";

const STORAGE_KEY = "aonarr_layout_width";

function getStoredWidth(): "centered" | "full" {
  return localStorage.getItem(STORAGE_KEY) === "full" ? "full" : "centered";
}

export default function LayoutWidthToggle() {
  const [width, setWidth] = useState<"centered" | "full">(getStoredWidth());

  function toggle() {
    const next = width === "full" ? "centered" : "full";
    setWidth(next);
    localStorage.setItem(STORAGE_KEY, next);
    if (next === "full") document.documentElement.setAttribute("data-layout-width", "full");
    else document.documentElement.removeAttribute("data-layout-width");
  }

  return (
    <a onClick={toggle} style={{ cursor: "pointer" }}>
      {width === "full" ? "Switch to centered layout" : "Switch to full-width layout"}
    </a>
  );
}
