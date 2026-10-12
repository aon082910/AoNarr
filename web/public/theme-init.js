// Applied before React renders to avoid a flash of the wrong theme/layout on load. A separate
// static file (not inline in index.html) so the page's Content-Security-Policy can use a plain
// `script-src 'self'` with no `unsafe-inline` — see nginx.conf.template / combined/nginx.conf.
try {
  var t = localStorage.getItem("aonarr_theme");
  if (t === "light") document.documentElement.setAttribute("data-theme", "light");
  var w = localStorage.getItem("aonarr_layout_width");
  if (w === "full") document.documentElement.setAttribute("data-layout-width", "full");
  // UI design (Settings/nav -> "Change design"). "classic" = the original look = no attribute. The id
  // list must match DESIGNS in src/designs/design.ts — an unknown id would set an attribute with no
  // CSS behind it. ?design=<id> works as a recovery link (e.g. /?design=classic) and is remembered.
  var ids = ["midnight", "aurora", "ember", "noir", "paper", "terminal"];
  var q = /[?&]design=([a-z]+)/.exec(location.search);
  if (q && (q[1] === "classic" || ids.indexOf(q[1]) !== -1)) {
    if (q[1] === "classic") localStorage.removeItem("aonarr_design");
    else localStorage.setItem("aonarr_design", q[1]);
  }
  var d = localStorage.getItem("aonarr_design");
  if (d && ids.indexOf(d) !== -1) document.documentElement.setAttribute("data-design", d);
} catch (e) {}
