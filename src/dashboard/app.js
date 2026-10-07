"use strict";
(() => {
  const DATA = JSON.parse(document.getElementById("data").textContent);
  const NS = "http://www.w3.org/2000/svg";
  const app = document.getElementById("app");
  /** Served by the hosted app (which adds its own controls) rather than opened as a file. */
  const HOSTED = Boolean(document.querySelector(".controls"));

  // ---------- DOM helpers: strings always go in as text, never as HTML ----------
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
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

  // ---------- formatting ----------
  const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);
  const bpm = (v) => (v == null ? "–" : `${Math.round(v)} bpm`);
  const signed = (v) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(Math.round(v * 10) / 10)}`);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const fmtDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  const fmtStamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const clock = (ms) => {
    const sec = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  };

  // ---------- per-viewer convenience only ----------
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
        localStorage.setItem(`pj:${k}`, v);
      } catch {
        /* storage unavailable: fine */
      }
    },
  };

  // ---------- state ----------
  const players = new Map(DATA.players.map((p) => [p.id, p]));
  const meId = DATA.me ? DATA.me.id : null;
  const stored = prefs.get("player");
  let playerId = players.has(stored) ? stored : meId || busiest();
  let sessionId = null;

  function busiest() {
    return [...DATA.players].sort((a, b) => DATA.insights[b.id].record.matches - DATA.insights[a.id].record.matches)[0].id;
  }
  function playerSessions() {
    return DATA.sessions.filter((sv) => sv.players.some((p) => p.id === playerId)).sort((a, b) => b.startedAt - a.startedAt);
  }
  /** A match seen from the selected player's side. */
  function persp(sv) {
    const side = sv.players[0].id === playerId ? 0 : 1;
    return {
      side,
      opp: sv.players[1 - side],
      won: sv.winner == null ? null : sv.winner === side,
      games: sv.games.map(([a, b]) => (side === 0 ? [a, b] : [b, a])),
      rallies: sv.rallies.map((r) => ({
        game: r.g,
        my: side === 0 ? r.a : r.b,
        opp: side === 0 ? r.b : r.a,
        won: r.w == null ? null : (r.w === "a") === (side === 0),
        kind: r.k,
        pressure: r.p,
      })),
    };
  }

  // ---------- tooltip ----------
  const tip = h("div", { class: "tip", role: "status" });
  document.body.append(tip);
  function showTip(rows, x, y) {
    tip.replaceChildren(
      ...rows.map((r) =>
        r.head
          ? h("div", { class: "tip-head", text: r.head })
          : h(
              "div",
              { class: "tip-row" },
              r.key ? h("span", { class: "tip-key", style: `background:${r.key}` }) : null,
              h("strong", { text: r.value }),
              r.label ? h("span", { class: "tip-label", text: r.label }) : null,
            ),
      ),
    );
    tip.style.display = "block";
    const w = tip.offsetWidth;
    const ht = tip.offsetHeight;
    let left = x + 14;
    let top = y + 14;
    if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - 14);
    if (top + ht > window.innerHeight - 8) top = Math.max(8, y - ht - 14);
    tip.style.left = `${left + window.scrollX}px`;
    tip.style.top = `${top + window.scrollY}px`;
  }
  function hideTip() {
    tip.style.display = "none";
  }
  function bindTip(target, rows, mark) {
    const lift = (on) => mark && mark.classList.toggle("lifted", on);
    target.addEventListener("pointermove", (e) => {
      lift(true);
      showTip(rows(), e.clientX, e.clientY);
    });
    target.addEventListener("pointerleave", () => {
      lift(false);
      hideTip();
    });
    target.addEventListener("focus", () => {
      const r = target.getBoundingClientRect();
      lift(true);
      showTip(rows(), r.left + r.width / 2, r.top);
    });
    target.addEventListener("blur", () => {
      lift(false);
      hideTip();
    });
  }

  // ---------- responsive chart boxes ----------
  const drawers = new Map();
  const resizer = new ResizeObserver((entries) => {
    for (const e of entries) draw(e.target);
  });
  function chartBox(drawFn) {
    const box = h("div", { class: "chart" });
    drawers.set(box, drawFn);
    return box;
  }
  function draw(box) {
    const fn = drawers.get(box);
    const w = Math.floor(box.clientWidth);
    if (!fn || !w || box.dataset.w === String(w)) return;
    box.dataset.w = String(w);
    box.replaceChildren(fn(w));
  }
  function mountCharts() {
    for (const box of [...drawers.keys()]) {
      if (!box.isConnected) {
        drawers.delete(box);
        resizer.unobserve(box);
        continue;
      }
      draw(box);
      resizer.observe(box);
    }
  }
  let uid = 0;

  // ---------- chart primitives ----------
  function barUp(x, y, w, ht) {
    const r = Math.min(4, w / 2, ht);
    return `M${x},${y + ht}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + ht}Z`;
  }
  function barDown(x, y, w, ht) {
    const r = Math.min(4, w / 2, ht);
    return `M${x},${y}V${y + ht - r}Q${x},${y + ht} ${x + r},${y + ht}H${x + w - r}Q${x + w},${y + ht} ${x + w},${y + ht - r}V${y}Z`;
  }
  function barRight(x, y, w, ht) {
    const r = Math.min(4, ht / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + ht - r}Q${x + w},${y + ht} ${x + w - r},${y + ht}H${x}Z`;
  }
  function svgRoot(W, H, label) {
    return s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label });
  }

  /** Vertical columns from a baseline, with optional 95% whiskers and a reference line. */
  function columnChart(buckets, o) {
    return (W) => {
      const H = 232;
      const m = { t: 18, r: 10, b: 46, l: 46 };
      const iw = Math.max(10, W - m.l - m.r);
      const ih = H - m.t - m.b;
      const band = iw / buckets.length;
      const bw = Math.min(24, Math.max(6, band * 0.5));
      // ~6.6px per character at 12px; switch every label to its short form if any would collide.
      const useShort = Boolean(o.short) && buckets.some((b) => b.label.length * 6.6 > band - 8);
      const [d0, d1] = o.domain;
      const base = o.baseline != null ? o.baseline : d0;
      const y = (v) => m.t + ih - ((Math.max(d0, Math.min(d1, v)) - d0) / (d1 - d0)) * ih;
      const root = svgRoot(W, H, o.aria);
      for (const t of o.ticks) {
        root.append(s("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === base ? "axis" : "grid" }));
        root.append(s("text", { x: m.l - 8, y: y(t), class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: o.fmt(t) }));
      }
      const hits = [];
      buckets.forEach((b, i) => {
        const cx = m.l + band * (i + 0.5);
        const v = o.value(b);
        let mark = null;
        if (v != null) {
          const y0 = y(base);
          const y1 = y(v);
          const top = Math.min(y0, y1);
          const ht = Math.max(1, Math.abs(y1 - y0));
          mark = s("path", {
            d: v >= base ? barUp(cx - bw / 2, top, bw, ht) : barDown(cx - bw / 2, top, bw, ht),
            class: "mark",
            style: `fill:${o.color}`,
            opacity: o.count(b) < 10 ? 0.35 : 1,
          });
          root.append(mark);
          const lo = o.lo ? o.lo(b) : null;
          const hi = o.hi ? o.hi(b) : null;
          if (lo != null && hi != null) {
            root.append(s("line", { x1: cx, x2: cx, y1: y(lo), y2: y(hi), class: "whisker" }));
            root.append(s("line", { x1: cx - 4, x2: cx + 4, y1: y(lo), y2: y(lo), class: "whisker" }));
            root.append(s("line", { x1: cx - 4, x2: cx + 4, y1: y(hi), y2: y(hi), class: "whisker" }));
          }
          const usual = o.expect ? o.expect(b) : null;
          if (usual != null) root.append(s("line", { x1: cx - bw / 2 - 5, x2: cx + bw / 2 + 5, y1: y(usual), y2: y(usual), class: "usual" }));
        }
        const label = useShort ? o.short(b) : b.label;
        root.append(s("text", { x: cx, y: H - m.b + 18, class: "xlab", "text-anchor": "middle", text: label }));
        root.append(s("text", { x: cx, y: H - m.b + 33, class: "tick", "text-anchor": "middle", text: `${o.count(b)}` }));
        const hit = s("rect", {
          x: m.l + band * i,
          y: m.t,
          width: band,
          height: ih,
          fill: "transparent",
          class: "hit",
          tabindex: 0,
          "aria-label": `${b.label}: ${o.describe(b)}`,
        });
        bindTip(hit, () => o.tip(b), mark);
        hits.push(hit);
      });
      root.append(s("text", { x: m.l - 8, y: H - m.b + 33, class: "tick", "text-anchor": "end", text: o.countLabel || "n" }));
      root.append(...hits);
      return root;
    };
  }

  /** Horizontal bars for long category names. Domain is 0..1. */
  function barChartH(buckets, o) {
    return (W) => {
      const rowH = 32;
      const m = { t: 8, r: 70, b: 26, l: Math.min(176, Math.round(W * 0.42)) };
      const H = m.t + rowH * buckets.length + m.b;
      const iw = Math.max(10, W - m.l - m.r);
      const x = (v) => m.l + Math.max(0, Math.min(1, v)) * iw;
      const root = svgRoot(W, H, o.aria);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        root.append(s("line", { x1: x(t), x2: x(t), y1: m.t, y2: H - m.b, class: t === 0 ? "axis" : "grid" }));
        root.append(s("text", { x: x(t), y: H - m.b + 16, class: "tick", "text-anchor": "middle", text: pct(t) }));
      }
      const hits = [];
      buckets.forEach((b, i) => {
        const yc = m.t + rowH * (i + 0.5);
        root.append(s("text", { x: m.l - 10, y: yc, class: "xlab", "text-anchor": "end", "dominant-baseline": "middle", text: b.label }));
        let mark = null;
        if (b.pct != null) {
          const bh = 14;
          mark = s("path", {
            d: barRight(x(0), yc - bh / 2, Math.max(1, x(b.pct) - x(0)), bh),
            class: "mark",
            style: `fill:${o.color}`,
            opacity: b.n < 10 ? 0.35 : 1,
          });
          root.append(mark);
          if (b.lo != null && b.hi != null) {
            root.append(s("line", { x1: x(b.lo), x2: x(b.hi), y1: yc, y2: yc, class: "whisker" }));
            root.append(s("line", { x1: x(b.lo), x2: x(b.lo), y1: yc - 4, y2: yc + 4, class: "whisker" }));
            root.append(s("line", { x1: x(b.hi), x2: x(b.hi), y1: yc - 4, y2: yc + 4, class: "whisker" }));
          }
          if (b.exp != null) root.append(s("line", { x1: x(b.exp), x2: x(b.exp), y1: yc - bh / 2 - 5, y2: yc + bh / 2 + 5, class: "usual" }));
          root.append(
            s("text", {
              x: x(Math.max(b.pct, b.hi ?? b.pct, b.exp ?? 0)) + 6,
              y: yc,
              class: "value-label",
              "dominant-baseline": "middle",
              text: `${pct(b.pct)} of ${b.n}`,
            }),
          );
        } else {
          root.append(s("text", { x: x(0) + 6, y: yc, class: "tick", "dominant-baseline": "middle", text: "none yet" }));
        }
        const hit = s("rect", {
          x: 0,
          y: yc - rowH / 2,
          width: W,
          height: rowH,
          fill: "transparent",
          class: "hit",
          tabindex: 0,
          "aria-label": `${b.label}: ${winText(b)}`,
        });
        bindTip(hit, () => winTip(b), mark);
        hits.push(hit);
      });
      root.append(...hits);
      return root;
    };
  }

  // ---------- win-rate charts ----------
  /** "+6 pts" / "−4 pts": actual win rate minus the rate expected if the situation made no difference. */
  const gap = (b) => (b.pct == null || b.exp == null ? null : Math.round((b.pct - b.exp) * 100));
  const gapText = (b) => {
    const g = gap(b);
    return g == null ? "–" : g === 0 ? "as expected" : `${g > 0 ? "+" : "−"}${Math.abs(g)} pts vs expected`;
  };
  function winText(b) {
    return b.pct == null
      ? "no rallies yet"
      : `won ${b.won} of ${b.n} rallies (${pct(b.pct)}, likely ${pct(b.lo)}–${pct(b.hi)}); expected if it made no difference: ${pct(b.exp)}`;
  }
  function winTip(b) {
    if (b.pct == null) return [{ head: b.label }, { value: "No rallies yet" }];
    const rows = [
      { head: b.label },
      { value: pct(b.pct), label: `won ${b.won} of ${b.n}`, key: "var(--series-1)" },
      { value: pct(b.exp), label: b.baseline === "opponents" ? "your usual vs these opponents" : "expected by chance in the same games", key: "var(--text-primary)" },
      { value: gapText(b), label: Math.abs(b.z ?? 0) >= 1.96 ? "clear difference" : "within normal variation" },
      { value: `${pct(b.lo)}–${pct(b.hi)}`, label: "likely range" },
    ];
    if (b.n < 10) rows.push({ value: "Few rallies", label: "too few to read much into" });
    if (b.hrDelta != null) rows.push({ value: bpm(b.hr), label: `avg HR (${signed(b.hrDelta)} vs typical)`, key: "var(--series-2)" });
    return rows;
  }
  const winLegend = () =>
    legend([
      ["swatch", "var(--series-1)", "Rallies won"],
      ["line", "var(--text-primary)", "Expected if it made no difference"],
    ]);
  function winColumns(buckets, short) {
    return columnChart(buckets, {
      aria: "Rally win rate by category, with the rate expected if it made no difference",
      value: (b) => b.pct,
      lo: (b) => b.lo,
      hi: (b) => b.hi,
      expect: (b) => b.exp,
      count: (b) => b.n,
      countLabel: "rallies",
      domain: [0, 1],
      ticks: [0, 0.25, 0.5, 0.75, 1],
      fmt: pct,
      color: "var(--series-1)",
      short,
      tip: winTip,
      describe: winText,
    });
  }
  function hrColumns(buckets, short) {
    const vals = buckets.map((b) => b.hrDelta).filter((v) => v != null);
    const D = Math.max(4, Math.ceil(Math.max(...vals.map(Math.abs), 0) / 2) * 2);
    return columnChart(buckets, {
      aria: "Heart rate relative to match average by category",
      value: (b) => b.hrDelta,
      count: (b) => b.hrN,
      countLabel: "rallies",
      domain: [-D, D],
      baseline: 0,
      ticks: [-D, -D / 2, 0, D / 2, D],
      fmt: (t) => (t === 0 ? "avg" : signed(t)),
      color: "var(--series-2)",
      short,
      tip: (b) => [
        { head: b.label },
        { value: `${signed(b.hrDelta)} bpm`, label: "vs the usual for that point in the game", key: "var(--series-2)" },
        { value: bpm(b.hr), label: `average over ${b.hrN} rallies` },
      ],
      describe: (b) => (b.hrDelta == null ? "no heart-rate data" : `${signed(b.hrDelta)} bpm vs match average over ${b.hrN} rallies`),
    });
  }
  const shortDiff = (b) => ({ m5: "−5+", m3: "−3/4", m1: "−1/2", level: "0", p1: "+1/2", p3: "+3/4", p5: "+5+" })[b.key] || b.label;
  const shortMomentum = (b) => ({ l3: "L3+", l2: "L2", l1: "L1", w1: "W1", w2: "W2", w3: "W3+" })[b.key] || b.label;
  const shortPhase = (b) => ({ early: "Early", middle: "Middle", late: "Late" })[b.key] || b.label;
  const shortZone = (b) => ({ z0: "<80", z80: "80+", z85: "85+", z90: "90+", z95: "95+" })[b.key] || b.label;

  // ---------- page structure ----------
  function render() {
    hideTip();
    const ins = DATA.insights[playerId];
    const sessions = playerSessions();
    if (!sessions.some((x) => x.id === sessionId)) sessionId = defaultSession(sessions);
    const parts = [
      header(),
      DATA.demo ? demoBanner() : null,
      filters(),
      kpis(ins),
      findingsSection(ins),
      pressureSection(ins),
      progressionSection(ins),
      heartSection(ins),
      matchesSection(sessions),
      notesSection(sessions),
    ];
    app.replaceChildren(...parts.filter(Boolean));
    mountCharts();
  }

  function defaultSession(sessions) {
    const pick = sessions.find((x) => x.align) || sessions.find((x) => x.rallies.length) || sessions[0];
    return pick ? pick.id : null;
  }

  function section(title, sub, ...content) {
    return h("section", {}, h("h2", { text: title }), sub ? h("p", { class: "section-sub", text: sub }) : null, ...content);
  }

  function figure({ title, subtitle, chart, table, note, legend, wide }) {
    const body = h("div", {}, chart, legend || null);
    const tableWrap = table ? h("div", { class: "fig-table", hidden: true }, table) : null;
    const toggle = table
      ? h("button", {
          class: "linkish",
          type: "button",
          text: "Show table",
          onclick: (e) => {
            const toTable = tableWrap.hidden;
            tableWrap.hidden = !toTable;
            body.hidden = toTable;
            e.currentTarget.textContent = toTable ? "Show chart" : "Show table";
            if (!toTable) mountCharts();
          },
        })
      : null;
    return h(
      "figure",
      { class: wide ? "card span-all" : "card" },
      h("div", { class: "fig-head" }, h("div", {}, h("h3", { text: title }), subtitle ? h("p", { class: "sub", text: subtitle }) : null), toggle),
      body,
      tableWrap,
      note ? h("p", { class: "note", text: note }) : null,
    );
  }

  function table(columns, rows) {
    return h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : null, scope: "col", text: c.label })))),
        h("tbody", {}, rows.map((r) => h("tr", {}, r.map((cell, i) => h("td", { class: columns[i].num ? "num" : null }, cell))))),
      ),
    );
  }

  function bucketTable(buckets, withHr) {
    const cols = [
      { label: "Situation" },
      { label: "Rallies", num: true },
      { label: "Won", num: true },
      { label: "Win %", num: true },
      { label: "Likely range", num: true },
      { label: "Expected", num: true },
      { label: "Difference", num: true },
    ];
    if (withHr) cols.push({ label: "Avg HR", num: true }, { label: "vs typical", num: true });
    return table(
      cols,
      buckets.map((b) => {
        const row = [b.label, b.n, b.won, pct(b.pct), b.pct == null ? "–" : `${pct(b.lo)}–${pct(b.hi)}`, pct(b.exp), gapText(b)];
        if (withHr) row.push(bpm(b.hr), b.hrDelta == null ? "–" : `${signed(b.hrDelta)} bpm`);
        return row;
      }),
    );
  }

  function legend(items) {
    return h(
      "div",
      { class: "legend" },
      items.map(([kind, color, label]) =>
        h("span", {}, h("i", { class: kind === "line" ? "key-line" : kind === "dot" ? "key-dot" : "key-swatch", style: `background:${color}` }), label),
      ),
    );
  }

  function statusIcon(kind) {
    const icon = s("svg", { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true" });
    if (kind === "good") {
      icon.append(
        s("circle", { cx: 8, cy: 8, r: 7, style: "fill:var(--good)" }),
        s("path", { d: "M4.8 8.2l2.1 2.1 4.3-4.6", fill: "none", stroke: "#fff", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }),
      );
    } else if (kind === "serious" || kind === "warning") {
      icon.append(
        s("path", { d: "M8 1.5l7 12.5H1z", style: `fill:var(--${kind})` }),
        s("path", { d: "M8 6v3.8", stroke: "#0b0b0b", "stroke-width": 1.6, "stroke-linecap": "round" }),
        s("circle", { cx: 8, cy: 11.8, r: 0.9, fill: "#0b0b0b" }),
      );
    } else {
      icon.append(s("circle", { cx: 8, cy: 8, r: 5.5, fill: "none", style: "stroke:var(--text-muted)", "stroke-width": 1.5 }));
    }
    return icon;
  }

  function chip(text, color) {
    return h("span", { class: "chip" }, h("span", { class: "dot", style: `background:${color}` }), text);
  }

  function header() {
    const watch = DATA.wearable
      ? chip(
          DATA.wearable.provider === "demo"
            ? "Heart rate: simulated"
            : `Heart rate: Google Health (Fitbit), synced ${fmtDate.format(DATA.wearable.syncedAt)}`,
          "var(--series-2)",
        )
      : chip("Heart rate: watch not connected", "var(--text-muted)");
    return h(
      "header",
      { class: "top" },
      h(
        "div",
        {},
        h("h1", { text: "Performance Journal" }),
        h("p", { class: "subtitle", text: `Squash · Club Squash League · built ${fmtStamp.format(DATA.generatedAt)}` }),
      ),
      h("div", { class: "sources" }, chip(`Scores: ${DATA.sessions.length} matches`, "var(--series-1)"), watch),
    );
  }

  function demoBanner() {
    return h(
      "div",
      { class: "banner", role: "note" },
      statusIcon("warning"),
      h(
        "p",
        {},
        h("strong", { text: "Demo: heart rate is simulated. " }),
        `Scores are your real league data, but ${DATA.me ? `${DATA.me.name}'s` : "the"} heart-rate traces are generated so you can preview the dashboard. ` +
          "They depend only on effort and time, never on the score, so any heart-rate pattern here is not real. " +
          "Connect your watch (npm run auth, then npm run sync) to see your own.",
      ),
    );
  }

  function filters() {
    const select = h(
      "select",
      {
        id: "player",
        onchange: (e) => {
          playerId = e.target.value;
          prefs.set("player", playerId);
          sessionId = null;
          render();
        },
      },
      DATA.players.map((p) => {
        const opt = h("option", { value: p.id, text: p.id === meId ? `${p.name} (you)` : p.name });
        if (p.id === playerId) opt.selected = true;
        return opt;
      }),
    );
    const hint = !meId
      ? HOSTED
        ? "Pick which player you are (top of the page) to switch on heart-rate analysis."
        : "Set ME in .env to switch on heart-rate analysis."
      : playerId === meId
        ? ""
        : `Heart rate is only available for ${DATA.me.name}.`;
    return h("div", { class: "filters" }, h("label", { for: "player" }, "Player", select), hint ? h("span", { class: "you", text: hint }) : null);
  }

  function overall(ins) {
    const [w, l] = ins.record.rallies;
    return w + l ? w / (w + l) : null;
  }

  function tile(label, value, detail) {
    return h("div", { class: "tile" }, h("div", { class: "label", text: label }), h("div", { class: "value", text: value }), detail ? h("div", { class: "detail", text: detail }) : null);
  }

  function kpis(ins) {
    const r = ins.record;
    const [rw, rl] = r.rallies;
    const [gw, gl] = r.games;
    const tiles = [
      tile("Matches won", `${r.wins} of ${r.matches}`, r.matches ? `${pct(r.wins / r.matches)} win rate` : null),
      tile("Rallies won", pct(overall(ins)), `${rw} of ${rw + rl} logged rallies`),
      tile("Games", `${gw}–${gl}`, gw + gl ? `${pct(gw / (gw + gl))} of games` : null),
      tile("Typical match", r.avgMinutes ? `${Math.round(r.avgMinutes)} min` : "–", "live-scored matches"),
    ];
    if (ins.hasHr && ins.intensity.length) {
      tiles.push(
        tile("Match heart rate", bpm(mean(ins.intensity.map((i) => i.hrMean))), `average · highest ${bpm(Math.max(...ins.intensity.map((i) => i.hrMax)))}`),
      );
      if (ins.recovery.length) {
        tiles.push(tile("Recovery in 60s", `−${Math.round(mean(ins.recovery.map((x) => x.drop60)))} bpm`, `between games · ${ins.recovery.length} breaks`));
      }
    }
    return h("div", { class: "kpis" }, tiles);
  }

  function findingsSection(ins) {
    const tones = { strength: ["good", "Strength"], weakness: ["serious", "Watch"], neutral: ["neutral", "Observation"] };
    const evidence = {
      clear: "Clear difference (p < 0.05)",
      possible: "Possible difference. Needs more matches to confirm.",
      none: "No clear difference yet",
    };
    const items = ins.headlines.map((f) =>
      h(
        "article",
        { class: "card finding" },
        h("span", { class: "tone" }, statusIcon(tones[f.tone][0]), tones[f.tone][1]),
        h("h3", { text: f.title }),
        h("p", { class: "detail", text: f.detail }),
        f.evidence ? h("p", { class: "evidence", text: evidence[f.evidence] }) : null,
      ),
    );
    return section(
      "What stands out",
      "Patterns in your rally results, strongest evidence first. They describe what happened, not why.",
      items.length ? h("div", { class: "findings" }, items) : h("p", { class: "card empty", text: "Not enough complete point logs yet to say anything reliable." }),
    );
  }

  function pressureSection(ins) {
    return section(
      "Under pressure",
      "Each bar is your rally win rate in that situation. The dark tick is what you'd expect if the situation made no difference: the same games replayed with the rallies in a random order. That controls for who you played and how your day went, so a bar well below its tick means the situation itself costs you. Whiskers show the likely range; faded bars have fewer than 10 rallies.",
      h(
        "div",
        { class: "grid" },
        figure({
          title: "By score situation",
          subtitle: "Your lead or deficit before the rally",
          chart: chartBox(winColumns(ins.byDiff, shortDiff)),
          legend: winLegend(),
          table: bucketTable(ins.byDiff, ins.hasHr),
        }),
        figure({
          title: "By pressure",
          subtitle: "How much the rally could swing the match",
          chart: chartBox(winColumns(ins.byPressure)),
          legend: winLegend(),
          table: bucketTable(ins.byPressure, ins.hasHr),
        }),
        figure({
          title: "Key moments",
          subtitle: "The situations that decide games",
          chart: chartBox(barChartH(ins.situations, { aria: "Rally win rate in key moments, with the rate expected if it made no difference", color: "var(--series-1)" })),
          legend: winLegend(),
          table: bucketTable(ins.situations, ins.hasHr),
        }),
        figure({
          title: "Momentum",
          subtitle: "After a run of won (W) or lost (L) rallies",
          chart: chartBox(winColumns(ins.momentum, shortMomentum)),
          legend: winLegend(),
          table: bucketTable(ins.momentum, ins.hasHr),
        }),
      ),
    );
  }

  function progressionSection(ins) {
    return section(
      "As the match goes on",
      "Whether you fade or finish strong. Game-by-game is compared with your usual against the same opponents; stage of the game uses the same reshuffling as above.",
      h(
        "div",
        { class: "grid" },
        figure({
          title: "By game",
          subtitle: "Rally win % in each game of the match",
          chart: chartBox(winColumns(ins.byGame)),
          legend: winLegend(),
          table: bucketTable(ins.byGame, ins.hasHr),
        }),
        figure({
          title: "By stage of the game",
          subtitle: "By the leading score: early (to 4), middle (5-7), late (8+)",
          chart: chartBox(winColumns(ins.byPhase, shortPhase)),
          legend: winLegend(),
          table: bucketTable(ins.byPhase, ins.hasHr),
        }),
      ),
    );
  }

  function heartSection(ins) {
    const title = "Heart rate";
    if (!meId && HOSTED) {
      return section(
        title,
        null,
        h("p", {
          class: "card empty",
          text: "Heart-rate analysis appears once Google Health is connected, you've picked which player you are, and you've pressed Sync now (all at the top of the page).",
        }),
      );
    }
    if (!meId) {
      return section(
        title,
        null,
        h(
          "div",
          { class: "card empty" },
          h("p", { text: "Heart-rate analysis appears once your watch is connected and you've said which player you are:" }),
          h(
            "ol",
            {},
            h("li", {}, "Set ", h("code", { text: "GOOGLE_CLIENT_ID" }), " and ", h("code", { text: "GOOGLE_CLIENT_SECRET" }), " in .env (see README)"),
            h("li", {}, "Run ", h("code", { text: "npm run auth" }), ", then ", h("code", { text: "npm run sync" })),
            h("li", {}, "Set ", h("code", { text: "ME=<your name>" }), " in .env (", h("code", { text: "npm run whoami" }), " can tell you), then ", h("code", { text: "npm run build" })),
          ),
        ),
      );
    }
    if (!ins.isMe) {
      return section(title, null, h("p", { class: "card empty", text: `Heart rate comes from ${DATA.me.name}'s watch, so it's only shown when ${DATA.me.name} is selected.` }));
    }
    if (!ins.hasHr) {
      return section(
        title,
        null,
        h("p", { class: "card empty", text: "No heart-rate data lines up with your matches yet. Run npm run sync after a match you recorded on your watch." }),
      );
    }
    const zoneNote = DATA.hrMax
      ? `Zones are % of your max heart rate, ${DATA.hrMax} bpm (${DATA.hrMaxSource === "config" ? "from HR_MAX in .env" : "the highest seen in your matches; set HR_MAX in .env to override"}).`
      : null;
    const figs = [
      figure({
        title: "Heart rate by score situation",
        subtitle: "Rally heart rate above or below the usual for that point in the game",
        chart: chartBox(hrColumns(ins.byDiff, shortDiff)),
        table: bucketTable(ins.byDiff, true),
        note: "Heart rate climbs through every game, and so does the pressure, so each rally is compared with your typical heart rate at that point of a game (same game number and stage, learned across all your matches). The first 3 rallies of each game are left out while heart rate recovers from the rest. Rally times are estimated, so read this as a tendency.",
      }),
      figure({
        title: "Heart rate by pressure",
        subtitle: "Rally heart rate above or below the usual for that point in the game",
        chart: chartBox(hrColumns(ins.byPressure)),
        table: bucketTable(ins.byPressure, true),
      }),
    ];
    if (ins.byHrZone) {
      figs.push(
        figure({
          title: "Rally win % by heart-rate zone",
          subtitle: "Does a higher heart rate cost you rallies?",
          chart: chartBox(winColumns(ins.byHrZone, shortZone)),
          legend: winLegend(),
          table: bucketTable(ins.byHrZone, true),
          note: zoneNote,
        }),
      );
    }
    if (ins.recovery.length) {
      figs.push(
        figure({
          title: "Recovery between games",
          subtitle: "Heart-rate drop in the first 60 seconds of rest. Higher is faster recovery.",
          chart: chartBox(recoveryChart(ins.recovery)),
          table: table(
            [{ label: "Date" }, { label: "After game", num: true }, { label: "Peak", num: true }, { label: "After 60s", num: true }, { label: "Drop", num: true }],
            ins.recovery.map((r) => [fmtDay.format(r.startedAt), r.afterGame, bpm(r.hrPeak), bpm(r.hr60), `−${Math.round(r.drop60)} bpm`]),
          ),
        }),
      );
    }
    const intensity = h(
      "div",
      { class: "card span-all" },
      h("div", { class: "fig-head" }, h("div", {}, h("h3", { text: "Match intensity" }), h("p", { class: "sub", text: "How hard each match was on your heart, next to how close it was" }))),
      table(
        [
          { label: "Date" },
          { label: "Opponent" },
          { label: "Result" },
          { label: "Points +/−", num: true },
          { label: "Avg HR", num: true },
          { label: "Highest", num: true },
          { label: "At 90%+ of max", num: true },
          { label: "Length", num: true },
        ],
        [...ins.intensity]
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((i) => [
            fmtDay.format(i.startedAt),
            i.opponent,
            i.won ? "Won" : "Lost",
            signed(i.pointDiff),
            bpm(i.hrMean),
            bpm(i.hrMax),
            i.highShare == null ? "–" : pct(i.highShare),
            i.minutes ? `${Math.round(i.minutes)} min` : "–",
          ]),
      ),
    );
    const readiness = ins.readiness.length
      ? h(
          "div",
          { class: "card span-all" },
          h(
            "div",
            { class: "fig-head" },
            h(
              "div",
              {},
              h("h3", { text: "Readiness" }),
              h("p", { class: "sub", text: "How rested you were on match days. With a dozen or more matches this can show whether sleep or recovery tracks your results." }),
            ),
          ),
          table(
            [
              { label: "Date" },
              { label: "Result" },
              { label: "Rallies won", num: true },
              { label: "Resting HR", num: true },
              { label: "HRV", num: true },
              { label: "Sleep", num: true },
            ],
            [...ins.readiness]
              .sort((a, b) => b.startedAt - a.startedAt)
              .map((r) => [
                fmtDay.format(r.startedAt),
                r.won ? "Won" : "Lost",
                pct(r.rallyPct),
                bpm(r.restingHr),
                r.hrvMs == null ? "–" : `${Math.round(r.hrvMs)} ms`,
                r.sleepMinutes == null ? "–" : `${Math.floor(r.sleepMinutes / 60)}h ${String(Math.round(r.sleepMinutes % 60)).padStart(2, "0")}m`,
              ]),
          ),
        )
      : null;
    return section(
      title,
      "Your watch's heart rate laid over the score. Comparisons use heart rate relative to your typical level at that point of a game, so a tired day or the natural climb through a game doesn't skew them.",
      h("div", { class: "grid" }, figs, intensity, readiness),
    );
  }

  function recoveryChart(points) {
    return (W) => {
      const H = 232;
      const m = { t: 18, r: 16, b: 34, l: 46 };
      const iw = Math.max(10, W - m.l - m.r);
      const ih = H - m.t - m.b;
      const ts = points.map((p) => p.startedAt);
      const day = 86_400_000;
      const t0 = Math.min(...ts) - day;
      const t1 = Math.max(...ts) + day;
      const top = Math.max(20, Math.ceil((Math.max(...points.map((p) => p.drop60)) + 5) / 10) * 10);
      const x = (t) => m.l + ((t - t0) / (t1 - t0)) * iw;
      const y = (v) => m.t + ih - (v / top) * ih;
      const root = svgRoot(W, H, "Heart-rate recovery between games over time");
      for (let v = 0; v <= top; v += 10) {
        root.append(s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? "axis" : "grid" }));
        root.append(s("text", { x: m.l - 8, y: y(v), class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: String(v) }));
      }
      root.append(s("text", { x: m.l - 8, y: m.t - 8, class: "tick", "text-anchor": "end", text: "bpm drop" }));
      const ticks = Math.min(5, Math.max(2, Math.floor(iw / 110)));
      for (let i = 0; i <= ticks; i++) {
        const t = t0 + ((t1 - t0) * i) / ticks;
        root.append(s("text", { x: x(t), y: H - m.b + 18, class: "tick", "text-anchor": "middle", text: fmtDate.format(t) }));
      }
      const avg = mean(points.map((p) => p.drop60));
      root.append(s("line", { x1: m.l, x2: W - m.r, y1: y(avg), y2: y(avg), class: "ref" }));
      root.append(s("text", { x: W - m.r, y: y(avg) - 6, class: "ref-label", "text-anchor": "end", text: `Average ${Math.round(avg)} bpm` }));
      const hits = [];
      for (const p of points) {
        const cx = x(p.startedAt) + (p.afterGame - 1.5) * 7;
        const cy = y(p.drop60);
        const dot = s("circle", { cx, cy, r: 4.5, class: "mark", style: "fill:var(--series-2);stroke:var(--surface-1);stroke-width:2" });
        root.append(dot);
        const hit = s("circle", { cx, cy, r: 12, fill: "transparent", class: "hit", tabindex: 0, "aria-label": `${fmtDay.format(p.startedAt)}, after game ${p.afterGame}: dropped ${Math.round(p.drop60)} bpm` });
        bindTip(
          hit,
          () => [
            { head: `${fmtDay.format(p.startedAt)} · after game ${p.afterGame}` },
            { value: `−${Math.round(p.drop60)} bpm`, label: "in the first 60s", key: "var(--series-2)" },
            { value: `${bpm(p.hrPeak)} → ${bpm(p.hr60)}`, label: "" },
          ],
          dot,
        );
        hits.push(hit);
      }
      root.append(...hits);
      return root;
    };
  }

  // ---------- match explorer ----------
  function matchesSection(sessions) {
    const node = section(
      "Matches",
      "Pick a match to see score, situation, heart rate and outcome on one timeline.",
      sessions.length ? [matchDetail(sessions.find((x) => x.id === sessionId)), matchList(sessions)] : h("p", { class: "card empty", text: "No matches yet." }),
    );
    node.setAttribute("data-matches", "");
    return node;
  }
  /** Re-render just the matches section so the page doesn't jump. */
  function selectMatch(id) {
    sessionId = id;
    const fresh = matchesSection(playerSessions());
    document.querySelector("section[data-matches]").replaceWith(fresh);
    mountCharts();
    fresh.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const BASIS = {
    measured: "Exact: the scoring app recorded when each point was played.",
    "per-game-recordings": "From your watch: a separate workout for each game marks when each game started and ended.",
    "watch-pauses": "From your watch: your pauses between games mark the breaks.",
    "heart-rate": "The rests between games were found from the heart-rate dips, then rallies spread evenly within each game.",
    proportional: "No heart-rate evidence for the breaks, so rallies are spread evenly with a 90-second rest between games.",
    "recording-window": "This match was scored after it was played, so it's placed using your watch workout only. Treat the timing as rough.",
  };

  function tags(sv) {
    const list = [sv.quality.logComplete ? "Full log" : "Partial log"];
    if (sv.quality.timing === "suspect") list.push("Timing unusual");
    if (sv.quality.timing === "untimed") list.push("Scored later");
    if (sv.align) list.push("Heart rate");
    return h("span", { class: "tags" }, list.map((t) => h("span", { class: "tag", text: t })));
  }

  function matchList(sessions) {
    const rows = sessions.map((sv) => {
      const P = persp(sv);
      const tr = h(
        "tr",
        {
          class: `selectable${sv.id === sessionId ? " selected" : ""}`,
          tabindex: 0,
          "aria-selected": sv.id === sessionId ? "true" : "false",
          onclick: () => selectMatch(sv.id),
          onkeydown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              selectMatch(sv.id);
            }
          },
        },
        h("td", { text: fmtDay.format(sv.startedAt) }),
        h("td", { text: P.opp.name }),
        h("td", { text: P.won == null ? "–" : P.won ? "Won" : "Lost" }),
        h("td", { class: "num", text: P.games.map((g) => g.join("–")).join(", ") }),
        h("td", { class: "num", text: sv.minutes ? `${Math.round(sv.minutes)} min` : "–" }),
        h("td", {}, tags(sv)),
      );
      return tr;
    });
    return h(
      "div",
      { class: "card", style: "margin-top:16px" },
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          {},
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              ["Date", "Opponent", "Result", "Score", "Length", "Data"].map((c, i) => h("th", { class: i === 3 || i === 4 ? "num" : null, scope: "col", text: c })),
            ),
          ),
          h("tbody", {}, rows),
        ),
      ),
    );
  }

  function matchDetail(sv) {
    if (!sv) return null;
    const P = persp(sv);
    const result = P.won == null ? "Match" : P.won ? "Won" : "Lost";
    const meta = h(
      "div",
      { class: "match-meta" },
      h("span", { text: `${fmtDay.format(sv.startedAt)}, ${fmtTime.format(sv.startedAt)}` }),
      h("span", { text: P.games.map((g) => g.join("–")).join(", ") }),
      sv.minutes ? h("span", { text: `${Math.round(sv.minutes)} min` }) : null,
    );
    const head = (toggle) =>
      h("div", { class: "fig-head" }, h("div", {}, h("h3", { text: `${result} vs ${P.opp.name}` }), meta), toggle || null);

    if (!sv.rallies.length) {
      return h(
        "div",
        { class: "card" },
        head(),
        h("p", { class: "empty", text: "This match has no complete point-by-point log, so there's no rally timeline." }),
        sv.quality.notes.length ? h("p", { class: "note", text: sv.quality.notes.join(". ") }) : null,
      );
    }

    const al = sv.align;
    const chart = chartBox(timelineChart(sv, P));
    const keys = [
      ["swatch", "color-mix(in srgb, var(--ahead) 22%, transparent)", "You ahead"],
      ["swatch", "color-mix(in srgb, var(--behind) 22%, transparent)", "You behind"],
      ["dot", "var(--text-primary)", "High-stakes rally (pressure 50+)"],
    ];
    if (al) keys.unshift(["line", "var(--series-2)", "Heart rate"]), keys.push(["swatch", "var(--rest)", "Rest between games"]);
    const rallyRows = P.rallies.map((r, i) => {
      const row = [i + 1, r.game, `${r.my}–${r.opp}`, r.won == null ? "Let" : r.won ? "Won" : "Lost", r.kind === "stroke" ? "Stroke" : r.kind === "let" ? "Let" : "", r.pressure];
      if (al) row.push(clock((al.rallies[i][0] + al.rallies[i][1]) / 2 - al.window[0]), bpm(al.rallies[i][2]));
      return row;
    });
    const cols = [
      { label: "#", num: true },
      { label: "Game", num: true },
      { label: "Score before", num: true },
      { label: "Rally" },
      { label: "Call" },
      { label: "Pressure", num: true },
    ];
    if (al) cols.push({ label: "Time (est.)", num: true }, { label: "Heart rate", num: true });
    const tableWrap = h("div", { class: "fig-table", hidden: true }, table(cols, rallyRows));
    const body = h("div", {}, chart, legend(keys));
    const toggle = h("button", {
      class: "linkish",
      type: "button",
      text: "Show table",
      onclick: (e) => {
        const toTable = tableWrap.hidden;
        tableWrap.hidden = !toTable;
        body.hidden = toTable;
        e.currentTarget.textContent = toTable ? "Show chart" : "Show table";
        if (!toTable) mountCharts();
      },
    });

    const extra = [];
    if (al) {
      extra.push(h("p", { class: "note", text: `Rally timing: ${BASIS[al.basis]} Confidence about ${Math.round(al.confidence * 100)}%.` }));
      if (al.breaks.length) {
        extra.push(
          h(
            "div",
            { style: "margin-top:12px" },
            table(
              [
                { label: "Between games" },
                { label: "Peak", num: true },
                { label: "After 60s", num: true },
                { label: "Drop", num: true },
                { label: "Play resumed at", num: true },
                { label: "Rest found from" },
              ],
              al.breaks.map((b) => [
                `After game ${b.afterGame}`,
                bpm(b.hrPeak),
                bpm(b.hr60),
                b.drop60 == null ? "–" : `−${Math.round(b.drop60)} bpm`,
                bpm(b.hrResume),
                b.located ? (al.basis === "heart-rate" ? "heart-rate dip" : "watch / timestamps") : "assumed 90s",
              ]),
            ),
          ),
        );
      }
    } else {
      extra.push(
        h(
          "p",
          { class: "note", text: meId && playerId === meId ? "No heart-rate data for this match. Rallies are shown in order." : "Rallies are shown in order; heart rate is only available for the watch owner." },
        ),
      );
    }
    return h("div", { class: "card" }, head(toggle), body, tableWrap, extra);
  }

  /** Score, situation, heart rate and outcome on one time axis. */
  function timelineChart(sv, P) {
    const al = sv.align;
    const rallies = P.rallies;
    return (W) => {
      const hasHr = Boolean(al);
      const m = { l: 46, r: 14 };
      const top = 26;
      const hrH = hasHr ? 160 : 0;
      const gap = hasHr ? 20 : 0;
      const scH = 132;
      const axisH = 30;
      const sTop = top + hrH + gap;
      const bottom = sTop + scH;
      const H = bottom + axisH;
      const iw = Math.max(50, W - m.l - m.r);
      const id = `tl${++uid}`;
      const root = svgRoot(W, H, `Timeline of the match against ${P.opp.name}`);

      // Each rally, game and rest as an interval on the x axis (time, or rally number without HR).
      let t0;
      let t1;
      let rallyT;
      let gameT;
      let restT;
      if (hasHr) {
        t0 = al.window[0] - 2 * 60_000;
        t1 = al.window[1] + 3 * 60_000;
        rallyT = al.rallies.map(([a, b]) => [a, b]);
        gameT = al.games;
        restT = al.breaks.map((b) => [b.start, b.end, b]);
      } else {
        t0 = 0;
        t1 = rallies.length;
        rallyT = rallies.map((_, i) => [i, i + 1]);
        gameT = [];
        rallies.forEach((r, i) => {
          if (!gameT[r.game - 1]) gameT[r.game - 1] = [i, i + 1];
          gameT[r.game - 1][1] = i + 1;
        });
        gameT = gameT.filter(Boolean);
        restT = [];
      }
      const X = (t) => m.l + ((t - t0) / (t1 - t0)) * iw;
      const T = (px) => t0 + ((px - m.l) / iw) * (t1 - t0);

      for (const [a, b] of restT) {
        root.append(s("rect", { x: X(a), y: top, width: Math.max(1, X(b) - X(a)), height: bottom - top, style: "fill:var(--rest)" }));
        if (X(b) - X(a) > 34) root.append(s("text", { x: (X(a) + X(b)) / 2, y: bottom - 6, class: "band-label", "text-anchor": "middle", text: "Rest" }));
      }
      gameT.forEach(([a, b], k) => {
        const g = P.games[k];
        if (!g) return;
        const wide = X(b) - X(a) > 70;
        root.append(s("text", { x: (X(a) + X(b)) / 2, y: top - 9, class: "game-label", "text-anchor": "middle", text: wide ? `Game ${k + 1} · ${g[0]}–${g[1]}` : `G${k + 1}` }));
        if (k > 0 && !hasHr) root.append(s("line", { x1: X(a), x2: X(a), y1: top, y2: bottom, class: "grid" }));
      });

      // Heart-rate panel
      let hrAt = () => null;
      if (hasHr) {
        const pts = al.series.filter(([t]) => t >= t0 && t <= t1);
        const vals = pts.map((p) => p[1]);
        const lo = Math.floor((Math.min(...vals) - 5) / 10) * 10;
        const hi = Math.ceil((Math.max(...vals) + 5) / 10) * 10;
        const step = hi - lo > 80 ? 20 : 10;
        const yH = (v) => top + hrH - ((v - lo) / (hi - lo)) * hrH;
        for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
          root.append(s("line", { x1: m.l, x2: W - m.r, y1: yH(v), y2: yH(v), class: "grid" }));
          root.append(s("text", { x: m.l - 8, y: yH(v), class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: String(v) }));
        }
        root.append(s("text", { x: m.l - 8, y: top - 9, class: "tick", "text-anchor": "end", text: "bpm" }));
        if (DATA.hrMax) {
          const r = 0.9 * DATA.hrMax;
          if (r > lo && r < hi) {
            root.append(s("line", { x1: m.l, x2: W - m.r, y1: yH(r), y2: yH(r), class: "ref" }));
            root.append(s("text", { x: m.l + 4, y: yH(r) - 5, class: "ref-label", text: "90% of max" }));
          }
        }
        let d = "";
        let prev = null;
        for (const [t, v] of pts) {
          d += `${prev !== null && t - prev <= 30_000 ? "L" : "M"}${X(t).toFixed(1)},${yH(v).toFixed(1)}`;
          prev = t;
        }
        root.append(s("path", { d, fill: "none", style: "stroke:var(--series-2);stroke-width:2;stroke-linejoin:round;stroke-linecap:round" }));
        hrAt = (t) => {
          let lo2 = 0;
          let hi2 = al.series.length - 1;
          while (lo2 < hi2) {
            const mid = (lo2 + hi2) >> 1;
            if (al.series[mid][0] < t) lo2 = mid + 1;
            else hi2 = mid;
          }
          const p = al.series[lo2];
          return p && Math.abs(p[0] - t) < 30_000 ? p[1] : null;
        };
      }

      // Score panel: your lead (+) or deficit (−) through each game.
      const after = (r) => r.my - r.opp + (r.won === true ? 1 : r.won === false ? -1 : 0);
      const maxAbs = Math.max(3, ...rallies.map((r) => Math.abs(after(r))), ...rallies.map((r) => Math.abs(r.my - r.opp)));
      const D = Math.ceil(maxAbs / 2) * 2;
      const yS = (v) => sTop + scH / 2 - (v / D) * (scH / 2);
      for (const v of [-D, -D / 2, 0, D / 2, D]) {
        root.append(s("line", { x1: m.l, x2: W - m.r, y1: yS(v), y2: yS(v), class: v === 0 ? "axis" : "grid" }));
        root.append(s("text", { x: m.l - 8, y: yS(v), class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: v === 0 ? "0" : signed(v) }));
      }
      root.append(s("text", { x: m.l + 4, y: sTop + 12, class: "band-label", text: "You lead" }));
      root.append(s("text", { x: m.l + 4, y: bottom - 6, class: "band-label", text: "You trail" }));
      const defs = s("defs", {});
      defs.append(
        s("clipPath", { id: `${id}a` }, s("rect", { x: 0, y: sTop, width: W, height: scH / 2 })),
        s("clipPath", { id: `${id}b` }, s("rect", { x: 0, y: sTop + scH / 2, width: W, height: scH / 2 })),
      );
      root.append(defs);
      gameT.forEach(([ga, gb], k) => {
        const idx = [];
        rallies.forEach((r, i) => {
          if (r.game === k + 1) idx.push(i);
        });
        if (!idx.length) return;
        let d = `M${X(ga).toFixed(1)},${yS(0)}`;
        for (const i of idx) d += `H${X(rallyT[i][1]).toFixed(1)}V${yS(after(rallies[i])).toFixed(1)}`;
        const area = `${d}H${X(Math.max(gb, rallyT[idx[idx.length - 1]][1])).toFixed(1)}V${yS(0)}Z`;
        root.append(s("path", { d: area, "clip-path": `url(#${id}a)`, style: "fill:var(--ahead);fill-opacity:0.22" }));
        root.append(s("path", { d: area, "clip-path": `url(#${id}b)`, style: "fill:var(--behind);fill-opacity:0.22" }));
        root.append(s("path", { d, fill: "none", style: "stroke:var(--text-secondary);stroke-width:2;stroke-linejoin:round" }));
      });
      rallies.forEach((r, i) => {
        if (r.pressure < 50) return;
        const cx = X((rallyT[i][0] + rallyT[i][1]) / 2);
        root.append(s("circle", { cx, cy: yS(r.my - r.opp), r: 4, style: "fill:var(--text-primary);stroke:var(--surface-1);stroke-width:2" }));
      });

      // X axis
      if (hasHr) {
        const span = (al.window[1] - al.window[0]) / 60_000;
        const every = span > 40 ? 10 : span > 14 ? 5 : 2;
        for (let mnt = 0; al.window[0] + mnt * 60_000 <= t1; mnt += every) {
          const t = al.window[0] + mnt * 60_000;
          root.append(s("text", { x: X(t), y: bottom + 18, class: "tick", "text-anchor": "middle", text: `${mnt}′` }));
        }
        root.append(s("text", { x: m.l - 8, y: bottom + 18, class: "tick", "text-anchor": "end", text: "min" }));
      } else {
        const every = rallies.length > 60 ? 20 : 10;
        for (let i = 0; i <= rallies.length; i += every) {
          root.append(s("text", { x: X(i), y: bottom + 18, class: "tick", "text-anchor": "middle", text: String(i) }));
        }
        root.append(s("text", { x: m.l - 8, y: bottom + 18, class: "tick", "text-anchor": "end", text: "rally" }));
      }

      // Crosshair + tooltip, with arrow-key stepping through rallies.
      const cross = s("line", { y1: top, y2: bottom, class: "ref", visibility: "hidden" });
      root.append(cross);
      const nearest = (t) => {
        let best = -1;
        let bestD = Infinity;
        rallyT.forEach(([a, b], i) => {
          const d = t < a ? a - t : t > b ? t - b : 0;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        return best;
      };
      let focusIdx = -1;
      const showAt = (t, cx, cy, forced) => {
        const rest = forced == null ? restT.find(([a, b]) => t >= a && t <= b) : null;
        const rows = [];
        let xLine;
        if (rest) {
          xLine = X(t);
          rows.push({ head: `Rest after game ${rest[2].afterGame}` });
          rows.push({ value: bpm(hrAt(t)), label: "heart rate", key: "var(--series-2)" });
          if (rest[2].drop60 != null) rows.push({ value: `−${Math.round(rest[2].drop60)} bpm`, label: "in the first minute" });
        } else {
          const i = forced != null ? forced : nearest(t);
          if (i < 0) return;
          focusIdx = i;
          const r = rallies[i];
          const mid = (rallyT[i][0] + rallyT[i][1]) / 2;
          xLine = X(mid);
          rows.push({ head: hasHr ? `${clock(mid - al.window[0])} in · game ${r.game}, rally ${i + 1}` : `Game ${r.game} · rally ${i + 1}` });
          rows.push({
            value: `${r.my}–${r.opp}`,
            label: r.my === r.opp ? "level before the rally" : r.my > r.opp ? `you led by ${r.my - r.opp}` : `you trailed by ${r.opp - r.my}`,
          });
          rows.push({ value: r.won == null ? "Let" : `${r.won ? "Won" : "Lost"}${r.kind === "stroke" ? " (stroke)" : ""}`, label: "rally" });
          rows.push({ value: String(r.pressure), label: "pressure (0–100)" });
          if (hasHr) rows.push({ value: bpm(al.rallies[i][2]), label: "heart rate (est.)", key: "var(--series-2)" });
        }
        cross.setAttribute("x1", xLine);
        cross.setAttribute("x2", xLine);
        cross.setAttribute("visibility", "visible");
        showTip(rows, cx, cy);
      };
      const hit = s("rect", {
        x: m.l,
        y: top,
        width: iw,
        height: bottom - top,
        fill: "transparent",
        class: "hit",
        tabindex: 0,
        "aria-label": "Match timeline. Use the left and right arrow keys to step through rallies; the table view lists every rally.",
      });
      hit.addEventListener("pointermove", (e) => {
        const box = root.getBoundingClientRect();
        showAt(T(e.clientX - box.left), e.clientX, e.clientY);
      });
      hit.addEventListener("pointerleave", () => {
        cross.setAttribute("visibility", "hidden");
        hideTip();
      });
      hit.addEventListener("blur", () => {
        cross.setAttribute("visibility", "hidden");
        hideTip();
      });
      hit.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const next = Math.max(0, Math.min(rallies.length - 1, focusIdx + (e.key === "ArrowRight" ? 1 : -1)));
        const mid = (rallyT[next][0] + rallyT[next][1]) / 2;
        const box = root.getBoundingClientRect();
        showAt(mid, box.left + X(mid), box.top + sTop, next);
      });
      root.append(hit);
      return root;
    };
  }

  function notesSection(sessions) {
    const flagged = sessions.filter((sv) => sv.quality.notes.length);
    return section(
      "How this works",
      null,
      h(
        "div",
        { class: "card notes" },
        h("h3", { text: "Rally times" }),
        h(
          "p",
          {},
          "The scoring app records when each match starts and ends, but not when each point is played. The dashboard rebuilds the timeline from the best evidence it has: ",
          "per-point timestamps if the app saves them, your watch's start/stop or pause between games, the drop in heart rate during the rest between games, or as a last resort an even spread. ",
          "Each match says which it used. Adding a timestamp to every point in the scoring app makes rally-level heart rate exact.",
        ),
        h("h3", { text: "Pressure" }),
        h(
          "p",
          { text: "A rally's pressure is how much it swings the chance of winning the match: the difference between winning and losing it, for two evenly matched players. 100 is the biggest possible swing (deciding-game points like 10-9); the first rally of a match is under 15." },
        ),
        h("h3", { text: "Reading the numbers" }),
        h(
          "p",
          {
            text:
              "Raw win rates mislead: you're more often 5 points down against stronger players, so 'down 5+' looks bad for everyone. " +
              "So each situation is compared with what the same games would give if it made no difference: the rallies of every game are reshuffled hundreds of times (keeping each game's score, and only orders squash scoring allows) and the situation's win rate is measured each time. Whole-game situations (game 3, a deciding game) are compared with your rally win rate against the same opponent in your other matches. " +
              "A finding is called a clear difference only when it would rarely happen by chance (p < 0.05). Heart-rate comparisons are made within each match and then across matches. " +
              "Several findings are checked for each player, so expect roughly one 'clear' in twenty to be a fluke: trust the ones that persist as matches accumulate. " +
              "With a few hundred rallies only big effects show up as clear; every match you add sharpens the picture.",
          },
        ),
        h("h3", { text: "Data quality" }),
        flagged.length
          ? h(
              "ul",
              {},
              flagged.map((sv) => {
                const P = persp(sv);
                return h("li", { text: `${fmtDay.format(sv.startedAt)} vs ${P.opp.name}: ${sv.quality.notes.join("; ")}` });
              }),
            )
          : h("p", { text: "Every match for this player has a complete, live-scored point log." }),
      ),
    );
  }

  render();
})();
