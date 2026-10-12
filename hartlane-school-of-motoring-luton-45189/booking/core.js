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
    seats: 30,           // tables mode: how many people they take bookings for at the same time
    max_party: 8,        // tables mode: the biggest group that can book online (bigger groups phone)
    notify_owner: true   // email the owner about each new booking and cancellation
  };
  var MUTATING = { book: 1, cancel: 1, setup: 1, login: 1, save: 1, add: 1, move: 1, ocancel: 1, timeoff_add: 1,
                   timeoff_del: 1, pin_change: 1, j_create: 1, j_code: 1, j_update: 1 };
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
    list.slice(0, 40).forEach(function (s) {
      var name = clean(s && s.name, 60);
      if (!name) return;
      var minutes = Math.round(+s.minutes);
      if (!(minutes >= 5 && minutes <= 720)) throw Err("'" + name + "' needs a length between 5 minutes and 12 hours.");
      out.push({ id: clean(s.id, 20) || env.id(8), name: name, minutes: minutes, price: clean(s.price, 20),
                 desc: clean(s.desc, 160), active: s.active !== false });
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
    num("seats", 1, 1000); num("max_party", 1, 100);
    if (s.note != null) out.note = clean(s.note, 400);
    if (s.notify_owner != null) out.notify_owner = !!s.notify_owner;
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
             note_q: clean(w.note_q, 60) || "Anything we should know?", note_hint: clean(w.note_hint, 120) };
  }

  function publicView(b) {
    return {
      slug: b.slug, name: b.name, phone: b.phone || "", address: b.address || "", website: b.website || "",
      services: b.services.filter(function (s) { return s.active; }).map(function (s) {
        return { id: s.id, name: s.name, minutes: s.minutes, price: s.price, desc: s.desc };
      }),
      settings: { days_ahead: b.settings.days_ahead, cancel_hours: b.settings.cancel_hours, note: b.settings.note, notice_hours: b.settings.notice_hours,
                  max_party: b.settings.max_party },
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
    bookings.forEach(function (x) { if (x.status === "confirmed" && x.date === date && x.start > start && x.start < start + minutes) points.push(x.start); });
    points.forEach(function (p) {
      var n = 0;
      bookings.forEach(function (x) {
        if (x.status === "confirmed" && x.date === date && x.id !== ignoreId && x.start <= p && x.start + x.minutes > p) n += (+x.party || 2);
      });
      most = Math.max(most, n);
    });
    return most;
  }

  function busyFor(b, bookings, date, ignoreId) {
    var buf = b.settings.buffer || 0, out = [];
    bookings.forEach(function (x) {
      if (x.status === "confirmed" && x.date === date && x.id !== ignoreId) out.push([x.start - buf, x.start + x.minutes + buf]);
    });
    (b.time_off || []).forEach(function (t) {
      if (t.date !== date) return;
      out.push(t.all_day ? [0, 1440] : [parseHM(t.from), parseHM(t.to)]);
    });
    return out;
  }

  /* Start times (minutes) a customer could book for a service on a date. opts.owner skips the notice and how-far-ahead
     rules (the owner can book anyone in); opts.ignore leaves one booking out (when moving it). */
  function freeTimes(b, bookings, svc, date, now, opts) {
    opts = opts || {};
    var s = b.settings, dur = svc.minutes, step = s.step || 30;
    var dd = dayDiff(now.date, date);
    if (dd < 0) return [];
    if (!opts.owner && dd > s.days_ahead) return [];
    var earliest = opts.owner ? now.min : now.min + s.notice_hours * 60;   // in minutes from the start of today
    var busy = tables(b) ? busyFor(b, [], date) : busyFor(b, bookings, date, opts.ignore);   // tables: only time off blocks a time outright
    var party = Math.max(1, +opts.party || 2);
    var out = [];
    (b.hours[DAYS[weekday(date)]] || []).forEach(function (r) {
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

  function clashes(b, bookings, date, start, minutes, ignoreId) {
    var hits = [];
    bookings.forEach(function (x) {
      if (x.status === "confirmed" && x.date === date && x.id !== ignoreId && start < x.start + x.minutes && start + minutes > x.start) hits.push(x);
    });
    (b.time_off || []).forEach(function (t) {
      if (t.date !== date) return;
      var a = t.all_day ? 0 : parseHM(t.from), e = t.all_day ? 1440 : parseHM(t.to);
      if (start < e && start + minutes > a) hits.push({ time_off: true, reason: t.reason || "Time off" });
    });
    return hits;
  }

  function withinHours(b, date, start, minutes) {
    return (b.hours[DAYS[weekday(date)]] || []).some(function (r) { return start >= parseHM(r[0]) && start + minutes <= parseHM(r[1]); });
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
    return esc(x.service) + "<br>" + esc(niceDate(x.date)) + " at " + esc(niceTime(x.start)) + " (" + esc(niceLength(x.minutes)) + ")";
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
    if (kind === "cancelled") {
      subject = "Cancelled: " + what(b, x) + " on " + niceDate(x.date);
      body = "<h2 style=\"margin:0 0 12px\">Your booking is cancelled</h2><p>Hi " + esc(x.name.split(" ")[0]) + ",</p><p>This booking with " + esc(b.name) + " is cancelled:</p>" +
        '<p style="background:#f4f5f7;padding:12px 14px;border-radius:8px">' + bookingLine(b, x) + "</p>" +
        '<p><a href="' + esc(env.links.book + "?b=" + encodeURIComponent(b.slug)) + '">Book another time</a></p>' + (contact ? "<p>" + contact + "</p>" : "");
    } else {
      subject = (kind === "moved" ? "Changed: " : "Booked: ") + what(b, x) + " on " + niceDate(x.date) + " at " + niceTime(x.start);
      body = "<h2 style=\"margin:0 0 12px\">" + (kind === "moved" ? "Your booking has changed" : "You're booked in") + "</h2><p>Hi " + esc(x.name.split(" ")[0]) + ",</p>" +
        "<p>" + (kind === "moved" ? "Your booking with " + esc(b.name) + " is now:" : "Thanks for booking with " + esc(b.name) + ".") + "</p>" +
        '<p style="background:#f4f5f7;padding:12px 14px;border-radius:8px;font-size:16px">' + bookingLine(b, x) + "</p>" +
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
    var title = kind === "cancelled" ? "Booking cancelled by the customer" : "New booking";
    var body = "<h2 style=\"margin:0 0 12px\">" + title + "</h2>" +
      '<p style="background:#f4f5f7;padding:12px 14px;border-radius:8px;font-size:16px">' + bookingLine(b, x) + "</p>" +
      "<p>" + who + "</p>" + (x.note ? "<p><b>Their note:</b> " + esc(x.note) + "</p>" : "") +
      '<p><a href="' + esc(manage) + '">Open your bookings</a></p>';
    return { to: b.owner_email, subject: (kind === "cancelled" ? "Cancelled: " : "New booking: ") + x.name + ", " + niceDate(x.date).replace(/ \d{4}$/, "") + " " + niceTime(x.start),
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
    for (var i = 0; i < days; i++) {
      var d = addDays(from, i);
      out.push({ date: d, times: b.status === "active" ? freeTimes(b, all, svc, d, now, { party: req.party }) : [] });
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
    var start = Math.round(+req.start);
    var all = env.db.bookings(b.id);
    if (freeTimes(b, all, svc, req.date, now, { party: party }).indexOf(start) < 0) throw Err("Sorry, that time has just gone. Please pick another.", { taken: true });
    var mine = all.filter(function (x) { return x.status === "confirmed" && x.email === email && x.date >= now.date; });
    if (mine.length >= 4) throw Err("You already have a few bookings coming up. Please get in touch to book more.");
    var x = { id: env.id(10), business: b.id, date: req.date, start: start, minutes: svc.minutes, service: svc.name, service_id: svc.id,
              name: name, phone: phone, email: email, note: note, status: "confirmed", source: "online", created: new Date(now.ms).toISOString(),
              cancel_token: env.id(24), updated: "", party: party || "" };
    env.db.saveBooking(x);
    var sent = send(env, customerEmail(b, x, env, "booked"));
    if (b.settings.notify_owner) send(env, ownerEmail(b, x, env, "booked"));
    return { booking: { id: x.id, date: x.date, start: x.start, minutes: x.minutes, service: x.service, party: x.party, cancel_token: x.cancel_token }, emailed: sent };
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
    return { booking: { date: x.date, start: x.start, minutes: x.minutes, service: x.service, party: x.party, status: x.status, name: x.name.split(" ")[0] },
             can_cancel: x.status === "confirmed" && canCancel(r.b, x, now) };
  };

  A.cancel = function (req, env, now) {
    var r = customerBooking(env, req), b = r.b, x = r.x;
    if (x.status !== "confirmed") return { already: true };
    if (!canCancel(b, x, now)) throw Err("It's too close to the time to cancel online." + (b.phone ? " Please call " + b.phone + "." : " Please get in touch directly."));
    x.status = "cancelled"; x.updated = new Date(now.ms).toISOString();
    env.db.saveBooking(x);
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
    return { date: bk.date, start: start, minutes: minutes, service: svc ? svc.name : clean(bk.service, 60) || "Booking", service_id: svc ? svc.id : "",
             name: name, phone: clean(bk.phone, 30), email: email, note: clean(bk.note, 500), party: party || "" };
  }

  /* what stops an owner's booking: for tables, too many people at once (or time off); for appointments, another booking */
  function problems(b, all, date, start, minutes, party, ignoreId) {
    if (!tables(b)) return clashes(b, all, date, start, minutes, ignoreId);
    var hits = clashes(b, [], date, start, minutes);
    var taken = seatsTaken(all, date, start, minutes, ignoreId);
    if (taken + party > b.settings.seats) hits.push({ time_off: true, reason: "that would make " + (taken + party) + " people booked at once (you take " + b.settings.seats + ")" });
    return hits;
  }

  A.add = function (req, env, now) {
    var b = owner(env, req, now), f = ownerBookingFields(b, req, env);
    var all = env.db.bookings(b.id);
    var hits = problems(b, all, f.date, f.start, f.minutes, +f.party || 0);
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
    var hits = problems(b, env.db.bookings(b.id), req.date, start, x.minutes, +x.party || 0, x.id);
    if (hits.length && !req.force) return { clash: hits.map(function (h) { return h.time_off ? h.reason : h.name + " (" + hm(h.start) + ")"; }) };
    x.date = req.date; x.start = start; x.updated = new Date(now.ms).toISOString();
    env.db.saveBooking(x);
    var emailed = req.notify && x.email ? send(env, customerEmail(b, x, env, "moved")) : false;
    return { booking: x, emailed: emailed };
  };

  A.ocancel = function (req, env, now) {
    var b = owner(env, req, now), x = ownedBooking(env, b, req.id);
    x.status = "cancelled"; x.updated = new Date(now.ms).toISOString();
    env.db.saveBooking(x);
    var emailed = req.notify && x.email ? send(env, customerEmail(b, x, env, "cancelled")) : false;
    return { booking: x, emailed: emailed };
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
      b.time_off.push({ id: env.id(8), date: d, all_day: allDay, from: allDay ? "" : hm(a), to: allDay ? "" : hm(e), reason: clean(t.reason, 60) });
    }
    pruneTimeOff(b, now);
    b.time_off.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
    env.db.saveBusiness(b);
    var affected = bookingsBetween(env, b, from, to).filter(function (x) { return x.status === "confirmed" && clashes(b, [], x.date, x.start, x.minutes).length; });
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
              hours: cleanHours(d.hours || {}), settings: cleanSettings(d.settings), theme: cleanTheme(d.theme), words: cleanWords(d.words), time_off: [],
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
               upcoming: all.filter(function (x) { return x.status === "confirmed" && x.date >= now.date; }).length, total: all.length };
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
    if (p.settings) b.settings = cleanSettings(Object.assign({}, b.settings, p.settings));
    if (p.name) b.name = clean(p.name, 80);
    if (p.website != null) b.website = /^https?:\/\//.test(p.website) ? clean(p.website, 200) : "";
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
        ["signin", "taken"].forEach(function (k) { if (e[k]) out[k] = true; });
        return out;
      }
      if (env.log) env.log("error: " + (e && e.stack || e));
      return { ok: false, error: "Something went wrong on our side. Please try again in a minute." };
    }
  }

  return { handle: handle, MUTATING: MUTATING, freeTimes: freeTimes, niceDate: niceDate, niceTime: niceTime, niceLength: niceLength,
           addDays: addDays, dayDiff: dayDiff, weekday: weekday, hm: hm, parseHM: parseHM, slugify: slugify, DAYS: DAYS, DAY_NAMES: DAY_NAMES,
           DEFAULT_SETTINGS: DEFAULT_SETTINGS, cleanTheme: cleanTheme, cleanWords: cleanWords };
})();
if (typeof module !== "undefined") module.exports = BW;
