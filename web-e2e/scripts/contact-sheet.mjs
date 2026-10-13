#!/usr/bin/env node
// Builds .tmp/contact-sheet.html: one row per route, one column per design, with theme (dark/light) and viewport
// (desktop/mobile) selectable. Image paths are RELATIVE to .tmp/ so the folder can be opened from disk.
//   node scripts/contact-sheet.mjs
// Sources: .tmp/captures/<project>/<route>.png (non-Classic and Classic capture-only) and, for Classic's blocking
// routes, the committed baselines baselines/screens/<platform>/<project>/<route>.png (identical to what the sweep compares).
import fs from "node:fs";
import path from "node:path";
import { E2E_DIR, TMP_DIR } from "./_common.mjs";

const DESIGNS = ["classic", "midnight", "aurora", "ember", "noir", "paper", "terminal"];
const THEMES = ["dark", "light"];
const VIEWPORTS = ["desktop", "mobile"];
const platform = process.platform;

const routesSrc = fs.readFileSync(path.join(E2E_DIR, "tests", "routes.ts"), "utf8");
const routes = [...routesSrc.matchAll(/^\s*\{ id: "([a-z0-9-]+)", pattern: "([^"]*)", group: "([^"]*)"/gm)].map((m) => ({ id: m[1], pattern: m[2], group: m[3] }));

const rel = (abs) => path.relative(TMP_DIR, abs).split(path.sep).join("/");
const cells = {}; // key `${design}|${theme}|${viewport}|${route}` -> { img, flags }
let found = 0, missing = 0;
for (const design of DESIGNS) for (const theme of THEMES) for (const viewport of VIEWPORTS) {
  const project = `${design}-${theme}-${viewport}`;
  for (const r of routes) {
    const cap = path.join(TMP_DIR, "captures", project, `${r.id}.png`);
    const base = path.join(E2E_DIR, "baselines", "screens", platform, project, `${r.id}.png`);
    const img = fs.existsSync(cap) ? rel(cap) : fs.existsSync(base) ? rel(base) : null;
    const flags = [];
    const sp = path.join(TMP_DIR, "smoke", project, `${r.id}.json`);
    if (fs.existsSync(sp)) {
      const s = JSON.parse(fs.readFileSync(sp, "utf8"));
      if (s.overflow && s.overflow.scrollWidth > s.overflow.innerWidth) flags.push(`overflow +${s.overflow.overflowPx}px`);
      if (s.violations?.length) flags.push(`${s.violations.length} smoke violation(s)`);
      if (s.clipped?.count) flags.push(`${s.clipped.count} clipped`);
    }
    if (img) found++; else missing++;
    cells[`${design}|${theme}|${viewport}|${r.id}`] = { img, flags };
  }
}

const data = JSON.stringify({ designs: DESIGNS, themes: THEMES, viewports: VIEWPORTS, routes, cells });
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AoNarr redesign contact sheet</title>
<style>
:root{--bg:#f6f7f9;--fg:#15181d;--muted:#5b6370;--card:#fff;--line:#d6dae1;--accent:#1d5fd1;--warn:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8eaee;--muted:#9aa3b2;--card:#171a21;--line:#2a2f3a;--accent:#6ea0ff;--warn:#ff8a7a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:14px;align-items:center}
header h1{font-size:16px;margin:0 8px 0 0}
fieldset{border:1px solid var(--line);border-radius:8px;padding:4px 10px;margin:0;display:flex;gap:10px;align-items:center}
legend{font-size:12px;color:var(--muted);padding:0 4px}
label{display:inline-flex;gap:4px;align-items:center;cursor:pointer}
input[type=range]{width:120px}
.note{color:var(--muted);font-size:12px}
main{padding:8px 16px 40px;overflow-x:auto}
.grid{display:grid;gap:8px;align-items:start}
.hd{position:sticky;top:57px;background:var(--bg);z-index:4;font-weight:600;padding:6px 0;border-bottom:1px solid var(--line)}
.route{font-weight:600;padding-top:4px;word-break:break-all}.route small{display:block;font-weight:400;color:var(--muted)}
.cell{background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden;position:relative}
.cell img{display:block;width:100%;height:auto;object-fit:cover;object-position:top}
.cell .none{padding:20px 6px;color:var(--muted);font-size:12px;text-align:center}
.cell .flag{position:absolute;left:4px;bottom:4px;right:4px;font-size:11px;background:var(--warn);color:#fff;padding:1px 5px;border-radius:4px}
.cell a{color:inherit}
@media (max-width:700px){header{position:static}.hd{top:0}}
</style></head><body>
<header><h1>AoNarr redesign contact sheet</h1>
<fieldset><legend>Theme</legend><label><input type="radio" name="theme" value="dark" checked> dark</label><label><input type="radio" name="theme" value="light"> light</label></fieldset>
<fieldset><legend>Viewport</legend><label><input type="radio" name="vp" value="desktop" checked> desktop 1440</label><label><input type="radio" name="vp" value="mobile"> mobile 390</label></fieldset>
<fieldset><legend>Cell height</legend><input id="h" type="range" min="120" max="1200" step="20" value="360"><span id="hv" class="note">360px</span><label><input id="full" type="checkbox"> full page</label></fieldset>
<fieldset><legend>Designs</legend><span id="dsel"></span></fieldset>
<span class="note">Captures are non-blocking (redesigns) or the Classic baselines. Click an image to open it full size. Red tag = smoke finding on that capture.</span></header>
<main><div id="grid" class="grid"></div></main>
<script>
const D=${data};
const $=s=>document.querySelector(s);
const state={theme:'dark',vp:'desktop',h:360,full:false,designs:new Set(D.designs)};
try{const s=JSON.parse(localStorage.getItem('sheet')||'null');if(s){state.theme=s.theme||state.theme;state.vp=s.vp||state.vp;state.h=s.h||state.h;state.full=!!s.full;}}catch(e){}
function save(){try{localStorage.setItem('sheet',JSON.stringify({theme:state.theme,vp:state.vp,h:state.h,full:state.full}))}catch(e){}}
$('#dsel').innerHTML=D.designs.map(d=>'<label><input type="checkbox" data-d="'+d+'" checked> '+d+'</label>').join(' ');
document.querySelectorAll('[name=theme]').forEach(r=>{r.checked=r.value===state.theme;r.onchange=()=>{state.theme=r.value;save();render()}});
document.querySelectorAll('[name=vp]').forEach(r=>{r.checked=r.value===state.vp;r.onchange=()=>{state.vp=r.value;save();render()}});
$('#h').value=state.h;$('#hv').textContent=state.h+'px';$('#full').checked=state.full;
$('#h').oninput=e=>{state.h=+e.target.value;$('#hv').textContent=state.h+'px';save();applyH()};
$('#full').onchange=e=>{state.full=e.target.checked;save();applyH()};
document.querySelectorAll('[data-d]').forEach(c=>c.onchange=()=>{c.checked?state.designs.add(c.dataset.d):state.designs.delete(c.dataset.d);render()});
function applyH(){document.querySelectorAll('.cell').forEach(c=>{c.style.maxHeight=state.full?'none':state.h+'px'})}
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){const i=e.target;i.src=i.dataset.src;io.unobserve(i)}}),{rootMargin:'600px'});
function render(){
  const ds=D.designs.filter(d=>state.designs.has(d));
  const g=$('#grid');g.innerHTML='';
  g.style.gridTemplateColumns='140px repeat('+ds.length+',minmax('+(state.vp==='mobile'?150:240)+'px,1fr))';
  g.insertAdjacentHTML('beforeend','<div class="hd">route</div>'+ds.map(d=>'<div class="hd">'+d+'</div>').join(''));
  for(const r of D.routes){
    let row='<div class="route">'+r.id+'<small>'+r.pattern+'</small></div>';
    for(const d of ds){
      const c=D.cells[[d,state.theme,state.vp,r.id].join('|')];
      if(!c||!c.img){row+='<div class="cell"><div class="none">no capture</div></div>';continue}
      row+='<div class="cell"><a href="'+c.img+'" target="_blank" rel="noopener"><img alt="'+d+' '+r.id+'" data-src="'+c.img+'"></a>'+(c.flags.length?'<span class="flag">'+c.flags.join(', ')+'</span>':'')+'</div>';
    }
    g.insertAdjacentHTML('beforeend',row);
  }
  g.querySelectorAll('img[data-src]').forEach(i=>io.observe(i));
  applyH();
}
render();
</script></body></html>
`;
const outFile = path.join(TMP_DIR, "contact-sheet.html");
fs.writeFileSync(outFile, html);
console.log(`wrote ${outFile}: ${routes.length} routes x ${DESIGNS.length} designs x 4 variants, ${found} images found, ${missing} missing`);
