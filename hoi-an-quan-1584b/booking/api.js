/* Talks to the booking engine. Published: the Google web app address in config.js. On Jay's Mac (no address, or
   ?local=1): the engine runs right here in the browser, with pretend storage and no real emails (test mode). */
window.BWAPI = (function () {
  "use strict";
  var demo = !!window.BW_DEMO;     // a demo made for one business: runs here in the browser, nothing saved or sent
  var local = demo || !window.BW_API || /[?&]local=1\b/.test(location.search);
  var ready = local ? Promise.all(["core.js", "local.js"].reduce(function (p, src) {
    return p.concat([new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.async = false; s.onload = res; s.onerror = rej; document.head.appendChild(s); })]);
  }, [])) : Promise.resolve();

  function call(action, params) {
    var req = Object.assign({ action: action }, params || {});
    return ready.then(function () {
      if (local) return new Promise(function (res) { setTimeout(function () { res(BW.handle(JSON.parse(JSON.stringify(req)), BWLocal.env())); }, 120); });
      return fetch(window.BW_API, { method: "POST", body: JSON.stringify(req), headers: { "Content-Type": "text/plain;charset=utf-8" } })
        .then(function (r) { return r.json(); });
    }).catch(function () { return { ok: false, error: "Couldn't connect. Check your internet connection and try again." }; });
  }

  function slug() {
    if (demo) return window.BW_DEMO.business.slug;
    var q = new URLSearchParams(location.search).get("b");
    if (q) return q.toLowerCase();
    var m = location.pathname.match(/\/book\/([a-z0-9-]+)\/(?:index\.html|admin\.html)?$/);
    return m ? m[1] : "";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }

  /* The business's look: their colours, fonts and logo (as on their own website). */
  function applyTheme(t) {
    t = t || {};
    var r = document.documentElement.style;
    var lumC = function (hex) { var c = [1, 3, 5].map(function (i) { var v = parseInt(String(hex).substr(i, 2), 16) / 255; return v <= 0.04 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    var ratio = function (a, b) { var x = lumC(a), y = lumC(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    var darker = function (hex) { return "#" + [1, 3, 5].map(function (i) { var v = Math.floor(parseInt(hex.substr(i, 2), 16) * 0.96); return (v < 16 ? "0" : "") + v.toString(16); }).join(""); };
    // the brand colour, darkened just enough for its button text to reach 4.5:1 (WCAG AA; 'Accept' was 4.0:1, 12 Oct 2026)
    var fill = /^#[0-9a-f]{6}$/i.test(t.primary || "") ? t.primary : "#1f2937";
    for (var n = 0; n < 20 && Math.max(ratio(fill, "#ffffff"), ratio(fill, "#111111")) < 4.5; n++) fill = darker(fill);
    t = Object.assign({}, t, { primary: fill });
    r.setProperty("--primary", t.primary || "#1f2937");
    r.setProperty("--text", t.text || "#111827");
    r.setProperty("--bg", t.bg || "#ffffff");
    r.setProperty("--soft", t.soft || "#f4f5f7");
    r.setProperty("--radius", (t.radius != null ? t.radius : 10) + "px");
    r.setProperty("--hfont", "'" + (t.heading_font || "Inter") + "', system-ui, sans-serif");
    r.setProperty("--bfont", "'" + (t.body_font || "Inter") + "', system-ui, sans-serif");
    r.setProperty("--htrans", t.uppercase ? "uppercase" : "none");
    if (t.header) { r.setProperty("--header", t.header); document.documentElement.classList.add("dark-head"); }
    var lum = function (hex) { var c = [1, 3, 5].map(function (i) { var v = parseInt(String(hex).substr(i, 2), 16) / 255; return v <= 0.04 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    r.setProperty("--onp", ratio(t.primary, "#111111") > ratio(t.primary, "#ffffff") ? "#111111" : "#ffffff");    // whichever reads better
    // links and text in the brand colour: darkened until they read at 4.5:1 on the page (Hartlane's red was 4.0:1, 12 Oct 2026)
    var link = t.primary, bg = /^#[0-9a-f]{6}$/i.test(t.bg || "") ? t.bg : "#ffffff";
    if (lumC(bg) > 0.4) for (var m = 0; m < 30 && ratio(link, bg) < 4.5; m++) link = darker(link);
    r.setProperty("--link", link);
    if (lum(t.bg || "#ffffff") < 0.2) document.documentElement.classList.add("dark-ui");
    if (t.header && lum(t.header) > 0.45) document.documentElement.classList.add("light-head");
    var fams = [t.heading_font, t.body_font].filter(function (f, i, a) { return f && f !== "System" && a.indexOf(f) === i && /^[A-Za-z0-9 ]+$/.test(f); });
    if (fams.length) {
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = "https://fonts.googleapis.com/css2?" + fams.map(function (f) { return "family=" + f.replace(/ /g, "+") + ":wght@400;500;600;700;800"; }).join("&") + "&display=swap";
      document.head.appendChild(l);
    }
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = t.primary || "#1f2937";
  }

  function testBanner() {
    if (!local) return;
    var d = document.createElement("div");
    d.className = "test-banner";
    d.innerHTML = demo
      ? "<b>Demo made for " + esc(window.BW_DEMO.business.name) + " by Builds by Walden.</b> Prices, times and bookings are examples. Nothing you do here is saved or sent. <button type=\"button\">See the emails it would send</button>"
      : "<b>Test mode on this computer.</b> Nothing is saved online and no real emails are sent. <button type=\"button\">See the emails it would send</button>";
    document.body.insertBefore(d, document.body.firstChild);
    d.querySelector("button").onclick = function () { ready.then(function () { BWLocal.showMails(); }); };
  }

  return { call: call, slug: slug, esc: esc, applyTheme: applyTheme, local: local, demo: demo, ready: ready, testBanner: testBanner };
})();
