// Runs INSIDE the page (injected with context.addInitScript). Plain ES, no imports, no network.
// Exposes window.__e2e with the DOM measurements the smoke / tab-walk / inventory helpers share, so the
// specs and the judge self-test measure the page with exactly the same code.
(function () {
  if (window.__e2e) return;

  var uidMap = new WeakMap();
  var nextUid = 1;
  function uidOf(el) {
    var id = uidMap.get(el);
    if (!id) {
      id = nextUid++;
      uidMap.set(el, id);
    }
    return id;
  }

  // Natively Tab-reachable controls (plus explicit tabindex >= 0). Role-only widgets without tabindex are
  // NOT here on purpose: they are reported separately as click-only candidates.
  var FOCUSABLE =
    'a[href], area[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), summary, iframe, [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex^="-"])';

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    if (el.closest("[hidden], [inert]")) return false;
    return true;
  }

  function textOf(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function accessibleName(el) {
    var label = el.getAttribute("aria-label");
    if (label && label.trim()) return label.trim().slice(0, 80);
    var by = el.getAttribute("aria-labelledby");
    if (by) {
      var t = by
        .split(/\s+/)
        .map(function (id) {
          var n = document.getElementById(id);
          return n ? textOf(n) : "";
        })
        .join(" ")
        .trim();
      if (t) return t.slice(0, 80);
    }
    if (el.labels && el.labels.length) {
      var lt = Array.prototype.map
        .call(el.labels, function (l) {
          return textOf(l);
        })
        .join(" ")
        .trim();
      if (lt) return lt.slice(0, 80);
    }
    var tag = el.tagName.toLowerCase();
    if (tag === "input" && (el.type === "button" || el.type === "submit" || el.type === "reset") && el.value) return el.value.slice(0, 80);
    var txt = textOf(el);
    if (txt) return txt.slice(0, 80);
    var img = el.querySelector("img[alt], svg title");
    if (img) return (img.getAttribute("alt") || img.textContent || "").trim().slice(0, 80);
    if (el.getAttribute("title")) return el.getAttribute("title").slice(0, 80);
    if (el.getAttribute("placeholder")) return el.getAttribute("placeholder").slice(0, 80);
    if (el.getAttribute("alt")) return el.getAttribute("alt").slice(0, 80);
    return "";
  }

  var INPUT_ROLES = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", range: "slider", number: "spinbutton", search: "searchbox", image: "button", file: "button" };
  function roleOf(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    var tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "area") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") return INPUT_ROLES[el.type] || "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "iframe") return "iframe";
    return "generic";
  }

  function cssPath(el) {
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && node !== document.documentElement && depth < 5; depth++) {
      var tag = node.tagName.toLowerCase();
      if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      var seg = tag;
      var cls = (node.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) seg += "." + cls.map(CSS.escape).join(".");
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (same.length > 1) seg += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(seg);
      node = parent;
    }
    return parts.join(" > ");
  }

  function describe(el) {
    return { uid: uidOf(el), tag: el.tagName.toLowerCase(), role: roleOf(el), name: accessibleName(el), selector: cssPath(el) };
  }

  function interactiveElements() {
    var seenRadio = {};
    return Array.prototype.filter.call(document.querySelectorAll(FOCUSABLE), function (el) {
      if (!isVisible(el)) return false;
      if (el.tagName === "IFRAME") return false;
      // Transient notifications (toasts) are not part of the page's steady-state tab order.
      if (el.closest('[role="status"], [role="alert"], [aria-live]')) return false;
      if (el.tagName === "INPUT" && el.type === "radio") {
        // Native radio groups expose ONE Tab stop (the checked one, else the first).
        var key = (el.form ? "f" : "d") + ":" + el.name;
        if (el.name) {
          if (seenRadio[key]) return false;
          seenRadio[key] = true;
        }
      }
      return true;
    });
  }

  function overflow(max) {
    var de = document.documentElement;
    var iw = window.innerWidth;
    var offenders = [];
    if (de.scrollWidth > iw + 1 || document.body.scrollWidth > iw + 1) {
      var all = document.querySelectorAll("body *");
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.right <= iw + 1) continue;
        // Skip anything clipped by a scroll/overflow container that itself fits in the viewport.
        var clipped = false;
        for (var a = el.parentElement; a && a !== document.body && a !== de; a = a.parentElement) {
          var ox = getComputedStyle(a).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") {
            if (a.getBoundingClientRect().right <= iw + 1) {
              clipped = true;
              break;
            }
          }
        }
        if (clipped) continue;
        var cs = getComputedStyle(el);
        if (cs.position === "fixed" && cs.display === "none") continue;
        offenders.push({ selector: cssPath(el), overshootPx: Math.round(r.right - iw), text: textOf(el).slice(0, 40) });
      }
      offenders.sort(function (x, y) {
        return y.overshootPx - x.overshootPx;
      });
    }
    return {
      innerWidth: iw,
      scrollWidth: de.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflowPx: Math.max(de.scrollWidth, document.body.scrollWidth) - iw,
      offenders: offenders.slice(0, max || 8),
    };
  }

  function inventory() {
    var root = document.getElementById("root") || document.body;
    var seen = {};
    var lines = [];
    String(root.innerText || "")
      .split(/\n+/)
      .forEach(function (l) {
        var t = l.replace(/\s+/g, " ").trim();
        if (t && t.length <= 300 && !seen[t]) {
          seen[t] = 1;
          lines.push(t);
        }
      });
    lines.sort();
    var interactive = interactiveElements().map(function (el) {
      var d = describe(el);
      var href = el.tagName === "A" ? el.getAttribute("href") : null;
      return { role: d.role, name: d.name, href: href && !/^https?:/i.test(href) ? href.split("?")[0] : href };
    });
    var headings = Array.prototype.filter
      .call(root.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]"), isVisible)
      .map(function (h) {
        return { level: h.tagName.toLowerCase(), text: textOf(h).slice(0, 120) };
      });
    function count(sel) {
      return Array.prototype.filter.call(root.querySelectorAll(sel), isVisible).length;
    }
    return {
      url: location.pathname + location.search,
      title: document.title,
      lang: document.documentElement.lang,
      attrs: {
        design: document.documentElement.getAttribute("data-design"),
        theme: document.documentElement.getAttribute("data-theme"),
      },
      landmarks: { main: count("main, [role=main]"), nav: count("nav, [role=navigation]"), header: count("header, [role=banner]") },
      counts: { links: count("a[href]"), buttons: count("button, [role=button]"), inputs: count("input, select, textarea"), images: count("img"), tables: count("table"), rows: count("tr"), headings: headings.length },
      headings: headings,
      interactive: interactive,
      textLines: lines,
    };
  }

  // Styles compared between the focused and the blurred state of the same element.
  function styleSnapshot(el) {
    var s = getComputedStyle(el);
    return {
      outlineStyle: s.outlineStyle,
      outlineWidth: parseFloat(s.outlineWidth) || 0,
      outlineColor: s.outlineColor,
      outlineOffset: s.outlineOffset,
      boxShadow: s.boxShadow,
      borderColor: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor].join("|"),
      borderWidth: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join("|"),
      backgroundColor: s.backgroundColor,
      color: s.color,
      textDecoration: s.textDecorationLine + " " + s.textDecorationColor,
    };
  }

  function alphaOf(color) {
    var m = /rgba?\(([^)]+)\)/.exec(color || "");
    if (!m) return color === "transparent" ? 0 : 1;
    var p = m[1].split(/[ ,/]+/).filter(Boolean);
    return p.length >= 4 ? parseFloat(p[3]) : 1;
  }

  /** Verdict from the focused and blurred snapshots of the same element. */
  function indicatorVerdict(focused, blurred) {
    var outline = focused.outlineStyle !== "none" && focused.outlineWidth > 0 && alphaOf(focused.outlineColor) > 0.05;
    var outlineChanged = outline && (focused.outlineStyle !== blurred.outlineStyle || focused.outlineWidth !== blurred.outlineWidth || focused.outlineColor !== blurred.outlineColor);
    var shadow = focused.boxShadow !== "none" && focused.boxShadow !== blurred.boxShadow;
    var border = focused.borderColor !== blurred.borderColor || focused.borderWidth !== blurred.borderWidth;
    var weak = focused.backgroundColor !== blurred.backgroundColor || focused.textDecoration !== blurred.textDecoration || focused.color !== blurred.color;
    var kinds = [];
    if (outline) kinds.push(outlineChanged ? "outline" : "outline(static)");
    if (shadow) kinds.push("box-shadow");
    if (border) kinds.push("border");
    var strong = outline || shadow || border;
    return { strong: strong, weakOnly: !strong && weak, kinds: kinds.length ? kinds : weak ? ["background/color"] : [] };
  }

  function obscured(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { kind: "zero-size" };
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return { kind: "offscreen" };
    var cx = (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2;
    var cy = (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2;
    var top = document.elementFromPoint(cx, cy);
    if (!top) return { kind: "no-element-at-point" };
    if (el.contains(top) || top.contains(el)) return null;
    var lab = top.closest("label");
    if (lab && lab.control === el) return null;
    var fixed = null;
    for (var n = top; n && n !== document.documentElement; n = n.parentElement) {
      var p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") {
        fixed = n;
        break;
      }
    }
    return { kind: fixed ? "fixed" : "overlap", by: describe(top).selector, fixedBy: fixed ? describe(fixed).selector : null };
  }

  var tab = { prev: null, first: null, seen: {} };
  /** Called after each Tab press. Returns the new active element plus the verdict for the previous one. */
  function tabStep() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var active = document.activeElement;
          var out = { body: !active || active === document.body || active === document.documentElement, current: null, previousVerdict: null };
          if (tab.prev && tab.prev.el.isConnected && (out.body || tab.prev.el !== active)) {
            out.previousVerdict = Object.assign({ uid: tab.prev.uid }, indicatorVerdict(tab.prev.focused, styleSnapshot(tab.prev.el)));
            tab.prev = null;
          } else if (tab.prev && !tab.prev.el.isConnected) {
            out.previousVerdict = { uid: tab.prev.uid, strong: false, weakOnly: false, kinds: [], removed: true };
            tab.prev = null;
          }
          if (!out.body) {
            var d = describe(active);
            var r = active.getBoundingClientRect();
            d.rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
            d.visible = isVisible(active);
            d.positiveTabindex = active.hasAttribute("tabindex") && parseInt(active.getAttribute("tabindex"), 10) > 0;
            d.interactive = interactiveElements().indexOf(active) !== -1;
            d.obscured = obscured(active);
            if (!tab.prev || tab.prev.el !== active) tab.prev = { el: active, uid: d.uid, focused: styleSnapshot(active) };
            out.current = d;
          }
          resolve(out);
        });
      });
    });
  }
  /** After the last Tab: blur the element still focused and return its verdict. */
  function tabFinish() {
    if (!tab.prev) return null;
    var el = tab.prev.el;
    if (document.activeElement === el) el.blur();
    var v = Object.assign({ uid: tab.prev.uid }, indicatorVerdict(tab.prev.focused, styleSnapshot(el)));
    tab.prev = null;
    return v;
  }
  function tabReset() {
    tab = { prev: null, first: null, seen: {} };
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    window.scrollTo(0, 0);
  }

  function clickOnlyCandidates(max) {
    var interactiveAncestor =
      'a[href], button, summary, label, select, input, textarea, [tabindex], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="option"], [role="radio"]';
    var root = document.getElementById("root") || document.body;
    var all = root.querySelectorAll("*");
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest(interactiveAncestor)) continue;
      if (!isVisible(el)) continue;
      var cs = getComputedStyle(el);
      if (cs.cursor !== "pointer" || cs.pointerEvents === "none") continue;
      // Only the outermost element of a clickable group.
      var p = el.parentElement;
      if (p && getComputedStyle(p).cursor === "pointer" && !p.closest(interactiveAncestor)) continue;
      hits.push(el);
    }
    return {
      count: hits.length,
      samples: hits.slice(0, max || 15).map(function (el) {
        return { selector: cssPath(el), text: textOf(el).slice(0, 40) };
      }),
    };
  }

  function positiveTabindexCount() {
    return Array.prototype.filter.call(document.querySelectorAll("[tabindex]"), function (el) {
      return parseInt(el.getAttribute("tabindex"), 10) > 0;
    }).length;
  }

  function loadingLeaves(patternSource) {
    var re = new RegExp(patternSource, "i");
    var root = document.getElementById("root") || document.body;
    var hits = [];
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length > 0 && !(el.children.length === 1 && el.children[0].tagName === "BR")) continue;
      var t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 80 && re.test(t) && isVisible(el)) hits.push(t);
    }
    return hits;
  }

  function domQuiet(quietMs, timeoutMs) {
    return new Promise(function (resolve) {
      var last = performance.now();
      var started = last;
      var obs = new MutationObserver(function () {
        last = performance.now();
      });
      obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      var timer = setInterval(function () {
        var now = performance.now();
        if (now - last >= quietMs) {
          clearInterval(timer);
          obs.disconnect();
          resolve(true);
        } else if (now - started >= timeoutMs) {
          clearInterval(timer);
          obs.disconnect();
          resolve(false);
        }
      }, 50);
    });
  }

  // The app's floating scroll buttons (web/src/components/ScrollButtons.tsx) recompute their state from a 1 s poll plus
  // scroll/resize events, so a page that finished loading shows (or hides) them up to 1 s late and enables/disables each
  // button late too. That made screenshots, text inventories and the Tab-walk differ between runs. Fire the component's own
  // resize listener and wait until the DOM agrees with the page geometry (same formula as the component, 40 px tolerance).
  function scrollButtonsConsistent() {
    var doc = document.documentElement;
    var tol = 40;
    var scrollable = doc.scrollHeight > window.innerHeight + tol;
    var atTop = window.scrollY < tol;
    var atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - tol;
    var box = document.querySelector(".scroll-buttons");
    if (scrollable !== !!box) return false;
    if (!box) return true;
    var btns = box.querySelectorAll("button");
    return btns.length !== 2 || (btns[0].disabled === atTop && btns[1].disabled === atBottom);
  }

  function syncScrollButtons(maxMs) {
    return new Promise(function (resolve) {
      var started = performance.now();
      (function step() {
        window.dispatchEvent(new Event("resize"));
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            if (scrollButtonsConsistent()) resolve(true);
            else if (performance.now() - started >= maxMs) resolve(false);
            else setTimeout(step, 50);
          });
        });
      })();
    });
  }

  // Heuristic "clipped text": a box that hides its overflow (no ellipsis, no line-clamp: those are intentional truncation)
  // while its content is wider/taller than the box. Report-only (smoke record); it never fails a test.
  function clippedText(maxSamples) {
    var root = document.getElementById("root") || document.body;
    var els = root.querySelectorAll("*");
    var count = 0;
    var samples = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var tag = el.tagName;
      if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SVG" || tag === "svg" || tag === "IMG" || tag === "OPTION") continue;
      var cs = getComputedStyle(el);
      var hx = cs.overflowX === "hidden" || cs.overflowX === "clip";
      var hy = cs.overflowY === "hidden" || cs.overflowY === "clip";
      if (!hx && !hy) continue;
      if (cs.textOverflow === "ellipsis") continue;
      if (cs.webkitLineClamp && cs.webkitLineClamp !== "none") continue;
      if (el.clientWidth <= 2 || el.clientHeight <= 2) continue; // visually-hidden helpers
      var cutX = hx && el.scrollWidth > el.clientWidth + 1;
      var cutY = hy && el.scrollHeight > el.clientHeight + 1;
      if (!cutX && !cutY) continue;
      var text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || !isVisible(el)) continue;
      count++;
      if (samples.length < maxSamples) {
        samples.push({ selector: cssPath(el), text: text.slice(0, 80), cutX: cutX, cutY: cutY, scrollW: el.scrollWidth, clientW: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight });
      }
    }
    return { count: count, samples: samples };
  }

  window.__e2e = {
    FOCUSABLE: FOCUSABLE,
    clippedText: clippedText,
    syncScrollButtons: syncScrollButtons,
    isVisible: isVisible,
    describe: describe,
    interactiveCount: function () {
      return interactiveElements().length;
    },
    interactiveList: function () {
      return interactiveElements().map(describe);
    },
    overflow: overflow,
    inventory: inventory,
    tabStep: tabStep,
    tabFinish: tabFinish,
    tabReset: tabReset,
    clickOnlyCandidates: clickOnlyCandidates,
    positiveTabindexCount: positiveTabindexCount,
    loadingLeaves: loadingLeaves,
    domQuiet: domQuiet,
  };
})();
