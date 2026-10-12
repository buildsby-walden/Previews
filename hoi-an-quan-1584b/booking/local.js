/* Test mode on Jay's Mac: the engine with pretend storage in this browser, and emails kept here to look at instead of
   being sent. Starts with one example business so there's something to try. Never used once it's published. */
window.BWLocal = (function () {
  "use strict";
  var DEMO = window.BW_DEMO || null;
  // a business's demo keeps its state for this visit only (sessionStorage); Jay's test mode keeps it on this computer
  var KEY = DEMO ? "bw-demo-" + DEMO.business.slug + "-" + (DEMO.version || 1) : "bw-local-v1";
  var box = (function () { try { var s = DEMO ? window.sessionStorage : window.localStorage; s.setItem("bw-t", "1"); return s; } catch (e) { return null; } })();
  var mem = {};

  function load() {
    try { return JSON.parse(box ? box.getItem(KEY) : mem[KEY]) || null; } catch (e) { return null; }
  }
  function save(d) { try { var s = JSON.stringify(d); if (box) box.setItem(KEY, s); else mem[KEY] = s; } catch (e) {} }
  var data = load() || { biz: [], bk: [], mails: [] };

  function rand(n) {
    var a = new Uint8Array(n), s = "";
    crypto.getRandomValues(a);
    for (var i = 0; i < n; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[a[i] % 36];
    return s;
  }
  function hash(s) {   // test mode only: not a secure hash (Google uses SHA-256 for real)
    var h1 = 5381, h2 = 52711;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; }
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  }
  function now() {
    var d = new Date();
    var o = {};
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return { date: o.year + "-" + o.month + "-" + o.day, min: +o.hour * 60 + +o.minute, ms: d.getTime() };
  }
  var copy = function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); };
  var base = location.href.replace(/[?#].*$/, "").replace(/[^/]*$/, "");

  function env() {
    return {
      db: {
        getBusiness: function (k) { return copy(data.biz.filter(function (b) { return b.slug === k || b.id === k; })[0] || null); },
        saveBusiness: function (b) { data.biz = data.biz.filter(function (x) { return x.id !== b.id; }).concat([copy(b)]); save(data); },
        listBusinesses: function () { return copy(data.biz); },
        bookings: function (id) { return copy(data.bk.filter(function (x) { return x.business === id; })); },
        saveBooking: function (x) { data.bk = data.bk.filter(function (y) { return y.id !== x.id; }).concat([copy(x)]); save(data); }
      },
      now: now, id: rand, hash: hash, hmac: function (s) { return hash("local-secret:" + s); },
      mail: function (m) { data.mails.unshift(Object.assign({ at: new Date().toLocaleString("en-GB") }, m)); data.mails = data.mails.slice(0, 30); save(data); },
      links: { book: base + "index.html", admin: base + "admin.html" },
      adminKey: "local", log: function (s) { console.log(s); }
    };
  }

  // a business's demo: their set-up, plus a few example bookings in the coming days so the owner's diary isn't empty
  if (DEMO && !data.biz.length) {
    var b = JSON.parse(JSON.stringify(DEMO.business));
    b.id = b.id || "demo"; b.status = "active"; b.questions = BW.cleanQuestions(b.questions || []); b.words = BW.cleanWords(b.words); b.settings = Object.assign({}, BW.DEFAULT_SETTINGS, b.settings); b.pin = null; b.setup_code = rand(20); b.setup_expires = BW.addDays(now().date, 30); b.time_off = [];
    data.biz = [b]; save(data);
    var n = now();
    (DEMO.samples || []).forEach(function (s, i) {
      var svc = b.services[s.service % b.services.length], date = BW.addDays(n.date, s.day);
      var party = b.mode === "tables" ? (s.party || 2) : "";
      var who = s.staff != null && (b.staff || []).length ? b.staff[s.staff % b.staff.length] : null;
      var free = BW.freeTimes(b, data.bk, svc, date, n, { owner: true, party: party || 2, staff: who ? who.id : undefined });
      if (!free.length) return;
      var start = free[Math.min(free.length - 1, Math.floor(free.length * (s.at || 0.3)))];
      var weeks = Math.max(1, s.weeks || 1), series = weeks > 1 ? "exs" + i : "";
      for (var w = 0; w < weeks; w++) {      // an example weekly booking: the same time for a few weeks
        data.bk.push({ id: "ex" + i + (w ? "w" + w : ""), business: b.id, date: BW.addDays(date, 7 * w), start: start, minutes: svc.minutes, service: svc.name, service_id: svc.id,
                       name: s.name, phone: "07700 900" + (100 + i * 37), email: "", note: s.note || "", status: s.status || "confirmed", source: s.source || "online",
                       created: new Date().toISOString(), cancel_token: rand(24), updated: "", party: party, answers: s.answers || [],
                       staff: who ? who.id : "", staff_name: who ? who.name : "", series: series });
      }
    });
    save(data);
  }

  // Jay's test mode: one example business to try, styled like Hartlane's own website (white, Poppins, bold capitals, their red)
  if (!DEMO && !data.biz.length) {
    var ev = env();
    var made = BW.handle({ action: "j_create", key: "local", business: {
      name: "Hartlane School of Motoring", slug: "hartlane", owner_email: "owner@example.com", phone: "01582 000000", address: "147 Hart Ln, Luton LU2 0JG",
      website: "https://www.hartlanedrivingschool.co.uk/",
      services: [{ name: "Driving lesson (manual)", minutes: 60, price: "£36" }, { name: "Driving lesson (automatic)", minutes: 60, price: "£38" },
                 { name: "Two-hour lesson", minutes: 120, price: "£70" }, { name: "Mock test", minutes: 60, price: "£40" }],
      hours: { mon: [["08:00", "20:00"]], tue: [["08:00", "20:00"]], wed: [["08:00", "20:00"]], thu: [["08:00", "20:00"]], fri: [["08:00", "20:00"]], sat: [["08:00", "20:00"]], sun: [["08:00", "20:00"]] },
      settings: { step: 60, notice_hours: 12, days_ahead: 28, buffer: 0, cancel_hours: 24, note: "" },
      theme: { primary: "#e30613", text: "#111111", bg: "#ffffff", soft: "#f3f3f3", heading_font: "Poppins", body_font: "Poppins", uppercase: true, radius: 6, header: "#141414", logo: "test/hartlane-logo.png" }
    } }, ev);
    data = load();
    data.setup_code = made.setup_code;
    save(data);
  }

  function showMails() {
    var box = document.createElement("div");
    box.className = "mail-view";
    box.innerHTML = '<div class="mail-card"><div class="mail-top"><b>Emails it would have sent</b><button type="button" class="x">Close</button></div>' +
      (data.mails.length ? data.mails.map(function (m) {
        return '<details><summary><b>' + BWAPI.esc(m.subject) + '</b><br><small>To ' + BWAPI.esc(m.to) + " from \"" + BWAPI.esc(m.name) + "\" · " + BWAPI.esc(m.at) + "</small></summary>" +
          '<div class="mail-body">' + m.html + "</div></details>";
      }).join("") : "<p>None yet.</p>") +
      (DEMO ? "" : '<p class="muted small">Set-up link for the example business: <a href="admin.html?b=hartlane&setup=' + (data.setup_code || "") + '">choose a PIN</a></p>') +
      '<button type="button" class="reset">' + (DEMO ? "Start the demo again" : "Start the test again from scratch") + "</button></div>";
    document.body.appendChild(box);
    box.querySelector(".x").onclick = function () { box.remove(); };
    box.querySelector(".reset").onclick = function () { reset(); location.reload(); };
  }
  function reset() { try { if (box) box.removeItem(KEY); delete mem[KEY]; } catch (e) {} }

  /* The demo's owner page opens already signed in: a PIN is chosen for this visit behind the scenes. */
  function demoSignIn() {
    var b = data.biz[0];
    if (!data.demoPin) {
      var pin = "";
      while (!/^\d{6}$/.test(pin) || /^(\d)\1+$/.test(pin) || "0123456789".indexOf(pin) >= 0 || "9876543210".indexOf(pin) >= 0) pin = String(100000 + Math.floor(Math.random() * 900000));
      var r = BW.handle({ action: "setup", b: b.slug, code: b.setup_code, pin: pin }, env());
      data = load(); data.demoPin = pin; save(data);
      return r.token;
    }
    return BW.handle({ action: "login", b: b.slug, pin: data.demoPin }, env()).token;
  }

  return { env: env, showMails: showMails, demoSignIn: demoSignIn, reset: reset, data: function () { return data; } };
})();
