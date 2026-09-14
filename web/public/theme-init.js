// Applied before React renders to avoid a flash of the wrong theme/layout on load. A separate
// static file (not inline in index.html) so the page's Content-Security-Policy can use a plain
// `script-src 'self'` with no `unsafe-inline` — see nginx.conf.template / combined/nginx.conf.
try {
  var t = localStorage.getItem("aonarr_theme");
  if (t === "light") document.documentElement.setAttribute("data-theme", "light");
  var w = localStorage.getItem("aonarr_layout_width");
  if (w === "full") document.documentElement.setAttribute("data-layout-width", "full");
} catch (e) {}
