// SVG charts, drawn to the width of their box and redrawn when it changes. No chart library.

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

// ---------- responsive boxes ----------
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
function svgRoot(W, H, label) {
  return s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label });
}
function legend(items) {
  return h(
    "div",
    { class: "legend" },
    items.map(([kind, color, label]) => h("span", {}, h("i", { class: `key${kind === "line" ? " line" : kind === "dot" ? " dot" : ""}`, style: `background:${color}` }), label)),
  );
}

// ---------- small pieces ----------
/** Circular progress (M3 style): share of matches won, etc. */
function ring(value, size, label, color = "var(--c-win-fill)") {
  const stroke = Math.round(size / 9);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  const mid = size / 2;
  return s(
    "svg",
    { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": label },
    s("circle", { cx: mid, cy: mid, r, fill: "none", style: "stroke:var(--md-surface-container-highest)", "stroke-width": stroke }),
    v > 0
      ? s("circle", {
          cx: mid,
          cy: mid,
          r,
          fill: "none",
          style: `stroke:${color}`,
          "stroke-width": stroke,
          "stroke-linecap": "round",
          "stroke-dasharray": `${c * v} ${c}`,
          transform: `rotate(-90 ${mid} ${mid})`,
        })
      : null,
    s("text", {
      x: mid,
      y: mid,
      "text-anchor": "middle",
      "dominant-baseline": "central",
      style: `font:500 ${Math.round(size / 4.2)}px var(--font);fill:currentColor`,
      text: value == null ? "–" : `${Math.round(v * 100)}%`,
    }),
  );
}

/** Time in each heart-rate zone as one bar, with minutes under each zone. */
function zoneBar(zones) {
  const total = zones.reduce((a, b) => a + b, 0) || 1;
  const names = ["Very light", "Light", "Moderate", "Hard", "Max"];
  return h(
    "div",
    {},
    h(
      "div",
      { class: "zonebar", role: "img", "aria-label": zones.map((sec, k) => `Zone ${k + 1}: ${Math.round(sec / 60)} min`).join(", ") },
      zones.map((sec, k) => (sec > 0 ? h("i", { style: `width:${(100 * sec) / total}%;background:var(--z${k + 1})`, title: `Z${k + 1} ${names[k]}: ${Math.round(sec / 60)} min` }) : null)),
    ),
    h(
      "div",
      { class: "zone-legend" },
      zones.map((sec, k) => h("div", { title: names[k] }, h("i", { class: "key", style: `background:var(--z${k + 1})` }), h("b", { text: `${Math.round(sec / 60)}′` }), `Z${k + 1}`)),
    ),
  );
}

/** Rounded bars, one per item ({ v, color, tip }), with an optional average line. */
function barsChart(items, o) {
  return (W) => {
    const H = o.height || 132;
    const m = { t: 10, r: 4, b: 4, l: 4 };
    const n = Math.max(1, items.length);
    const band = (W - m.l - m.r) / n;
    const bw = Math.max(4, Math.min(18, band * 0.55));
    const vals = items.map((i) => i.v).filter((v) => v != null);
    const max = Math.max(o.min || 1, ...vals) * 1.05;
    const ih = H - m.t - m.b;
    const y = (v) => m.t + ih * (1 - v / max);
    const root = svgRoot(W, H, o.aria);
    root.append(s("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "axis-line" }));
    if (o.avg != null && vals.length > 1) {
      root.append(s("line", { x1: m.l, x2: W - m.r, y1: y(o.avg), y2: y(o.avg), class: "ref" }));
    }
    const hits = [];
    items.forEach((it, i) => {
      const x = m.l + band * i + (band - bw) / 2;
      if (it.v == null) {
        root.append(s("circle", { cx: x + bw / 2, cy: H - m.b - 3, r: 2, style: "fill:var(--md-outline-variant)" }));
        return;
      }
      const top = y(it.v);
      const ht = Math.max(bw, H - m.b - top);
      const bar = s("rect", { x, y: H - m.b - ht, width: bw, height: ht, rx: bw / 2, class: "mark", style: `fill:${it.color}` });
      root.append(bar);
      if (it.tip) {
        const hit = s("rect", { x: m.l + band * i, y: 0, width: band, height: H, fill: "transparent", class: "hit", tabindex: 0, "aria-label": it.label || "" });
        bindTip(hit, it.tip, bar);
        if (it.onClick) hit.addEventListener("click", it.onClick);
        hits.push(hit);
      }
    });
    root.append(...hits);
    return root;
  };
}

/** One value per match, oldest to newest: dots on a line, with your average dashed. */
function trendChart(points, o) {
  return (W) => {
    const H = o.height || 168;
    const m = { t: 14, r: 12, b: 24, l: 40 };
    const vals = points.map((p) => p.v);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.05, 1e-6);
    // Counts and loads can't go below zero, so neither does the axis.
    lo = lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
    hi += pad;
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const X = (i) => m.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
    const Y = (v) => m.t + ih * (1 - (v - lo) / (hi - lo));
    const root = svgRoot(W, H, o.aria);
    const ticks = niceTicks(lo, hi, 3);
    for (const t of ticks) {
      root.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: "grid-line" }));
      root.append(s("text", { x: m.l - 8, y: Y(t), class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: o.fmt ? o.fmt(t) : one(t) }));
    }
    const avg = mean(vals);
    if (avg != null && points.length > 2) root.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(avg), y2: Y(avg), class: "ref" }));
    root.append(
      s("path", {
        d: points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(""),
        fill: "none",
        style: `stroke:${o.color};stroke-width:2;stroke-linejoin:round;opacity:0.55`,
      }),
    );
    const hits = [];
    points.forEach((p, i) => {
      const dot = s("circle", { cx: X(i), cy: Y(p.v), r: 4.5, class: "mark", style: `fill:${p.color || o.color};stroke:var(--card-bg);stroke-width:2` });
      root.append(dot);
      const hit = s("circle", { cx: X(i), cy: Y(p.v), r: 14, fill: "transparent", class: "hit", tabindex: 0, "aria-label": p.label || "" });
      bindTip(hit, p.tip, dot);
      if (p.onClick) hit.addEventListener("click", p.onClick);
      hits.push(hit);
    });
    if (points.length > 1) {
      root.append(s("text", { x: m.l, y: H - 6, class: "tick", text: dfDate.format(points[0].t) }));
      root.append(s("text", { x: W - m.r, y: H - 6, class: "tick", "text-anchor": "end", text: dfDate.format(points[points.length - 1].t) }));
    }
    root.append(...hits);
    return root;
  };
}
function niceTicks(lo, hi, count) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((st) => st >= raw) || raw;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(Math.round(t * 1e6) / 1e6 || 0);
  return out;
}

/** Heart rate (with zones) over the match, steps per minute underneath, games or sets marked. */
function effortChart(m) {
  const c = m.chart;
  const sp = sportOf(m.sport);
  return (W) => {
    const hasHr = c.hr.length > 1;
    const hasSteps = c.steps.length > 0;
    const pad = { l: 36, r: 26 };
    const top = c.segments.length ? 22 : 8;
    const hrH = hasHr ? 172 : 0;
    const gap = hasHr && hasSteps ? 16 : 0;
    const stH = hasSteps ? 60 : 0;
    const axis = 22;
    const H = top + hrH + gap + stH + axis;
    const span = (c.end - c.start) / 1000;
    const x0 = hasHr ? Math.min(0, c.hr[0][0]) : 0;
    const x1 = Math.max(span, hasHr ? c.hr[c.hr.length - 1][0] : span);
    const iw = Math.max(40, W - pad.l - pad.r);
    const X = (sec) => pad.l + ((sec - x0) / (x1 - x0)) * iw;
    const id = `ec${++uid}`;
    const root = svgRoot(W, H, `Heart rate${hasSteps ? " and steps" : ""} during the match`);
    const bottom = top + hrH + gap + stH;

    // Outside the match (warm-up, cool-down) is dimmed; rests between games are shaded.
    for (const [a, b] of [
      [x0, 0],
      [span, x1],
    ]) {
      if (b > a) root.append(s("rect", { x: X(a), y: top, width: X(b) - X(a), height: bottom - top, style: "fill:var(--rest)" }));
    }
    for (const [a, b] of c.rests) root.append(s("rect", { x: X(a), y: top, width: Math.max(1, X(b) - X(a)), height: bottom - top, style: "fill:var(--rest)" }));
    c.segments.forEach(([a, b], k) => {
      const sc = m.score[k];
      const wide = X(b) - X(a) > 64;
      const label = `${sp.part.charAt(0)}${k + 1}${wide && sc ? ` · ${sc[0]}–${sc[1]}` : ""}`;
      root.append(s("text", { x: (X(a) + X(b)) / 2, y: top - 8, class: "label", "text-anchor": "middle", text: label }));
      if (k > 0) root.append(s("line", { x1: X(a), x2: X(a), y1: top, y2: bottom, class: "grid-line", "stroke-dasharray": "3 3" }));
    });

    let hrAt = () => null;
    if (hasHr) {
      const vals = c.hr.map((p) => p[1]);
      const lo = Math.floor((Math.min(...vals) - 6) / 10) * 10;
      const hi = Math.ceil((Math.max(...vals) + 6) / 10) * 10;
      const Y = (v) => top + hrH - ((v - lo) / (hi - lo)) * hrH;
      const hrMax = S.data.hrMax;
      if (hrMax) {
        const floors = [0.5, 0.6, 0.7, 0.8, 0.9, 10];
        for (let k = 0; k < 5; k++) {
          const a = Math.max(lo, floors[k] * hrMax);
          const b = Math.min(hi, floors[k + 1] * hrMax);
          if (b <= a) continue;
          root.append(s("rect", { x: pad.l, y: Y(b), width: iw, height: Y(a) - Y(b), style: `fill:var(--z${k + 1});opacity:0.09` }));
          if (Y(a) - Y(b) > 12) root.append(s("text", { x: W - 2, y: (Y(a) + Y(b)) / 2, class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: `Z${k + 1}` }));
        }
      }
      const step = hi - lo > 80 ? 20 : 10;
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        root.append(s("line", { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), class: "grid-line" }));
        root.append(s("text", { x: pad.l - 6, y: Y(v), class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: String(v) }));
      }
      const defs = s(
        "defs",
        {},
        s(
          "linearGradient",
          { id, x1: 0, x2: 0, y1: 0, y2: 1 },
          s("stop", { offset: "0%", style: "stop-color:var(--c-hr);stop-opacity:0.28" }),
          s("stop", { offset: "100%", style: "stop-color:var(--c-hr);stop-opacity:0" }),
        ),
      );
      root.append(defs);
      const runs = [];
      let run = [];
      let prev = null;
      for (const p of c.hr) {
        if (prev !== null && p[0] - prev > 60) {
          runs.push(run);
          run = [];
        }
        run.push(p);
        prev = p[0];
      }
      runs.push(run);
      for (const r of runs.filter((x) => x.length > 1)) {
        const line = r.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("");
        root.append(s("path", { d: `${line}L${X(r[r.length - 1][0]).toFixed(1)},${top + hrH}L${X(r[0][0]).toFixed(1)},${top + hrH}Z`, fill: `url(#${id})` }));
        root.append(s("path", { d: line, fill: "none", style: "stroke:var(--c-hr);stroke-width:2;stroke-linejoin:round;stroke-linecap:round" }));
      }
      hrAt = (sec) => {
        let best = null;
        let bestD = Infinity;
        for (const p of c.hr) {
          const d = Math.abs(p[0] - sec);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        return best && bestD <= 60 ? best[1] : null;
      };
    }

    let stepsAt = () => null;
    if (hasSteps) {
      const sTop = top + hrH + gap;
      const maxS = Math.max(1, ...c.steps.map((p) => p[1]));
      root.append(s("text", { x: pad.l - 6, y: sTop + stH / 2, class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: "steps" }));
      root.append(s("line", { x1: pad.l, x2: W - pad.r, y1: sTop + stH, y2: sTop + stH, class: "axis-line" }));
      const bw = Math.max(1, X(60) - X(0) - 1.5);
      for (const [minute, count] of c.steps) {
        if (count <= 0) continue;
        const ht = Math.max(2, (count / maxS) * (stH - 4));
        root.append(s("rect", { x: X(minute * 60) + 0.75, y: sTop + stH - ht, width: bw, height: ht, rx: Math.min(3, bw / 2), style: "fill:var(--c-steps);opacity:0.85" }));
      }
      const byMinute = new Map(c.steps);
      stepsAt = (sec) => (sec >= 0 && sec < span ? byMinute.get(Math.floor(sec / 60)) ?? 0 : null);
    }

    const total = span / 60;
    const every = total > 150 ? 30 : total > 60 ? 15 : total > 25 ? 5 : 2;
    for (let mnt = 0; mnt * 60 <= x1; mnt += every) {
      root.append(s("text", { x: X(mnt * 60), y: H - 6, class: "tick", "text-anchor": "middle", text: `${mnt}′` }));
    }

    const cross = s("line", { y1: top, y2: bottom, class: "cross", visibility: "hidden" });
    root.append(cross);
    const hit = s("rect", {
      x: pad.l,
      y: top,
      width: iw,
      height: bottom - top,
      fill: "transparent",
      class: "hit",
      tabindex: 0,
      "aria-label": "Match timeline: move along it to read heart rate and steps",
    });
    let focusSec = 0;
    const showAt = (sec, cx, cy) => {
      focusSec = sec;
      const rows = [{ head: sec < 0 ? "Before the match" : sec > span ? "After the match" : `${clock(sec)} in` }];
      const bpm = hrAt(sec);
      if (bpm != null) rows.push({ value: `${bpm} bpm`, label: S.data.hrMax ? `${Math.round((100 * bpm) / S.data.hrMax)}% of max` : "heart rate", key: "var(--c-hr)" });
      const st = stepsAt(sec);
      if (st != null) rows.push({ value: `${st} steps`, label: "that minute", key: "var(--c-steps)" });
      const seg = c.segments.findIndex(([a, b]) => sec >= a && sec <= b);
      if (seg >= 0 && m.score[seg]) rows.push({ value: `${sp.part} ${seg + 1}`, label: `${m.score[seg][0]}–${m.score[seg][1]}` });
      if (c.rests.some(([a, b]) => sec >= a && sec <= b)) rows.push({ value: "Rest", label: "between games" });
      cross.setAttribute("x1", X(sec));
      cross.setAttribute("x2", X(sec));
      cross.setAttribute("visibility", "visible");
      showTip(rows, cx, cy);
    };
    const off = () => {
      cross.setAttribute("visibility", "hidden");
      hideTip();
    };
    hit.addEventListener("pointermove", (e) => {
      const box = root.getBoundingClientRect();
      const px = e.clientX - box.left;
      showAt(x0 + ((px - pad.l) / iw) * (x1 - x0), e.clientX, e.clientY);
    });
    hit.addEventListener("pointerleave", off);
    hit.addEventListener("blur", off);
    hit.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = Math.max(x0, Math.min(x1, focusSec + (e.key === "ArrowRight" ? 60 : -60)));
      const box = root.getBoundingClientRect();
      showAt(next, box.left + X(next), box.top + top);
    });
    root.append(hit);
    return root;
  };
}

// ---------- squash rally analysis (league matches with a full point log) ----------
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

/** Vertical columns from a baseline, with optional 95% whiskers and an "expected" tick. */
function columnChart(buckets, o) {
  return (W) => {
    const H = 220;
    const m = { t: 14, r: 8, b: 44, l: 40 };
    const iw = Math.max(10, W - m.l - m.r);
    const ih = H - m.t - m.b;
    const band = iw / buckets.length;
    const bw = Math.min(24, Math.max(6, band * 0.5));
    const useShort = Boolean(o.short) && buckets.some((b) => b.label.length * 6.4 > band - 6);
    const [d0, d1] = o.domain;
    const base = o.baseline != null ? o.baseline : d0;
    const y = (v) => m.t + ih - ((Math.max(d0, Math.min(d1, v)) - d0) / (d1 - d0)) * ih;
    const root = svgRoot(W, H, o.aria);
    for (const t of o.ticks) {
      root.append(s("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === base ? "axis-line" : "grid-line" }));
      root.append(s("text", { x: m.l - 6, y: y(t), class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: o.fmt(t) }));
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
      root.append(s("text", { x: cx, y: H - m.b + 16, class: "tick strong", "text-anchor": "middle", text: useShort ? o.short(b) : b.label }));
      root.append(s("text", { x: cx, y: H - m.b + 31, class: "tick", "text-anchor": "middle", text: `${o.count(b)}` }));
      const hit = s("rect", { x: m.l + band * i, y: m.t, width: band, height: ih, fill: "transparent", class: "hit", tabindex: 0, "aria-label": `${b.label}: ${o.describe(b)}` });
      bindTip(hit, () => o.tip(b), mark);
      hits.push(hit);
    });
    root.append(s("text", { x: m.l - 6, y: H - m.b + 31, class: "tick", "text-anchor": "end", text: o.countLabel || "n" }));
    root.append(...hits);
    return root;
  };
}

/** Horizontal bars for long category names; domain 0..1. */
function barChartH(buckets, o) {
  return (W) => {
    const rowH = 32;
    const m = { t: 6, r: 64, b: 24, l: Math.min(170, Math.round(W * 0.42)) };
    const H = m.t + rowH * buckets.length + m.b;
    const iw = Math.max(10, W - m.l - m.r);
    const x = (v) => m.l + Math.max(0, Math.min(1, v)) * iw;
    const root = svgRoot(W, H, o.aria);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      root.append(s("line", { x1: x(t), x2: x(t), y1: m.t, y2: H - m.b, class: t === 0 ? "axis-line" : "grid-line" }));
      root.append(s("text", { x: x(t), y: H - m.b + 15, class: "tick", "text-anchor": "middle", text: pct(t) }));
    }
    const hits = [];
    buckets.forEach((b, i) => {
      const yc = m.t + rowH * (i + 0.5);
      root.append(s("text", { x: m.l - 10, y: yc, class: "tick strong", "text-anchor": "end", "dominant-baseline": "middle", text: b.label }));
      let mark = null;
      if (b.pct != null) {
        const bh = 14;
        mark = s("path", { d: barRight(x(0), yc - bh / 2, Math.max(1, x(b.pct) - x(0)), bh), class: "mark", style: `fill:${o.color}`, opacity: b.n < 10 ? 0.35 : 1 });
        root.append(mark);
        if (b.lo != null && b.hi != null) {
          root.append(s("line", { x1: x(b.lo), x2: x(b.hi), y1: yc, y2: yc, class: "whisker" }));
          root.append(s("line", { x1: x(b.lo), x2: x(b.lo), y1: yc - 4, y2: yc + 4, class: "whisker" }));
          root.append(s("line", { x1: x(b.hi), x2: x(b.hi), y1: yc - 4, y2: yc + 4, class: "whisker" }));
        }
        if (b.exp != null) root.append(s("line", { x1: x(b.exp), x2: x(b.exp), y1: yc - bh / 2 - 5, y2: yc + bh / 2 + 5, class: "usual" }));
        root.append(s("text", { x: x(Math.max(b.pct, b.hi ?? b.pct, b.exp ?? 0)) + 6, y: yc, class: "tick", "dominant-baseline": "middle", text: `${pct(b.pct)} of ${b.n}` }));
      } else {
        root.append(s("text", { x: x(0) + 6, y: yc, class: "tick", "dominant-baseline": "middle", text: "none yet" }));
      }
      const hit = s("rect", { x: 0, y: yc - rowH / 2, width: W, height: rowH, fill: "transparent", class: "hit", tabindex: 0, "aria-label": `${b.label}: ${winText(b)}` });
      bindTip(hit, () => winTip(b), mark);
      hits.push(hit);
    });
    root.append(...hits);
    return root;
  };
}

const gapPts = (b) => (b.pct == null || b.exp == null ? null : Math.round((b.pct - b.exp) * 100));
function gapText(b) {
  const g = gapPts(b);
  return g == null ? "–" : g === 0 ? "as expected" : `${g > 0 ? "+" : "−"}${Math.abs(g)} pts vs expected`;
}
function winText(b) {
  return b.pct == null
    ? "no rallies yet"
    : `won ${b.won} of ${b.n} rallies (${pct(b.pct)}, likely ${pct(b.lo)}–${pct(b.hi)}); expected if it made no difference: ${pct(b.exp)}`;
}
function winTip(b) {
  if (b.pct == null) return [{ head: b.label }, { value: "No rallies yet" }];
  const rows = [
    { head: b.label },
    { value: pct(b.pct), label: `won ${b.won} of ${b.n}`, key: "var(--c-steps)" },
    { value: pct(b.exp), label: b.baseline === "opponents" ? "your usual vs these opponents" : "expected by chance in the same games" },
    { value: gapText(b), label: Math.abs(b.z ?? 0) >= 1.96 ? "clear difference" : "within normal variation" },
    { value: `${pct(b.lo)}–${pct(b.hi)}`, label: "likely range" },
  ];
  if (b.n < 10) rows.push({ value: "Few rallies", label: "too few to read much into" });
  if (b.hrDelta != null) rows.push({ value: `${Math.round(b.hr)} bpm`, label: `avg HR (${signed(b.hrDelta)} vs typical)`, key: "var(--c-hr)" });
  return rows;
}
function winColumns(buckets, short) {
  return columnChart(buckets, {
    aria: "Rally win rate by situation, with the rate expected if it made no difference",
    value: (b) => b.pct,
    lo: (b) => b.lo,
    hi: (b) => b.hi,
    expect: (b) => b.exp,
    count: (b) => b.n,
    countLabel: "rallies",
    domain: [0, 1],
    ticks: [0, 0.25, 0.5, 0.75, 1],
    fmt: pct,
    color: "var(--c-steps)",
    short,
    tip: winTip,
    describe: winText,
  });
}
function hrColumns(buckets, short) {
  const vals = buckets.map((b) => b.hrDelta).filter((v) => v != null);
  const D = Math.max(4, Math.ceil(Math.max(...vals.map(Math.abs), 0) / 2) * 2);
  return columnChart(buckets, {
    aria: "Heart rate above or below your typical level, by situation",
    value: (b) => b.hrDelta,
    count: (b) => b.hrN,
    countLabel: "rallies",
    domain: [-D, D],
    baseline: 0,
    ticks: [-D, -D / 2, 0, D / 2, D],
    fmt: (t) => (t === 0 ? "avg" : signed(t)),
    color: "var(--c-hr)",
    short,
    tip: (b) => [
      { head: b.label },
      { value: `${signed(b.hrDelta)} bpm`, label: "vs the usual for that point in the game", key: "var(--c-hr)" },
      { value: b.hr == null ? "–" : `${Math.round(b.hr)} bpm`, label: `average over ${b.hrN} rallies` },
    ],
    describe: (b) => (b.hrDelta == null ? "no heart-rate data" : `${signed(b.hrDelta)} bpm vs typical over ${b.hrN} rallies`),
  });
}
const shortDiff = (b) => ({ m5: "−5+", m3: "−3/4", m1: "−1/2", level: "0", p1: "+1/2", p3: "+3/4", p5: "+5+" })[b.key] || b.label;
const shortMomentum = (b) => ({ l3: "L3+", l2: "L2", l1: "L1", w1: "W1", w2: "W2", w3: "W3+" })[b.key] || b.label;
const shortPhase = (b) => ({ early: "Early", middle: "Middle", late: "Late" })[b.key] || b.label;
const shortZone = (b) => ({ z0: "<80", z80: "80+", z85: "85+", z90: "90+", z95: "95+" })[b.key] || b.label;

function recoveryChart(points) {
  return (W) => {
    const H = 200;
    const m = { t: 16, r: 12, b: 28, l: 40 };
    const iw = Math.max(10, W - m.l - m.r);
    const ih = H - m.t - m.b;
    const ts = points.map((p) => p.startedAt);
    const day = 86_400_000;
    const t0 = Math.min(...ts) - day;
    const t1 = Math.max(...ts) + day;
    const topV = Math.max(20, Math.ceil((Math.max(...points.map((p) => p.drop60)) + 5) / 10) * 10);
    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * iw;
    const y = (v) => m.t + ih - (v / topV) * ih;
    const root = svgRoot(W, H, "Heart-rate recovery between games over time");
    for (let v = 0; v <= topV; v += 10) {
      root.append(s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? "axis-line" : "grid-line" }));
      root.append(s("text", { x: m.l - 6, y: y(v), class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: String(v) }));
    }
    const ticks = Math.min(5, Math.max(2, Math.floor(iw / 110)));
    for (let i = 0; i <= ticks; i++) {
      const t = t0 + ((t1 - t0) * i) / ticks;
      root.append(s("text", { x: x(t), y: H - 8, class: "tick", "text-anchor": "middle", text: dfDate.format(t) }));
    }
    const avg = mean(points.map((p) => p.drop60));
    root.append(s("line", { x1: m.l, x2: W - m.r, y1: y(avg), y2: y(avg), class: "ref" }));
    const hits = [];
    for (const p of points) {
      const cx = x(p.startedAt) + (p.afterGame - 1.5) * 7;
      const cy = y(p.drop60);
      const dot = s("circle", { cx, cy, r: 4.5, class: "mark", style: "fill:var(--c-hr);stroke:var(--card-bg);stroke-width:2" });
      root.append(dot);
      const hit = s("circle", { cx, cy, r: 12, fill: "transparent", class: "hit", tabindex: 0, "aria-label": `${dfDay.format(p.startedAt)}, after game ${p.afterGame}: dropped ${Math.round(p.drop60)} bpm` });
      bindTip(
        hit,
        () => [
          { head: `${dfDay.format(p.startedAt)} · after game ${p.afterGame}` },
          { value: `−${Math.round(p.drop60)} bpm`, label: "in the first 60s", key: "var(--c-hr)" },
          { value: `${Math.round(p.hrPeak)} → ${Math.round(p.hr60)} bpm`, label: "" },
        ],
        dot,
      );
      hits.push(hit);
    }
    root.append(...hits);
    return root;
  };
}

/** A league match from your side: score and heart rate rally by rally. */
function persp(sv) {
  const meId = S.data.me ? S.data.me.id : null;
  const side = sv.players[0].id === meId ? 0 : 1;
  return {
    side,
    opp: sv.players[1 - side],
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

/** Score, pressure and heart rate on one time axis, rally by rally. */
function timelineChart(sv, match) {
  const al = sv.align;
  const P = persp(sv);
  const rallies = P.rallies;
  const series = match && match.chart ? match.chart.hr.map(([sec, v]) => [match.chart.start + sec * 1000, v]) : [];
  return (W) => {
    const hasHr = Boolean(al) && series.length > 1;
    const m = { l: 40, r: 10 };
    const top = 24;
    const hrH = hasHr ? 150 : 0;
    const gap = hasHr ? 18 : 0;
    const scH = 124;
    const axisH = 26;
    const sTop = top + hrH + gap;
    const bottom = sTop + scH;
    const H = bottom + axisH;
    const iw = Math.max(50, W - m.l - m.r);
    const id = `tl${++uid}`;
    const root = svgRoot(W, H, `Rally timeline against ${P.opp.name}`);

    let t0;
    let t1;
    let rallyT;
    let gameT;
    let restT;
    if (hasHr) {
      t0 = al.window[0] - 2 * 60_000;
      t1 = al.window[1] + 2 * 60_000;
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

    for (const [a, b] of restT) root.append(s("rect", { x: X(a), y: top, width: Math.max(1, X(b) - X(a)), height: bottom - top, style: "fill:var(--rest)" }));
    gameT.forEach(([a, b], k) => {
      const g = P.games[k];
      if (!g) return;
      const wide = X(b) - X(a) > 70;
      root.append(s("text", { x: (X(a) + X(b)) / 2, y: top - 9, class: "label", "text-anchor": "middle", text: wide ? `Game ${k + 1} · ${g[0]}–${g[1]}` : `G${k + 1}` }));
      if (k > 0 && !hasHr) root.append(s("line", { x1: X(a), x2: X(a), y1: top, y2: bottom, class: "grid-line" }));
    });

    let hrAt = () => null;
    if (hasHr) {
      const pts = series.filter(([t]) => t >= t0 && t <= t1);
      const vals = pts.map((p) => p[1]);
      const lo = Math.floor((Math.min(...vals) - 5) / 10) * 10;
      const hi = Math.ceil((Math.max(...vals) + 5) / 10) * 10;
      const step = hi - lo > 80 ? 20 : 10;
      const yH = (v) => top + hrH - ((v - lo) / (hi - lo)) * hrH;
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        root.append(s("line", { x1: m.l, x2: W - m.r, y1: yH(v), y2: yH(v), class: "grid-line" }));
        root.append(s("text", { x: m.l - 6, y: yH(v), class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: String(v) }));
      }
      let d = "";
      let prev = null;
      for (const [t, v] of pts) {
        d += `${prev !== null && t - prev <= 30_000 ? "L" : "M"}${X(t).toFixed(1)},${yH(v).toFixed(1)}`;
        prev = t;
      }
      root.append(s("path", { d, fill: "none", style: "stroke:var(--c-hr);stroke-width:2;stroke-linejoin:round;stroke-linecap:round" }));
      hrAt = (t) => {
        let best = null;
        let bestD = Infinity;
        for (const p of series) {
          const dd = Math.abs(p[0] - t);
          if (dd < bestD) {
            bestD = dd;
            best = p;
          }
        }
        return best && bestD < 30_000 ? best[1] : null;
      };
    }

    const after = (r) => r.my - r.opp + (r.won === true ? 1 : r.won === false ? -1 : 0);
    const maxAbs = Math.max(3, ...rallies.map((r) => Math.abs(after(r))), ...rallies.map((r) => Math.abs(r.my - r.opp)));
    const D = Math.ceil(maxAbs / 2) * 2;
    const yS = (v) => sTop + scH / 2 - (v / D) * (scH / 2);
    for (const v of [-D, -D / 2, 0, D / 2, D]) {
      root.append(s("line", { x1: m.l, x2: W - m.r, y1: yS(v), y2: yS(v), class: v === 0 ? "axis-line" : "grid-line" }));
      root.append(s("text", { x: m.l - 6, y: yS(v), class: "tick", "text-anchor": "end", "dominant-baseline": "middle", text: v === 0 ? "0" : signed(v) }));
    }
    root.append(s("text", { x: m.l + 4, y: sTop + 12, class: "label", text: "You lead" }));
    root.append(s("text", { x: m.l + 4, y: bottom - 6, class: "label", text: "You trail" }));
    root.append(
      s(
        "defs",
        {},
        s("clipPath", { id: `${id}a` }, s("rect", { x: 0, y: sTop, width: W, height: scH / 2 })),
        s("clipPath", { id: `${id}b` }, s("rect", { x: 0, y: sTop + scH / 2, width: W, height: scH / 2 })),
      ),
    );
    gameT.forEach(([ga, gb], k) => {
      const idx = [];
      rallies.forEach((r, i) => {
        if (r.game === k + 1) idx.push(i);
      });
      if (!idx.length) return;
      let d = `M${X(ga).toFixed(1)},${yS(0)}`;
      for (const i of idx) d += `H${X(rallyT[i][1]).toFixed(1)}V${yS(after(rallies[i])).toFixed(1)}`;
      const area = `${d}H${X(Math.max(gb, rallyT[idx[idx.length - 1]][1])).toFixed(1)}V${yS(0)}Z`;
      root.append(s("path", { d: area, "clip-path": `url(#${id}a)`, style: "fill:var(--c-win-fill);fill-opacity:0.3" }));
      root.append(s("path", { d: area, "clip-path": `url(#${id}b)`, style: "fill:var(--c-loss-fill);fill-opacity:0.3" }));
      root.append(s("path", { d, fill: "none", style: "stroke:var(--md-on-surface-variant);stroke-width:2;stroke-linejoin:round" }));
    });
    rallies.forEach((r, i) => {
      if (r.pressure < 50) return;
      const cx = X((rallyT[i][0] + rallyT[i][1]) / 2);
      root.append(s("circle", { cx, cy: yS(r.my - r.opp), r: 4, style: "fill:var(--md-on-surface);stroke:var(--card-bg);stroke-width:2" }));
    });

    if (hasHr) {
      const spanMin = (al.window[1] - al.window[0]) / 60_000;
      const every = spanMin > 40 ? 10 : spanMin > 14 ? 5 : 2;
      for (let mnt = 0; al.window[0] + mnt * 60_000 <= t1; mnt += every) {
        root.append(s("text", { x: X(al.window[0] + mnt * 60_000), y: bottom + 18, class: "tick", "text-anchor": "middle", text: `${mnt}′` }));
      }
    } else {
      const every = rallies.length > 60 ? 20 : 10;
      for (let i = 0; i <= rallies.length; i += every) root.append(s("text", { x: X(i), y: bottom + 18, class: "tick", "text-anchor": "middle", text: String(i) }));
      root.append(s("text", { x: m.l - 6, y: bottom + 18, class: "tick", "text-anchor": "end", text: "rally" }));
    }

    const cross = s("line", { y1: top, y2: bottom, class: "cross", visibility: "hidden" });
    root.append(cross);
    const nearest = (t) => {
      let best = -1;
      let bestD = Infinity;
      rallyT.forEach(([a, b], i) => {
        const dd = t < a ? a - t : t > b ? t - b : 0;
        if (dd < bestD) {
          bestD = dd;
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
        const v = hrAt(t);
        if (v != null) rows.push({ value: `${Math.round(v)} bpm`, label: "heart rate", key: "var(--c-hr)" });
        if (rest[2].drop60 != null) rows.push({ value: `−${Math.round(rest[2].drop60)} bpm`, label: "in the first minute" });
      } else {
        const i = forced != null ? forced : nearest(t);
        if (i < 0) return;
        focusIdx = i;
        const r = rallies[i];
        const mid = (rallyT[i][0] + rallyT[i][1]) / 2;
        xLine = X(mid);
        rows.push({ head: hasHr ? `${clock((mid - al.window[0]) / 1000)} in · game ${r.game}, rally ${i + 1}` : `Game ${r.game} · rally ${i + 1}` });
        rows.push({ value: `${r.my}–${r.opp}`, label: r.my === r.opp ? "level before the rally" : r.my > r.opp ? `you led by ${r.my - r.opp}` : `you trailed by ${r.opp - r.my}` });
        rows.push({ value: r.won == null ? "Let" : `${r.won ? "Won" : "Lost"}${r.kind === "stroke" ? " (stroke)" : ""}`, label: "rally" });
        rows.push({ value: String(r.pressure), label: "pressure (0–100)" });
        if (hasHr && al.rallies[i][2] != null) rows.push({ value: `${Math.round(al.rallies[i][2])} bpm`, label: "heart rate (est.)", key: "var(--c-hr)" });
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
      "aria-label": "Rally timeline. Use the left and right arrow keys to step through rallies.",
    });
    hit.addEventListener("pointermove", (e) => {
      const box = root.getBoundingClientRect();
      showAt(T(e.clientX - box.left), e.clientX, e.clientY);
    });
    const off = () => {
      cross.setAttribute("visibility", "hidden");
      hideTip();
    };
    hit.addEventListener("pointerleave", off);
    hit.addEventListener("blur", off);
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
