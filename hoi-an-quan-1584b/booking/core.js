/* Builds by Walden Bookings: the booking engine (10 Oct 2026).

A simple booking system Jay sells to one-person businesses (a barber, a beautician, a driving instructor...). The
business runs it themselves from a page on their phone: their services, hours, days off and bookings. Customers book
from a page styled like the business's own website. Emails go to both.

This file is the whole engine and nothing else: no Google, no browser. It runs in three places:
  - Google Apps Script (gas.js wraps it: Sheets for storage, Gmail for emails)   <- the real thing
  - the browser in local test mode (app/local.js: storage in the browser)          <- trying it on Jay's Mac
  - macOS JavaScript for the tests (tests/run.sh)
Everything it needs from outside comes in through `env` (see handle()).

Times: every business is in the UK, so all times are UK local time, kept as a date 'YYYY-MM-DD' plus minutes after
midnight (570 = 9:30). Never Date objects for slot maths: the server and Jay's Mac are in other time zones.
*/
var BW = (function () {
  "use strict";

  var DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DEFAULT_SETTINGS = {
    step: 30,            // minutes between start times offered
    notice_hours: 2,     // can't book less than this far ahead
    days_ahead: 28,      // can't book further ahead than this
    buffer: 0,           // minutes kept free between bookings
    cancel_hours: 24,    // customers can cancel online up to this long before
    note: "",            // shown to customers on the booking page and in their email
    pick_staff: true,    // with more than one person (instructors, stylists): customers can choose who, or 'anyone'
    repeat_max: 0,       // weekly repeat bookings allowed, up to this many weeks (driving lessons: 'same time every week'); 0 = off
    approve: false,      // online bookings arrive as requests the owner accepts or declines (driving schools, 12 Oct 2026)
    seats: 30,           // tables mode: how many people they take bookings for at the same time
    max_party: 8,        // tables mode: the biggest group that can book online (bigger groups phone)
    notify_owner: true   // email the owner about each new booking and cancellation
  };
  var MUTATING = { book: 1, cancel: 1, setup: 1, login: 1, save: 1, add: 1, move: 1, ocancel: 1, timeoff_add: 1,
                   timeoff_del: 1, accept: 1, decline: 1, pin_change: 1, j_create: 1, j_code: 1, j_update: 1 };
  var TOKEN_DAYS = 30;
  var SETUP_DAYS = 30;
  var MAX_FAILS = 5, LOCK_MINUTES = 15;

  // ------------------------------------------------------------ errors
  function Err(message, extra) {
    var e = new Error(message);
    e.bw = true;
    if (extra) { for (var k in extra) e[k] = extra[k]; }
    return e;
  }

  // ------------------------------------------------------------ dates (UK local, no time zones)
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function dayMs(s) {
    var p = String(s).split("-");
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(dayMs(s)) && fmtDay(dayMs(s)) === s; }
  function fmtDay(ms) { var d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function addDays(s, n) { return fmtDay(dayMs(s) + n * 86400000); }
  function weekday(s) { return new Date(dayMs(s)).getUTCDay(); }
  function dayDiff(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
  function hm(min) { min = Math.round(min); return pad(Math.floor(min / 60)) + ":" + pad(min % 60); }
  function parseHM(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    var v = +m[1] * 60 + +m[2];
    return (+m[2] < 60 && v <= 1440) ? v : null;
  }
  function niceTime(min) {   // 9:30am, 2pm, 12 noon
    var h = Math.floor(min / 60), m = min % 60;
    if (h === 12 && m === 0) return "12 noon";
    var ap = h >= 12 && h < 24 ? "pm" : "am", h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (m ? ":" + pad(m) : "") + ap;
  }
  function niceDate(s) {     // Tuesday 14 October 2026
    var d = new Date(dayMs(s));
    return DAY_NAMES[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }
  function niceLength(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + (h === 1 ? " hour" : " hours") : "") + (h && m ? " " : "") + (m ? m + " mins" : "");
  }

  // ------------------------------------------------------------ cleaning what people type
  function clean(s, max) {
    return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, max || 200);
  }
  function cleanEmail(s) {
    s = clean(s, 120).toLowerCase();
    return /^[^@\s<>"]+@[^@\s<>"]+\.[a-z]{2,}$/.test(s) ? s : "";
  }
  function cleanPhone(s) {
    s = clean(s, 30);
    var digits = s.replace(/[^\d]/g, "");
    return digits.length >= 10 && digits.length <= 14 && /^[\d\s()+-]+$/.test(s) ? s : "";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function slugify(s) {
    return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "business";
  }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  // ------------------------------------------------------------ a business's set-up
  function cleanServices(list, env) {
    if (!Array.isArray(list)) throw Err("Services should be a list.");
    var out = [];
    list.slice(0, 100).forEach(function (s) {     // a full salon price list runs to 60+ (Franclin's)
      var name = clean(s && s.name, 60);
      if (!name) return;
      var minutes = Math.round(+s.minutes);
      if (!(minutes >= 5 && minutes <= 720)) throw Err("'" + name + "' needs a length between 5 minutes and 12 hours.");
      var o = { id: clean(s.id, 20) || env.id(8), name: name, minutes: minutes, price: clean(s.price, 20),
                desc: clean(s.desc, 160), active: s.active !== false };
      if (clean(s.section, 40)) o.section = clean(s.section, 40);     // their own heading: 'Technical services'
      if (s.est) o.est = true;                                          // a usual length, not one they gave
      if (s.levels && typeof s.levels === "object") {                  // a price for each stylist level: {'Senior': '£27'}
        var lv = {}, n = 0;
        Object.keys(s.levels).slice(0, 8).forEach(function (k) { var key = clean(k, 30), v = clean(s.levels[k], 20); if (key && v) { lv[key] = v; n++; } });
        if (n >= 2) o.levels = lv;
      }
      out.push(o);
    });
    if (!out.some(function (s) { return s.active; })) throw Err("Add at least one service customers can book.");
    return out;
  }

  function cleanHours(h) {
    var out = {};
    DAYS.forEach(function (d) {
      var ranges = (h && h[d]) || [];
      if (!Array.isArray(ranges)) throw Err("Opening hours aren't in the right shape.");
      var list = [];
      ranges.slice(0, 4).forEach(function (r) {
        var a = parseHM(r && r[0]), b = parseHM(r && r[1]);
        if (a == null || b == null) throw Err("Times should look like 09:00.");
        if (b <= a) throw Err("On " + DAY_NAMES[DAYS.indexOf(d)] + ", the closing time must be after the opening time.");
        list.push([hm(a), hm(b)]);
      });
      list.sort(function (x, y) { return parseHM(x[0]) - parseHM(y[0]); });
      out[d] = list;
    });
    return out;
  }

  function cleanSettings(s) {
    var out = copy(DEFAULT_SETTINGS);
    s = s || {};
    var num = function (k, lo, hi) {
      if (s[k] == null || s[k] === "") return;
      var v = Math.round(+s[k]);
      if (!(v >= lo && v <= hi)) throw Err("'" + k.replace(/_/g, " ") + "' should be between " + lo + " and " + hi + ".");
      out[k] = v;
    };
    num("step", 5, 240); num("notice_hours", 0, 336); num("days_ahead", 1, 365); num("buffer", 0, 120); num("cancel_hours", 0, 336);
    num("seats", 1, 1000); num("max_party", 1, 100); num("repeat_max", 0, 26);
    if (s.pick_staff != null) out.pick_staff = !!s.pick_staff;
    if (s.note != null) out.note = clean(s.note, 400);
    if (s.notify_owner != null) out.notify_owner = !!s.notify_owner;
    if (s.approve != null) out.approve = !!s.approve;
    return out;
  }

  function cleanTheme(t) {
    t = t || {};
    var col = function (v, d) { return /^#[0-9a-fA-F]{6}$/.test(v || "") ? v : d; };
    var font = function (v, d) { v = clean(v, 40); return /^[A-Za-z0-9 ]+$/.test(v) ? v : d; };
    return {
      primary: col(t.primary, "#1f2937"), text: col(t.text, "#111827"), bg: col(t.bg, "#ffffff"), soft: col(t.soft, "#f4f5f7"),
      header: col(t.header, ""),   // a coloured top bar, for logos with white in them
      heading_font: font(t.heading_font, "Inter"), body_font: font(t.body_font, "Inter"),
      uppercase: !!t.uppercase, radius: Math.max(0, Math.min(24, Math.round(+t.radius || 10))),
      logo: /^(https:\/\/[^\s"'<>]+|[a-z0-9_-][a-z0-9._\/-]*\.(png|jpe?g|webp|svg))$/i.test(t.logo || "") && String(t.logo).indexOf("..") < 0 ? t.logo : ""
    };
  }

  /* The wording on the booking page, set for their trade ('Choose your lesson', 'Your dog's name and breed'). */
  function cleanWords(w) {
    w = w || {};
    return { title: clean(w.title, 40) || "Book online", pick: clean(w.pick, 40) || "Choose what you'd like",
             note_q: clean(w.note_q, 60) || "Anything we should know?", note_hint: clean(w.note_hint, 120),
             gap: clean(w.gap, 40) || "Gap between bookings",
             staff: clean(w.staff, 30) || "team member", staff_q: clean(w.staff_q, 40) || "Who would you like?",
             staff_any: clean(w.staff_any, 40) || "Anyone available" };   // 'Travel time between lessons' for a driving instructor
  }

  /* Extra questions for their trade, asked when someone books ('Where should we pick you up?', 'Your dog's name and
     size'). Up to 6; each is free text or a choice from a short list. Answers are kept with the booking (12 Oct 2026). */
  function cleanQuestions(list) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw Err("Questions should be a list.");
    var out = [], seen = {};
    list.slice(0, 6).forEach(function (q) {
      var label = clean(q && q.label, 60);
      if (!label) return;
      var id = slugify(q.id || label).slice(0, 24).replace(/-+$/, "");
      while (seen[id]) id += "x";
      seen[id] = 1;
      var options = Array.isArray(q.options) ? q.options.map(function (o) { return clean(o, 40); }).filter(Boolean).slice(0, 8) : [];
      out.push({ id: id, label: label, kind: q.kind === "choice" && options.length >= 2 ? "choice" : "text", options: q.kind === "choice" && options.length >= 2 ? options : [],
                 required: !!q.required, hint: clean(q.hint, 80) });
    });
    return out;
  }

  /* The people bookings are with (driving instructors, stylists), 12 Oct 2026. Each has their own diary: one being
     booked doesn't block the others. With nobody listed, the business is one diary, as before. Bookings made before
     anyone was listed (no 'staff') block everyone, so nothing old is double-booked. */
  function cleanStaff(list, env, old) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw Err("The team should be a list.");
    var out = [], seen = {};
    list.slice(0, 20).forEach(function (s) {
      var name = clean(s && s.name, 40);
      if (!name || seen[name.toLowerCase()]) return;
      seen[name.toLowerCase()] = 1;
      var p = { id: clean(s.id, 20) || env.id(8), name: name, active: s.active !== false };
      if (clean(s.role, 40)) p.role = clean(s.role, 40);     // 'Senior Stylist', as their own team page says
      if (clean(s.level, 30)) p.level = clean(s.level, 30);  // which column of their price list they charge
      if (s.hours) p.hours = cleanHours(s.hours);     // their own working hours; none = the business's hours
      out.push(p);
    });
    return out;
  }
  function hoursFor(b, staffId) {
    var p = staffId ? (b.staff || []).filter(function (x) { return x.id === staffId; })[0] : null;
    return (p && p.hours) || b.hours;
  }
  function team(b) { return tables(b) ? [] : (b.staff || []).filter(function (s) { return s.active !== false; }); }
  function staffById(b, id) { return (b.staff || []).filter(function (s) { return s.id === id; })[0] || null; }
  function mineFor(x, staffId) { return !staffId || !x.staff || x.staff === staffId; }

  /* a booking that takes up its time: confirmed, or a request waiting for the owner (the time is held for it) */
  function holds(x) { return x.status === "confirmed" || x.status === "requested"; }

  function cleanAnswers(b, given) {
    given = given || {};
    var out = [];
    (b.questions || []).forEach(function (q) {
      var v = clean(given[q.id], 160);
      if (q.kind === "choice" && v && q.options.indexOf(v) < 0) v = "";
      if (!v && q.required) throw Err("Please answer: " + q.label);
      if (v) out.push({ q: q.label, a: v });
    });
    return out;
  }

  function publicView(b) {
    return {
      slug: b.slug, name: b.name, phone: b.phone || "", address: b.address || "", website: b.website || "",
      services: b.services.filter(function (s) { return s.active; }).map(function (s) {
        return { id: s.id, name: s.name, minutes: s.minutes, price: s.price, desc: s.desc, section: s.section || "", est: !!s.est, levels: s.levels || null };
      }),
      settings: { days_ahead: b.settings.days_ahead, cancel_hours: b.settings.cancel_hours, note: b.settings.note, notice_hours: b.settings.notice_hours,
                  max_party: b.settings.max_party, approve: !!b.settings.approve, pick_staff: b.settings.pick_staff !== false, repeat_max: b.settings.repeat_max || 0 },
      staff: team(b).map(function (s) { return { id: s.id, name: s.name, role: s.role || "", level: s.level || "" }; }), staff_note: clean(b.staff_note, 160),
      menu_url: /^https:\/\//.test(b.menu_url || "") ? clean(b.menu_url, 300) : "",
      questions: b.questions || [],
      mode: tables(b) ? "tables" : "appointments",
      theme: b.theme, words: cleanWords(b.words), open: b.status === "active"
    };
  }

  function ownerView(b) {
    var v = copy(b);
    delete v.pin; delete v.setup_code; delete v.setup_expires; delete v.fails; delete v.lock_until;
    v.has_pin = !!(b.pin && b.pin.hash);
    return v;
  }

  // ------------------------------------------------------------ free times
  /* Restaurants and cafés book tables, not appointments: several groups at once, up to the seats they take bookings
     for (Hoi An Quan, 10 Oct 2026). A time is free when the people already booked during that sitting, plus this
     party, still fit. */
  function tables(b) { return b.mode === "tables"; }

  function seatsTaken(bookings, date, start, minutes, ignoreId) {
    var most = 0;
    // the busiest moment during this sitting: check at each booking that starts inside it, and at its start
    var points = [start];
    bookings.forEach(function (x) { if (holds(x) && x.date === date && x.start > start && x.start < start + minutes) points.push(x.start); });
    points.forEach(function (p) {
      var n = 0;
      bookings.forEach(function (x) {
        if (holds(x) && x.date === date && x.id !== ignoreId && x.start <= p && x.start + x.minutes > p) n += (+x.party || 2);
      });
      most = Math.max(most, n);
    });
    return most;
  }

  function busyFor(b, bookings, date, ignoreId, staffId) {
    var buf = b.settings.buffer || 0, out = [];
    bookings.forEach(function (x) {
      if (holds(x) && x.date === date && x.id !== ignoreId && mineFor(x, staffId)) out.push([x.start - buf, x.start + x.minutes + buf]);
    });
    (b.time_off || []).forEach(function (t) {
      if (t.date !== date || !mineFor(t, staffId)) return;
      out.push(t.all_day ? [0, 1440] : [parseHM(t.from), parseHM(t.to)]);
    });
    return out;
  }

  /* Start times (minutes) a customer could book for a service on a date. opts.owner skips the notice and how-far-ahead
     rules (the owner can book anyone in); opts.ignore leaves one booking out (when moving it). */
  function freeTimes(b, bookings, svc, date, now, opts) {
    opts = opts || {};
    var people = team(b);
    if (people.length && !opts._one) {
      // one person's diary, or 'anyone': a time is free when at least one of them is free
      var who = opts.staff && opts.staff !== "any" ? people.filter(function (p) { return p.id === opts.staff; }) : people;
      var all = {};
      who.forEach(function (p) {
        freeTimes(b, bookings, svc, date, now, Object.assign({}, opts, { staff: p.id, _one: true })).forEach(function (t) { all[t] = 1; });
      });
      return Object.keys(all).map(Number).sort(function (x, y) { return x - y; });
    }
    var s = b.settings, dur = svc.minutes, step = s.step || 30;
    var dd = dayDiff(now.date, date);
    if (dd < 0) return [];
    if (!opts.owner && dd > s.days_ahead) return [];
    var earliest = opts.owner ? now.min : now.min + s.notice_hours * 60;   // in minutes from the start of today
    var busy = tables(b) ? busyFor(b, [], date) : busyFor(b, bookings, date, opts.ignore, opts.staff);   // tables: only time off blocks a time outright
    var party = Math.max(1, +opts.party || 2);
    var out = [];
    (hoursFor(b, opts.staff)[DAYS[weekday(date)]] || []).forEach(function (r) {
      var a = parseHM(r[0]), e = parseHM(r[1]);
      // a table can be booked up to an hour before closing, even if the sitting runs past it
      var last = tables(b) ? e - Math.min(dur, 60) : e - dur;
      for (var t = a; t <= last; t += step) {
        if (dd * 1440 + t < earliest) continue;
        var clash = busy.some(function (x) { return t < x[1] && t + dur > x[0]; });
        if (clash) continue;
        if (tables(b) && seatsTaken(bookings, date, t, dur, opts.ignore) + party > b.settings.seats) continue;
        out.push(t);
      }
    });
    return out;
  }

  function clashes(b, bookings, date, start, minutes, ignoreId, staffId) {
    var hits = [];
    bookings.forEach(function (x) {
      if (holds(x) && x.date === date && x.id !== ignoreId && mineFor(x, staffId) && start < x.start + x.minutes && start + minutes > x.start) hits.push(x);
    });
    (b.time_off || []).forEach(function (t) {
      if (t.date !== date || !mineFor(t, staffId)) return;
      var a = t.all_day ? 0 : parseHM(t.from), e = t.all_day ? 1440 : parseHM(t.to);
      if (start < e && start + minutes > a) hits.push({ time_off: true, reason: t.reason || "Time off" });
    });
    return hits;
  }

  function withinHours(b, date, start, minutes, staffId) {
    return (hoursFor(b, staffId)[DAYS[weekday(date)]] || []).some(function (r) { return start >= parseHM(r[0]) && start + minutes <= parseHM(r[1]); });
  }

  // ------------------------------------------------------------ owner sign-in
  function makeToken(b, env, now) {
    var exp = (now.ms + TOKEN_DAYS * 86400000).toString(36);
    var body = b.id + "." + exp;
    return body + "." + env.hmac(body + "." + ((b.pin && b.pin.v) || 0));
  }

  function checkToken(b, token, env, now) {
    var p = String(token || "").split(".");
    p = [p[0], p[1], p.slice(2).join(".")];
    if (!p[1] || !p[2] || p[0] !== b.id) throw Err("Please sign in again.", { signin: true });
    if (parseInt(p[1], 36) < now.ms) throw Err("You've been signed out. Please sign in again.", { signin: true });
    if (env.hmac(p[0] + "." + p[1] + "." + ((b.pin && b.pin.v) || 0)) !== p[2]) throw Err("Please sign in again.", { signin: true });
  }

  function checkPinRules(pin) {
    pin = String(pin || "");
    if (!/^\d{6,10}$/.test(pin)) throw Err("Your PIN should be 6 to 10 numbers.");
    if (/^(\d)\1+$/.test(pin) || "01234567890".indexOf(pin) >= 0 || "09876543210".indexOf(pin) >= 0) throw Err("That PIN is too easy to guess. Try a different one.");
    return pin;
  }

  function setPin(b, pin, env) {
    var salt = env.id(16);
    b.pin = { salt: salt, hash: env.hash(salt + ":" + pin), v: ((b.pin && b.pin.v) || 0) + 1 };
  }

  // ------------------------------------------------------------ emails
  function what(b, x) { return tables(b) && x.party ? "Table for " + x.party : x.service; }

  function bookingLine(b, x) {
    if (tables(b) && x.party) return "Table for " + esc(x.party) + "<br>" + esc(niceDate(x.date)) + " at " + esc(niceTime(x.start));
    var line = esc(x.service) + (x.staff_name ? " with " + esc(x.staff_name) : "") + "<br>" + esc(niceDate(x.date)) + " at " + esc(niceTime(x.start)) + " (" + esc(niceLength(x.minutes)) + ")";
    if (x.series_dates && x.series_dates.length > 1)      // a weekly booking: every date in it
      line += "<br><br>Every week, " + x.series_dates.length + " times:<br>" + x.series_dates.map(function (d) { return esc(niceDate(d)); }).join("<br>");
    return line;
  }

  function calLink(b, x) {
    var p = x.date.split("-");
    // Google Calendar takes UK local time with ctz
    var st = p.join("") + "T" + hm(x.start).replace(":", "") + "00", en = p.join("") + "T" + hm(Math.min(x.start + x.minutes, 1439)).replace(":", "") + "00";
    return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(what(b, x) + " at " + b.name) +
      "&dates=" + st + "/" + en + "&ctz=Europe/London" + (b.address ? "&location=" + encodeURIComponent(b.address) : "");
  }

  function wrapEmail(b, body) {
    var c = b.theme.primary;
    return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2430;line-height:1.5">' +
      '<div style="border-top:4px solid ' + c + ';padding:20px 4px">' + body + "</div>" +
      '<p style="font-size:12px;color:#8a8f99;padding:0 4px">Booking system for ' + esc(b.name) + " by Builds by Walden.</p></div>";
  }

  function customerEmail(b, x, env, kind) {
    var link = env.links.book + "?b=" + encodeURIComponent(b.slug) + "&cancel=" + encodeURIComponent(x.id) + "&t=" + encodeURIComponent(x.cancel_token);
    var contact = [b.phone ? "Phone " + esc(b.phone) : "", b.address ? esc(b.address) : ""].filter(Boolean).join("<br>");
    var subject, body;
    var extra = (x.answers || []).length ? '<p style="font-size:14px;color:#555">' + x.answers.map(function (a) { return esc(a.q) + ": <b>" + esc(a.a) + "</b>"; }).join("<br>") + "</p>" : "";
    if (kind === "requested") {
      subject = "Request received: " + what(b, x) + " on " + niceDate(x.date) + " at " + niceTime(x.start);
      body = "<h2 style=\"margin:0 0 12px\">We've got your request</h2><p>Hi " + esc(x.name.split(" ")[0]) + ",</p>" +
        "<p>Thanks for your request to " + esc(b.name) + ". It isn't confirmed yet: they'll check it and you'll get another email when they do.</p>" +
        '<p style="background:#f4f5f7;padding:12px 14px;border-radius:8px;font-size:16px">' + bookingLine(b, x) + "</p>" + extra +
        "<p>Changed your mind? " + '<a href="' + esc(link) + '">Cancel this request</a>' + (b.phone ? ", or call " + esc(b.phone) : "") + ".</p>" + (contact ? "<p>" + contact + "</p>" : "");
    } else if (kind === "declined") {
      subject = "Not available: " + what(b, x) + " on " + niceDate(x.date);
      body = "<h2 style=\"margin:0 0 12px\">Sorry, that time doesn't work</h2><p>Hi " + esc(x.name.split(" ")[0]) + ",</p><p>" + esc(b.name) + " can't do this one:</p>" +
        '<p style="background:#f4f5f7;padding:12px 14px;border-radius:8px">' + bookingLine(b, x) + "</p>" + (x.reply ? "<p>" + esc(x.reply) + "</p>" : "") +
        '<p><a href="' + esc(env.links.book + "?b=" + encodeURIComponent(b.slug)) + '">Pick another time</a></p>' + (contact ? "<p>" + contact + "</p>" : "");
    } else if (kind === "cancelled") {
      subject = "Cancelled: " + what(b, x) + " on " + niceDate(x.date);
      body = "<h2 style=\"margin:0 0 12px\">Your booking is cancelled</h2><p>Hi " + esc(x.name.split(" ")[0]) + ",</p><p>This booking with " + esc(b.name) + " is cancelled:</p>" +
        '<p style="background:#f4f5f7;padding:12px 14px;border-radius:8px">' + bookingLine(b, x) + "</p>" +
        '<p><a href="' + esc(env.links.book + "?b=" + encodeURIComponent(b.slug)) + '">Book another time</a></p>' + (contact ? "<p>" + contact + "</p>" : "");
    } else {
      subject = (kind === "moved" ? "Changed: " : "Booked: ") + what(b, x) + " on " + niceDate(x.date) + " at " + niceTime(x.start);
      body = "<h2 style=\"margin:0 0 12px\">" + (kind === "moved" ? "Your booking has changed" : "You're booked in") + "</h2><p>Hi " + esc(x.name.split(" ")[0]) + ",</p>" +
        "<p>" + (kind === "moved" ? "Your booking with " + esc(b.name) + " is now:" : "Thanks for booking with " + esc(b.name) + ".") + "</p>" +
        '<p style="background:#f4f5f7;padding:12px 14px;border-radius:8px;font-size:16px">' + bookingLine(b, x) + "</p>" + extra +
        (b.settings.note ? "<p>" + esc(b.settings.note) + "</p>" : "") +
        '<p><a href="' + esc(calLink(b, x)) + '">Add it to your calendar</a></p>' +
        "<p>Can't make it? " + (b.settings.cancel_hours ? "You can cancel online up to " + esc(niceLength(b.settings.cancel_hours * 60)) + " before: " : "You can cancel online: ") +
        '<a href="' + esc(link) + '">cancel this booking</a>' + (b.phone ? ", or call " + esc(b.phone) : "") + ".</p>" + (contact ? "<p>" + contact + "</p>" : "");
    }
    return { to: x.email, subject: subject, html: wrapEmail(b, body), name: b.name, replyTo: b.owner_email || "" };
  }

  function ownerEmail(b, x, env, kind) {
    var manage = env.links.admin + "?b=" + encodeURIComponent(b.slug);
    var who = esc(x.name) + (x.phone ? '<br><a href="tel:' + esc(x.phone.replace(/[^\d+]/g, "")) + '">' + esc(x.phone) + "</a>" : "") +
      (x.email ? '<br><a href="mailto:' + esc(x.email) + '">' + esc(x.email) + "</a>" : "");
    var title = kind === "cancelled" ? "Booking cancelled by the customer" : kind === "requested" ? "New booking request: please accept or decline" : "New booking";
    var body = "<h2 style=\"margin:0 0 12px\">" + title + "</h2>" +
      '<p style="background:#f4f5f7;padding:12px 14px;border-radius:8px;font-size:16px">' + bookingLine(b, x) + "</p>" +
      "<p>" + who + "</p>" + (x.answers || []).map(function (a) { return "<p><b>" + esc(a.q) + ":</b> " + esc(a.a) + "</p>"; }).join("") +
      (x.note ? "<p><b>Their note:</b> " + esc(x.note) + "</p>" : "") +
      '<p><a href="' + esc(manage) + '">' + (kind === "requested" ? "Accept or decline it" : "Open your bookings") + "</a></p>";
    return { to: b.owner_email, subject: (kind === "cancelled" ? "Cancelled: " : kind === "requested" ? "Request: " : "New booking: ") + x.name + ", " + niceDate(x.date).replace(/ \d{4}$/, "") + " " + niceTime(x.start),
             html: wrapEmail(b, body), name: "Bookings for " + b.name, replyTo: x.email || "" };
  }

  function send(env, msg) {
    if (!msg.to) return false;
    try { env.mail(msg); return true; } catch (e) { if (env.log) env.log("email failed: " + e); return false; }
  }

  // ------------------------------------------------------------ the requests
  function business(env, key) {
    var b = env.db.getBusiness(clean(key, 60).toLowerCase());
    if (!b) throw Err("This booking page doesn't exist.");
    return b;
  }

  function service(b, id) {
    var s = b.services.filter(function (x) { return x.id === id; })[0];
    if (!s) throw Err("That service isn't available any more. Please pick another.");
    return s;
  }

  function owner(env, req, now) {
    var b = business(env, req.b);
    checkToken(b, req.token, env, now);
    return b;
  }

  function jay(env, req) {
    if (!env.adminKey || req.key !== env.adminKey) throw Err("Not allowed.");
  }

  function pruneTimeOff(b, now) {
    b.time_off = (b.time_off || []).filter(function (t) { return t.date >= addDays(now.date, -1); });
  }

  function bookingsBetween(env, b, from, to) {
    return env.db.bookings(b.id).filter(function (x) { return x.date >= from && x.date <= to; })
      .sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : x.start - y.start; });
  }

  var A = {};

  // public: the booking page
  A.config = function (req, env) {
    return { business: publicView(business(env, req.b)) };
  };

  A.slots = function (req, env, now) {
    var b = business(env, req.b), svc = service(b, req.service);
    var from = isDate(req.from) ? req.from : now.date;
    if (from < now.date) from = now.date;
    var days = Math.max(1, Math.min(14, +req.days || 7));
    var all = env.db.bookings(b.id);
    var out = [];
    var who = req.staff && req.staff !== "any" && staffById(b, req.staff) ? req.staff : "any";
    for (var i = 0; i < days; i++) {
      var d = addDays(from, i);
      out.push({ date: d, times: b.status === "active" ? freeTimes(b, all, svc, d, now, { party: req.party, staff: who }) : [] });
    }
    return { days: out, last: addDays(now.date, b.settings.days_ahead), today: now.date };
  };

  A.book = function (req, env, now) {
    var b = business(env, req.b);
    if (b.status !== "active") throw Err("Online booking is switched off at the moment. Please get in touch directly.");
    if (req.website) throw Err("Something went wrong. Please try again.");      // a hidden field only robots fill in
    var svc = service(b, req.service);
    if (!svc.active) throw Err("That service isn't available any more. Please pick another.");
    var name = clean(req.name, 80), phone = cleanPhone(req.phone), email = cleanEmail(req.email), note = clean(req.note, 500);
    if (name.length < 2) throw Err("Please add your name.");
    if (!phone) throw Err("Please add a phone number we can reach you on.");
    if (!email) throw Err("Please add your email address, so we can send your confirmation.");
    if (!isDate(req.date)) throw Err("Please pick a day.");
    var party = tables(b) ? Math.round(+req.party) : 0;
    if (tables(b) && !(party >= 1 && party <= b.settings.max_party))
      throw Err("Online booking is for up to " + b.settings.max_party + " people." + (b.phone ? " For bigger groups, please call " + b.phone + "." : ""));
    var answers = cleanAnswers(b, req.answers);
    var start = Math.round(+req.start);
    var all = env.db.bookings(b.id);
    var people = team(b), who = null;
    if (people.length) {
      if (req.staff && req.staff !== "any") {
        who = people.filter(function (p) { return p.id === req.staff; })[0];
        if (!who) throw Err("That person isn't taking bookings at the moment. Please choose someone else.");
      } else {     // 'anyone': whoever is free then, with the fewest bookings that day
        var free = people.filter(function (p) { return freeTimes(b, all, svc, req.date, now, { party: party, staff: p.id, _one: true }).indexOf(start) >= 0; });
        free.sort(function (p, q) { var n = function (s) { return all.filter(function (x) { return holds(x) && x.date === req.date && x.staff === s.id; }).length; }; return n(p) - n(q); });
        who = free[0] || null;
        if (!who) throw Err("Sorry, that time has just gone. Please pick another.", { taken: true });
      }
    }
    var weeks = Math.round(+req.repeat || 1);
    if (!(weeks >= 1 && weeks <= Math.max(1, tables(b) ? 1 : b.settings.repeat_max))) throw Err("Weekly bookings can be up to " + Math.max(1, b.settings.repeat_max) + " weeks.");
    var dates = [], gone = [];
    for (var w = 0; w < weeks; w++) dates.push(addDays(req.date, 7 * w));
    dates.forEach(function (d, i) {
      // the first must be bookable now; later weeks can be beyond the usual booking window, as long as they're free
      var ok = i === 0 ? freeTimes(b, all, svc, d, now, { party: party, staff: who ? who.id : undefined, _one: !!who }).indexOf(start) >= 0
                       : withinHours(b, d, start, svc.minutes, who ? who.id : undefined) && !clashes(b, all, d, start - (b.settings.buffer || 0), svc.minutes + 2 * (b.settings.buffer || 0), null, who ? who.id : undefined).length;
      if (!ok) gone.push(d);
    });
    if (gone.length && gone[0] === dates[0]) throw Err("Sorry, that time has just gone. Please pick another.", { taken: true });
    if (gone.length) throw Err("That time isn't free every week: " + gone.map(niceDate).join(", ") + ". Try fewer weeks, or another time.", { weeks: true });
    var mine = all.filter(function (x) { return holds(x) && x.email === email && x.date >= now.date; });
    var groups = {};
    mine.forEach(function (x) { groups[x.series || x.id] = 1; });
    if (Object.keys(groups).length >= 4) throw Err("You already have a few bookings coming up. Please get in touch to book more.");
    var series = weeks > 1 ? env.id(10) : "", made = [];
    dates.forEach(function (d) {
      var y = { id: env.id(10), business: b.id, date: d, start: start, minutes: svc.minutes, service: svc.name, service_id: svc.id,
                name: name, phone: phone, email: email, note: note, status: b.settings.approve ? "requested" : "confirmed", source: "online", created: new Date(now.ms).toISOString(),
                cancel_token: env.id(24), updated: "", party: party || "", answers: answers, staff: who ? who.id : "", staff_name: who ? who.name : "", series: series };
      env.db.saveBooking(y);
      made.push(y);
    });
    var x = Object.assign({}, made[0], { series_dates: dates });
    var kind = x.status === "requested" ? "requested" : "booked";
    var sent = send(env, customerEmail(b, x, env, kind));
    // a request always goes to the owner, even with alerts off: nothing happens until they answer it
    if (b.settings.notify_owner || kind === "requested") send(env, ownerEmail(b, x, env, kind));
    return { booking: { id: x.id, date: x.date, start: x.start, minutes: x.minutes, service: x.service, party: x.party, cancel_token: x.cancel_token, status: x.status,
                        staff_name: x.staff_name, dates: dates }, emailed: sent };
  };

  function customerBooking(env, req) {
    var b = business(env, req.b);
    var x = env.db.bookings(b.id).filter(function (y) { return y.id === req.id; })[0];
    if (!x || !req.t || x.cancel_token !== req.t) throw Err("We couldn't find that booking. Please get in touch directly.");
    return { b: b, x: x };
  }

  function canCancel(b, x, now) {
    var minsAway = dayDiff(now.date, x.date) * 1440 + x.start - now.min;
    return minsAway >= b.settings.cancel_hours * 60;
  }

  A.lookup = function (req, env, now) {
    var r = customerBooking(env, req), x = r.x;
    var rest = x.series ? seriesFrom(env, r.b, x).length : 1;
    return { booking: { date: x.date, start: x.start, minutes: x.minutes, service: x.service, party: x.party, status: x.status, name: x.name.split(" ")[0],
                        staff_name: x.staff_name || "", weeks_left: rest },
             can_cancel: holds(x) && canCancel(r.b, x, now) };
  };

  A.cancel = function (req, env, now) {
    var r = customerBooking(env, req), b = r.b, x = r.x;
    if (!holds(x)) return { already: true };
    if (!canCancel(b, x, now)) throw Err("It's too close to the time to cancel online." + (b.phone ? " Please call " + b.phone + "." : " Please get in touch directly."));
    var list = req.series ? seriesFrom(env, b, x) : [x];      // a weekly booking: this week, or this and every week after it
    list.forEach(function (y) { y.status = "cancelled"; y.updated = new Date(now.ms).toISOString(); env.db.saveBooking(y); });
    x = Object.assign({}, x, { status: "cancelled", series_dates: list.length > 1 ? list.map(function (y) { return y.date; }) : null });
    send(env, customerEmail(b, x, env, "cancelled"));
    if (b.settings.notify_owner) send(env, ownerEmail(b, x, env, "cancelled"));
    return { cancelled: true };
  };

  // owner: their own page
  A.setup = function (req, env, now) {
    var b = business(env, req.b);
    if (!b.setup_code || String(req.code || "") !== b.setup_code || (b.setup_expires && b.setup_expires < now.date))
      throw Err("This set-up link has expired or already been used. Ask Jay for a new one.");
    setPin(b, checkPinRules(req.pin), env);
    b.setup_code = ""; b.setup_expires = ""; b.fails = 0; b.lock_until = 0;
    env.db.saveBusiness(b);
    return { token: makeToken(b, env, now), business: ownerView(b) };
  };

  A.login = function (req, env, now) {
    var b = business(env, req.b);
    if (b.lock_until && b.lock_until > now.ms) throw Err("Too many wrong PINs. Please wait " + Math.ceil((b.lock_until - now.ms) / 60000) + " minutes and try again.");
    if (!b.pin || !b.pin.hash) throw Err("No PIN has been set yet. Use the set-up link Jay sent you.");
    if (env.hash(b.pin.salt + ":" + String(req.pin || "")) !== b.pin.hash) {
      b.fails = (b.fails || 0) + 1;
      if (b.fails >= MAX_FAILS) { b.lock_until = now.ms + LOCK_MINUTES * 60000; b.fails = 0; }
      env.db.saveBusiness(b);
      throw Err("That PIN isn't right.");
    }
    if (b.fails || b.lock_until) { b.fails = 0; b.lock_until = 0; env.db.saveBusiness(b); }
    return { token: makeToken(b, env, now), business: ownerView(b) };
  };

  A.admin = function (req, env, now) {
    var b = owner(env, req, now);
    var from = isDate(req.from) ? req.from : addDays(now.date, -7), to = isDate(req.to) ? req.to : addDays(now.date, 90);
    return { business: ownerView(b), bookings: bookingsBetween(env, b, from, to), today: now.date, now: now.min };
  };

  A.save = function (req, env, now) {
    var b = owner(env, req, now), p = req.patch || {};
    if (p.services) b.services = cleanServices(p.services, env);
    if (p.hours) b.hours = cleanHours(p.hours);
    if (p.settings) b.settings = cleanSettings(Object.assign({}, b.settings, p.settings));
    if (p.staff) {
      var next = cleanStaff(p.staff, env), keep = {};
      next.forEach(function (s) { keep[s.id] = 1; });
      var orphan = (b.staff || []).filter(function (s) { return !keep[s.id]; }).filter(function (s) {
        return env.db.bookings(b.id).some(function (x) { return holds(x) && x.staff === s.id && x.date >= now.date; });
      })[0];
      if (orphan) throw Err(orphan.name + " has bookings coming up. Move them to someone else first, or switch " + orphan.name + " off instead of removing them.");
      b.staff = next;
    }
    if (p.owner_email != null) { var e = cleanEmail(p.owner_email); if (!e) throw Err("That email address doesn't look right."); b.owner_email = e; }
    if (p.phone != null) b.phone = clean(p.phone, 30);
    if (p.address != null) b.address = clean(p.address, 160);
    if (p.open != null) b.status = p.open ? "active" : "paused";
    pruneTimeOff(b, now);
    b.updated = new Date(now.ms).toISOString();
    env.db.saveBusiness(b);
    return { business: ownerView(b) };
  };

  function ownerBookingFields(b, req, env) {
    var bk = req.booking || {};
    var svc = bk.service_id ? service(b, bk.service_id) : null;
    var minutes = Math.round(+(bk.minutes || (svc && svc.minutes)));
    if (!(minutes >= 5 && minutes <= 720)) throw Err("Please give the booking a length.");
    var name = clean(bk.name, 80);
    if (name.length < 2) throw Err("Please add the customer's name.");
    if (!isDate(bk.date)) throw Err("Please pick a day.");
    var start = parseHM(bk.time);
    if (start == null) throw Err("Please pick a time.");
    var email = bk.email ? cleanEmail(bk.email) : "";
    if (bk.email && !email) throw Err("That email address doesn't look right.");
    var party = tables(b) ? Math.round(+bk.party) : 0;
    if (tables(b) && !(party >= 1 && party <= 1000)) throw Err("Please say how many people.");
    var who = bk.staff ? staffById(b, bk.staff) : null;
    if (bk.staff && !who) throw Err("Please choose who it's with.");
    if (!who && team(b).length > 1) throw Err("Please choose who it's with.");
    if (!who && team(b).length === 1) who = team(b)[0];
    return { date: bk.date, start: start, minutes: minutes, service: svc ? svc.name : clean(bk.service, 60) || "Booking", service_id: svc ? svc.id : "",
             name: name, phone: clean(bk.phone, 30), email: email, note: clean(bk.note, 500), party: party || "",
             staff: who ? who.id : "", staff_name: who ? who.name : "" };
  }

  /* what stops an owner's booking: for tables, too many people at once (or time off); for appointments, another booking */
  function problems(b, all, date, start, minutes, party, ignoreId, staffId) {
    if (!tables(b)) return clashes(b, all, date, start, minutes, ignoreId, staffId);
    var hits = clashes(b, [], date, start, minutes);
    var taken = seatsTaken(all, date, start, minutes, ignoreId);
    if (taken + party > b.settings.seats) hits.push({ time_off: true, reason: "that would make " + (taken + party) + " people booked at once (you take " + b.settings.seats + ")" });
    return hits;
  }

  A.add = function (req, env, now) {
    var b = owner(env, req, now), f = ownerBookingFields(b, req, env);
    var all = env.db.bookings(b.id);
    var hits = problems(b, all, f.date, f.start, f.minutes, +f.party || 0, null, f.staff || undefined);
    if (hits.length && !req.force) return { clash: hits.map(function (h) { return h.time_off ? h.reason : h.name + " (" + hm(h.start) + ")"; }) };
    var x = Object.assign({ id: env.id(10), business: b.id, status: "confirmed", source: "owner", created: new Date(now.ms).toISOString(),
                            cancel_token: env.id(24), updated: "" }, f);
    env.db.saveBooking(x);
    var emailed = req.notify && x.email ? send(env, customerEmail(b, x, env, "booked")) : false;
    return { booking: x, emailed: emailed };
  };

  function ownedBooking(env, b, id) {
    var x = env.db.bookings(b.id).filter(function (y) { return y.id === id; })[0];
    if (!x) throw Err("That booking couldn't be found.");
    return x;
  }

  A.move = function (req, env, now) {
    var b = owner(env, req, now), x = ownedBooking(env, b, req.id);
    if (!isDate(req.date)) throw Err("Please pick a day.");
    var start = parseHM(req.time);
    if (start == null) throw Err("Please pick a time.");
    var to = req.staff != null && req.staff !== "" ? staffById(b, req.staff) : (x.staff ? staffById(b, x.staff) : null);
    if (req.staff && !to) throw Err("Please choose who it's with.");
    var hits = problems(b, env.db.bookings(b.id), req.date, start, x.minutes, +x.party || 0, x.id, to ? to.id : undefined);
    if (hits.length && !req.force) return { clash: hits.map(function (h) { return h.time_off ? h.reason : h.name + " (" + hm(h.start) + ")"; }) };
    x.date = req.date; x.start = start; x.updated = new Date(now.ms).toISOString();
    if (to) { x.staff = to.id; x.staff_name = to.name; }
    env.db.saveBooking(x);
    var emailed = req.notify && x.email ? send(env, customerEmail(b, x, env, "moved")) : false;
    return { booking: x, emailed: emailed };
  };

  /* the rest of a weekly booking, from this one on (not ones already past or answered) */
  function seriesFrom(env, b, x) {
    if (!x.series) return [x];
    return env.db.bookings(b.id).filter(function (y) { return y.series === x.series && y.date >= x.date && y.status === x.status; })
      .sort(function (p, q) { return p.date < q.date ? -1 : 1; });
  }

  A.ocancel = function (req, env, now) {
    var b = owner(env, req, now), x = ownedBooking(env, b, req.id);
    (req.series ? seriesFrom(env, b, x) : [x]).forEach(function (y) {
      if (y.id === x.id) return;
      y.status = "cancelled"; y.updated = new Date(now.ms).toISOString(); env.db.saveBooking(y);
    });
    x.status = "cancelled"; x.updated = new Date(now.ms).toISOString();
    env.db.saveBooking(x);
    var emailed = req.notify && x.email ? send(env, customerEmail(b, x, env, "cancelled")) : false;
    return { booking: x, emailed: emailed };
  };

  /* the owner answers a request: accepted becomes a normal booking (and the customer is told); declined frees the time */
  function request(env, b, id) {
    var x = ownedBooking(env, b, id);
    if (x.status !== "requested") throw Err(x.status === "confirmed" ? "That booking is already accepted." : "That request has already been answered.");
    return x;
  }

  /* accepting or declining a weekly request answers every week of it; accepting can pass it to someone else in the team */
  A.accept = function (req, env, now) {
    var b = owner(env, req, now), x = request(env, b, req.id), list = seriesFrom(env, b, x);
    var to = req.staff ? staffById(b, req.staff) : null;
    if (req.staff && !to) throw Err("Please choose who it's with.");
    if (to && to.id !== x.staff) {
      var all = env.db.bookings(b.id), busy = list.filter(function (y) { return clashes(b, all, y.date, y.start, y.minutes, y.id, to.id).length; });
      if (busy.length && !req.force) return { clash: busy.map(function (y) { return to.name + " is busy " + niceDate(y.date) + " at " + niceTime(y.start); }) };
    }
    list.forEach(function (y) {
      y.status = "confirmed"; y.updated = new Date(now.ms).toISOString();
      if (to) { y.staff = to.id; y.staff_name = to.name; }
      env.db.saveBooking(y);
    });
    var first = Object.assign({}, list[0], { series_dates: list.map(function (y) { return y.date; }) });
    return { booking: list[0], count: list.length, emailed: send(env, customerEmail(b, first, env, "booked")) };
  };

  A.decline = function (req, env, now) {
    var b = owner(env, req, now), x = request(env, b, req.id), list = seriesFrom(env, b, x), reply = clean(req.reply, 300);
    list.forEach(function (y) { y.status = "declined"; y.updated = new Date(now.ms).toISOString(); y.reply = reply; env.db.saveBooking(y); });
    var first = Object.assign({}, list[0], { series_dates: list.map(function (y) { return y.date; }) });
    return { booking: list[0], count: list.length, emailed: send(env, customerEmail(b, first, env, "declined")) };
  };

  A.timeoff_add = function (req, env, now) {
    var b = owner(env, req, now), t = req.item || {};
    var from = isDate(t.date) ? t.date : null, to = isDate(t.to_date) ? t.to_date : from;
    if (!from) throw Err("Please pick a day.");
    if (to < from || dayDiff(from, to) > 120) throw Err("Please pick an end day on or after the first day (up to 4 months).");
    var allDay = !!t.all_day, a = parseHM(t.from), e = parseHM(t.to);
    if (!allDay && (a == null || e == null || e <= a)) throw Err("Please give a start and end time, or tick 'All day'.");
    b.time_off = b.time_off || [];
    for (var d = from; d <= to; d = addDays(d, 1)) {
      b.time_off.push({ id: env.id(8), date: d, all_day: allDay, from: allDay ? "" : hm(a), to: allDay ? "" : hm(e), reason: clean(t.reason, 60),
                        staff: t.staff && staffById(b, t.staff) ? t.staff : "" });     // one person's time off, or everyone's
    }
    pruneTimeOff(b, now);
    b.time_off.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
    env.db.saveBusiness(b);
    var affected = bookingsBetween(env, b, from, to).filter(function (x) { return holds(x) && clashes(b, [], x.date, x.start, x.minutes, null, x.staff || undefined).length; });
    return { business: ownerView(b), affected: affected };
  };

  A.timeoff_del = function (req, env, now) {
    var b = owner(env, req, now);
    b.time_off = (b.time_off || []).filter(function (t) { return t.id !== req.id; });
    env.db.saveBusiness(b);
    return { business: ownerView(b) };
  };

  A.pin_change = function (req, env, now) {
    var b = owner(env, req, now);
    if (env.hash(b.pin.salt + ":" + String(req.old || "")) !== b.pin.hash) throw Err("Your current PIN isn't right.");
    setPin(b, checkPinRules(req.pin), env);
    env.db.saveBusiness(b);
    return { token: makeToken(b, env, now) };
  };

  // Jay: from Site Prospector, with his key
  A.j_create = function (req, env, now) {
    jay(env, req);
    var d = req.business || {};
    var name = clean(d.name, 80);
    if (!name) throw Err("The business needs a name.");
    var slug = slugify(d.slug || name), base = slug, n = 2;
    while (env.db.getBusiness(slug)) slug = base + "-" + n++;
    var email = cleanEmail(d.owner_email);
    if (!email) throw Err("Add the owner's email address: that's where their bookings go.");
    var b = { id: env.id(12), slug: slug, name: name, status: "active", owner_email: email, phone: clean(d.phone, 30), address: clean(d.address, 160),
              website: /^https?:\/\//.test(d.website || "") ? clean(d.website, 200) : "",
              mode: d.mode === "tables" ? "tables" : "appointments",
              services: cleanServices(d.services && d.services.length ? d.services : [{ name: d.mode === "tables" ? "Table" : "Appointment", minutes: d.mode === "tables" ? 90 : 60 }], env),
              hours: cleanHours(d.hours || {}), settings: cleanSettings(d.settings), theme: cleanTheme(d.theme), words: cleanWords(d.words), questions: cleanQuestions(d.questions), time_off: [],
              staff: d.mode === "tables" ? [] : cleanStaff(d.staff, env),
              pin: null, setup_code: env.id(20), setup_expires: addDays(now.date, SETUP_DAYS), fails: 0, lock_until: 0,
              created: new Date(now.ms).toISOString(), updated: "" };
    env.db.saveBusiness(b);
    return { slug: b.slug, id: b.id, setup_code: b.setup_code, setup_expires: b.setup_expires };
  };

  A.j_list = function (req, env, now) {
    jay(env, req);
    return { businesses: env.db.listBusinesses().map(function (b) {
      var all = env.db.bookings(b.id);
      return { slug: b.slug, name: b.name, status: b.status, owner_email: b.owner_email, has_pin: !!(b.pin && b.pin.hash), created: b.created,
               upcoming: all.filter(function (x) { return holds(x) && x.date >= now.date; }).length, total: all.length };
    }) };
  };

  A.j_code = function (req, env, now) {
    jay(env, req);
    var b = business(env, req.b);
    b.setup_code = env.id(20); b.setup_expires = addDays(now.date, SETUP_DAYS);
    env.db.saveBusiness(b);
    return { slug: b.slug, setup_code: b.setup_code, setup_expires: b.setup_expires };
  };

  A.j_update = function (req, env, now) {
    jay(env, req);
    var b = business(env, req.b), p = req.patch || {};
    if (p.theme) b.theme = cleanTheme(Object.assign({}, b.theme, p.theme));
    if (p.words) b.words = cleanWords(p.words);
    if (p.questions) b.questions = cleanQuestions(p.questions);
    if (p.staff) b.staff = cleanStaff(p.staff, env);
    if (p.settings) b.settings = cleanSettings(Object.assign({}, b.settings, p.settings));
    if (p.name) b.name = clean(p.name, 80);
    if (p.website != null) b.website = /^https?:\/\//.test(p.website) ? clean(p.website, 200) : "";
    if (p.menu_url != null) b.menu_url = /^https:\/\//.test(p.menu_url) ? clean(p.menu_url, 300) : "";
    if (p.status) b.status = p.status === "paused" ? "paused" : "active";
    env.db.saveBusiness(b);
    return { business: ownerView(b) };
  };

  /* One request in, one answer out: {ok:true, ...} or {ok:false, error}. env provides:
       db: getBusiness(slug|id), saveBusiness(b), listBusinesses(), bookings(businessId), saveBooking(x)
       now(): {date:'YYYY-MM-DD', min, ms} in UK time;  id(n): random letters/numbers;  hash(s), hmac(s): hex strings
       mail({to, subject, html, name, replyTo});  links: {book, admin};  adminKey;  log(s) (optional) */
  function handle(req, env) {
    try {
      req = req || {};
      var fn = A[req.action];
      if (!fn || !Object.prototype.hasOwnProperty.call(A, req.action)) throw Err("Unknown request.");
      var res = fn(req, env, env.now()) || {};
      res.ok = true;
      return res;
    } catch (e) {
      if (e && e.bw) {
        var out = { ok: false, error: e.message };
        ["signin", "taken", "weeks"].forEach(function (k) { if (e[k]) out[k] = true; });
        return out;
      }
      if (env.log) env.log("error: " + (e && e.stack || e));
      return { ok: false, error: "Something went wrong on our side. Please try again in a minute." };
    }
  }

  return { handle: handle, MUTATING: MUTATING, freeTimes: freeTimes, niceDate: niceDate, niceTime: niceTime, niceLength: niceLength,
           addDays: addDays, dayDiff: dayDiff, weekday: weekday, hm: hm, parseHM: parseHM, slugify: slugify, DAYS: DAYS, DAY_NAMES: DAY_NAMES,
           DEFAULT_SETTINGS: DEFAULT_SETTINGS, cleanTheme: cleanTheme, cleanWords: cleanWords, cleanQuestions: cleanQuestions,
           clean: clean, cleanEmail: cleanEmail, cleanPhone: cleanPhone, esc: esc, cleanStaff: cleanStaff };
})();
if (typeof module !== "undefined") module.exports = BW;
