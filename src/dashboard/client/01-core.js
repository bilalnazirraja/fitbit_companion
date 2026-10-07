// Shared state, DOM helpers, formatting, server calls, navigation and the app shell.
// The files in this folder run as one script, in name order (see dashboard/render.ts).

/** Everything the page knows: AppState from render.ts. Replaced wholesale after each change. */
let S = JSON.parse(document.getElementById("data").textContent);
const root = document.getElementById("app");
const NS = "http://www.w3.org/2000/svg";
const HOSTED = Boolean(S.hosted);
/** Signed in: may log, edit, sync and ask the AI. Everyone else can look. */
const EDIT = HOSTED && Boolean(S.canEdit);
/** Page builders by route name; each returns { title, body, actions, ... } (see render()). */
const PAGES = {};

const SPORT = {
  squash: { label: "Squash", icon: "sports_tennis", unit: "point", part: "Game", parts: "games", minutes: 45 },
  padel: { label: "Padel", icon: "padel", unit: "game", part: "Set", parts: "sets", minutes: 90 },
  golf: { label: "Golf", icon: "sports_golf", unit: "hole", part: "Hole", parts: "holes", minutes: 240 },
};
const SPORT_KEYS = Object.keys(SPORT);
const sportOf = (key) => SPORT[key] || { label: key, icon: "flag", unit: "point", part: "Game", parts: "games", minutes: 60 };

// ---------- DOM helpers: strings always go in as text, never as HTML ----------
function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "value") node.value = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
function s(tag, attrs, ...kids) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid) node.append(kid);
  return node;
}
/** Replaces a node's children; arrays are flattened and null/false skipped, as in h(). */
function fill(node, ...kids) {
  node.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k instanceof Node ? k : document.createTextNode(String(k)))));
  return node;
}
function icon(name, cls) {
  return h("span", { class: cls ? `ms ${cls}` : "ms", "aria-hidden": "true", text: name });
}
function iconButton(name, label, onclick, cls) {
  return h("button", { class: `icon-btn${cls ? ` ${cls}` : ""}`, type: "button", "aria-label": label, title: label, onclick }, icon(name));
}
function cardHead(title, iconName, ...extra) {
  return h("div", { class: "card-head" }, iconName ? icon(iconName) : null, h("h2", { class: "title-medium", text: title }), ...extra);
}
function field(label, input, help) {
  return h("label", { class: "field" }, h("span", { class: "field-label", text: label }), input, help ? h("span", { class: "field-help", text: help }) : null);
}

// ---------- formatting ----------
const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const int = (v) => (v == null || !Number.isFinite(v) ? "–" : nf0.format(v));
const one = (v) => (v == null || !Number.isFinite(v) ? "–" : nf1.format(v));
const two = (v) => (v == null || !Number.isFinite(v) ? "–" : nf2.format(v));
const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);
const signed = (v) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(Math.round(v * 10) / 10)}`);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const dfDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const dfDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dfLong = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const dfMonth = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const dfTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dfStamp = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function duration(min) {
  if (min == null) return "–";
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
}
function clock(sec) {
  const v = Math.max(0, Math.round(sec));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}
function money(usd) {
  if (!usd) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function relDay(t) {
  const today = dayKey(Date.now());
  const k = dayKey(t);
  if (k === today) return "Today";
  if (k === dayKey(Date.now() - 86_400_000)) return "Yesterday";
  return dfDay.format(t);
}
function sleepText(min) {
  return min == null ? "–" : `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
}

// ---------- matches ----------
const allMatches = () => S.data.matches || [];
const matchById = (id) => allMatches().find((m) => m.id === id);
function matchesFor(sport) {
  return sport === "all" ? allMatches() : allMatches().filter((m) => m.sport === sport);
}
const setsWon = (m) => m.score.filter(([a, b]) => a > b).length;
function matchTitle(m) {
  if (m.sport === "golf") {
    const where = (m.strokes && m.strokes.course) || "Round of golf";
    return m.opponents.length ? `${where} with ${m.opponents.join(", ")}` : where;
  }
  if (m.partner) return `With ${m.partner} vs ${m.opponents.join(" & ")}`;
  return `vs ${m.opponents.join(" & ") || "?"}`;
}
/** "2–1" for games/sets; strokes for golf. */
function scoreShort(m) {
  if (m.strokes) return String(m.strokes.strokes);
  return m.score.length ? `${setsWon(m)}–${m.score.length - setsWon(m)}` : "–";
}
function overPar(m) {
  if (!m.strokes) return null;
  const d = m.strokes.strokes - m.strokes.par;
  return d === 0 ? "E" : d > 0 ? `+${d}` : `−${-d}`;
}
function resultBadge(m) {
  if (m.sport === "golf") return m.strokes ? h("span", { class: "badge", text: overPar(m) }) : null;
  if (m.result === "win") return h("span", { class: "badge win", text: "Won" });
  if (m.result === "loss") return h("span", { class: "badge loss", text: "Lost" });
  if (m.result === "draw") return h("span", { class: "badge", text: "Draw" });
  return null;
}
function resultClass(m) {
  return m.result === "win" ? "win" : m.result === "loss" ? "loss" : "";
}
function opponentsList() {
  const count = new Map();
  for (const m of allMatches()) for (const o of [...m.opponents, ...(m.partner ? [m.partner] : [])]) count.set(o, (count.get(o) || 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

// ---------- per-viewer conveniences (never data that matters) ----------
const prefs = {
  get(k) {
    try {
      return localStorage.getItem(`pj:${k}`);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(`pj:${k}`);
      else localStorage.setItem(`pj:${k}`, v);
    } catch {
      /* storage unavailable: fine */
    }
  },
};
function currentSport() {
  const v = prefs.get("sport");
  return v && (v === "all" || SPORT[v]) ? v : "all";
}
function sportChips(selected, onPick, withAll = true) {
  const counts = new Map(SPORT_KEYS.map((k) => [k, matchesFor(k).length]));
  const options = [...(withAll ? [["all", "All", null]] : []), ...SPORT_KEYS.map((k) => [k, SPORT[k].label, SPORT[k].icon])];
  return h(
    "div",
    { class: "chips", role: "toolbar", "aria-label": "Sport" },
    options.map(([key, label, ic]) =>
      h(
        "button",
        {
          class: "chip",
          type: "button",
          "aria-pressed": String(key === selected),
          onclick: () => onPick(key),
        },
        key === selected ? icon("check") : ic ? icon(ic) : null,
        label,
        key === "all" ? null : h("span", { class: "count", text: String(counts.get(key)) }),
      ),
    ),
  );
}

// ---------- server ----------
async function api(path, method = "GET", body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
  let out;
  try {
    out = await res.json();
  } catch {
    out = { ok: false, message: `The server answered ${res.status}.` };
  }
  if (res.status === 401) setTimeout(() => (location.href = "/login"), 1500);
  if (!res.ok && out.ok !== false) out = { ...out, ok: false, message: out.message || `The server answered ${res.status}.` };
  return out;
}

// ---------- snackbar & dialogs ----------
const snackEl = h("div", { class: "snackbar", role: "status", "aria-live": "polite" });
document.body.append(snackEl);
let snackTimer = 0;
function snack(text, opts = {}) {
  clearTimeout(snackTimer);
  fill(
    snackEl,
    h("span", { class: "msg", text }),
    opts.action
      ? h("button", {
          class: "btn text",
          type: "button",
          text: opts.action,
          onclick: () => {
            hideSnack();
            opts.onAction();
          },
        })
      : null,
  );
  snackEl.classList.toggle("low", route().page === "log");
  snackEl.classList.add("show");
  snackTimer = setTimeout(hideSnack, opts.long ? 9000 : 4500);
}
function hideSnack() {
  snackEl.classList.remove("show");
}
function confirmDialog({ title, text, confirm = "OK", danger = false }) {
  return new Promise((resolve) => {
    const dlg = h(
      "dialog",
      { class: "dialog" },
      h("h2", { class: "headline-small", text: title }),
      text ? h("p", { class: "body-medium muted", text }) : null,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn text", type: "button", text: "Cancel", onclick: () => dlg.close("cancel") }),
        h("button", { class: danger ? "btn filled danger" : "btn filled", type: "button", text: confirm, onclick: () => dlg.close("ok") }),
      ),
    );
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(dlg.returnValue === "ok");
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// ---------- navigation ----------
function route() {
  const [page, id] = location.hash.replace(/^#\/?/, "").split("/");
  return { page: page || "home", id: id ? decodeURIComponent(id) : null };
}
const href = (page, id) => `#/${page}${id ? `/${encodeURIComponent(id)}` : ""}`;
const go = (page, id) => {
  location.hash = href(page, id);
};
let lastKey = null;
let previousHash = "#/";
window.addEventListener("hashchange", () => render());

// ---------- theme ----------
function theme() {
  return prefs.get("theme") || "system";
}
function setTheme(t) {
  prefs.set("theme", t === "system" ? null : t);
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

// ---------- sync ----------
let syncing = false;
function syncButton() {
  if (!EDIT || !S.google || !S.google.configured) return null;
  const last = S.google.lastSync;
  const failed = last && !last.ok;
  const label = syncing ? "Syncing your watch data" : last ? `Sync watch data (last: ${dfStamp.format(last.at)})` : "Sync watch data";
  return h(
    "button",
    { class: "icon-btn", type: "button", "aria-label": label, title: label, disabled: syncing, onclick: () => syncNow() },
    icon(failed && !syncing ? "sync_problem" : "sync", syncing ? "spin" : null),
  );
}
/** Pulls watch data for every match. A sync stops after ~45s, so this keeps going until nothing's pending. */
async function syncNow({ quiet = false } = {}) {
  if (syncing) return;
  if (!S.google || !S.google.connected) {
    snack("Connect Google Health first, in Settings.", { action: "Settings", onAction: () => go("settings") });
    return;
  }
  syncing = true;
  render();
  let last = { ok: false, message: "Sync didn't start." };
  for (let part = 1; part <= 10; part++) {
    last = await api("/sync", "POST");
    if (!last.ok || !last.pending) break;
  }
  const fresh = await api("/api/data");
  syncing = false;
  if (fresh && fresh.data) S = fresh;
  render();
  if (!last.ok) {
    const reconnect = /reconnect|connect it|expired|revoked/i.test(last.message);
    snack(last.message, reconnect ? { long: true, action: "Reconnect", onAction: () => (location.href = "/connect") } : { long: true });
  } else if (!quiet) {
    snack(last.message.trim());
  }
}

// ---------- shell ----------
const NAV = [
  { page: "home", label: "Home", icon: "home" },
  { page: "matches", label: "Matches", icon: "scoreboard" },
  { page: "insights", label: "Insights", icon: "insights" },
  { page: "settings", label: "Settings", icon: "settings" },
];
const LOGO_SVG = () =>
  s(
    "svg",
    { class: "logo", viewBox: "0 0 512 512", "aria-hidden": "true" },
    s("rect", { width: 512, height: 512, rx: 112, fill: "#121411" }),
    s("path", {
      d: "M92 272h78l40-92 56 176 44-120 28 36h82",
      fill: "none",
      stroke: "#c6f432",
      "stroke-width": 36,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );

function navLinks(active) {
  return NAV.filter((n) => HOSTED || n.page !== "settings").map((n) =>
    h(
      "a",
      { class: "nav-item", href: href(n.page), "aria-current": n.page === active ? "page" : null },
      h("span", { class: "pill" }, icon(n.icon)),
      h("span", { text: n.label }),
    ),
  );
}
function avatarButton() {
  if (!HOSTED) return null;
  if (!EDIT) return h("a", { class: "btn text", href: "/login" }, icon("key"), "Sign in");
  const initial = (S.name || "Y").trim().charAt(0).toUpperCase();
  return h("a", { class: "icon-btn", href: href("settings"), "aria-label": "Settings", title: "Settings" }, h("span", { class: "avatar", text: initial }));
}
function topBar(view) {
  const titles = view.brand
    ? h("div", { class: "topbar-titles brand" }, LOGO_SVG(), h("span", { class: "title-large", text: "Journal" }))
    : h(
        "div",
        { class: "topbar-titles" },
        h("h1", { class: view.subtitle ? "title-medium" : "title-large", text: view.title || "" }),
        view.subtitle ? h("div", { class: "body-small muted", text: view.subtitle }) : null,
      );
  return h(
    "header",
    { class: `topbar${view.back || view.close ? " has-back" : ""}` },
    view.back ? h("a", { class: "icon-btn", href: view.back, "aria-label": "Back" }, icon("arrow_back")) : null,
    view.close ? iconButton("close", "Close", view.close) : null,
    titles,
    ...(view.actions || []),
  );
}

function render() {
  hideTip();
  const r = route();
  const name = PAGES[r.page] ? r.page : "home";
  const key = `${name}/${r.id || ""}`;
  if (key !== lastKey && lastKey && !lastKey.startsWith("log/")) previousHash = `#/${lastKey.replace(/\/$/, "")}`;
  const view = PAGES[name](r);
  const full = Boolean(view.full);
  const active = view.nav || name;
  const fab =
    EDIT && !full && view.fab !== false
      ? h(
          "a",
          { class: `fab floating${view.fab === "extended" ? " extended" : ""}`, href: href("log"), "aria-label": "Log a match" },
          icon("add"),
          view.fab === "extended" ? h("span", { text: "Log match" }) : null,
        )
      : null;
  root.replaceChildren(
    h(
      "div",
      { class: `app${full ? " app-full" : ""}` },
      full
        ? null
        : h(
            "nav",
            { class: "rail", "aria-label": "Main" },
            EDIT ? h("a", { class: "fab", href: href("log"), "aria-label": "Log a match", title: "Log a match" }, icon("add")) : null,
            navLinks(active),
          ),
      h(
        "div",
        { class: "app-body" },
        topBar(view),
        syncing ? h("div", { class: "progress indeterminate sync-progress", role: "progressbar", "aria-label": "Syncing" }, h("i")) : null,
        h(
          "main",
          { class: "main", id: "main" },
          view.body,
          h("footer", { class: "credit body-small" }, "Powered by ", h("a", { href: "https://rapteck.com/", target: "_blank", rel: "noopener", text: "Rapteck" })),
        ),
      ),
      full ? null : h("nav", { class: "navbar", "aria-label": "Main" }, navLinks(active)),
      fab,
    ),
  );
  if (key !== lastKey) window.scrollTo(0, 0);
  lastKey = key;
  onScroll();
  mountCharts();
  if (view.mounted) view.mounted();
}

function onScroll() {
  const bar = document.querySelector(".topbar");
  if (bar) bar.classList.toggle("scrolled", window.scrollY > 4);
}
window.addEventListener("scroll", onScroll, { passive: true });

function notFoundView(text) {
  return {
    title: "Not found",
    back: "#/",
    body: [h("div", { class: "empty" }, icon("help"), h("p", { class: "title-medium", text: text || "There's nothing here." }))],
  };
}
