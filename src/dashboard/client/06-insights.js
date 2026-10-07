// Insights: trends across matches, opponents, readiness, and the squash rally analysis, each folded
// to a headline until you open it.

PAGES.insights = () => {
  const sport = currentSport();
  const list = matchesFor(sport);
  return {
    title: "Insights",
    actions: [syncButton()],
    body: [
      sportChips(sport, (v) => {
        prefs.set("sport", v);
        render();
      }),
      h("div", { style: "height:12px" }),
      list.length ? insightsBody(sport, list) : emptyMatches(sport),
    ],
  };
};

function insightsBody(sport, list) {
  const sum = S.data.summaries[sport];
  const chrono = [...list].reverse().slice(-30);
  return [
    summaryTiles(sport, sum),
    h(
      "div",
      { class: "grid", style: "margin-top:12px" },
      effortTrendCard(sport, chrono),
      efficiencyTrendCard(sport, chrono),
      sport !== "golf" ? opponentsCard(sum) : null,
      readinessInsightCard(list),
    ),
    sport === "squash" || sport === "all" ? rallySection() : null,
    howItWorks(),
  ];
}

function summaryTiles(sport, sum) {
  const a = sum.avg;
  const tiles =
    sport === "all"
      ? [
          stat("Matches", String(sum.matches), null, sum.wins + sum.losses ? `${sum.wins} won · ${sum.losses} lost` : null, "scoreboard"),
          stat("Time played", duration(sum.minutes), null, null, "timer"),
          stat("Opponents", String(sum.opponents.length), null, null, "group"),
          stat("Total load", int(sum.load), null, null, "bolt"),
        ]
      : [
          stat("Matches", String(sum.matches), null, sport === "golf" ? null : `${sum.wins} won · ${sum.losses} lost`, sportOf(sport).icon),
          stat("Avg heart rate", a.hr != null ? int(a.hr) : "–", a.hr != null ? "bpm" : null, a.maxHr != null ? `peaks ~${a.maxHr}` : null, "favorite"),
          stat("Avg load", a.load != null ? int(a.load) : "–", null, a.minutes != null ? `${duration(a.minutes)} a match` : null, "bolt"),
          stat(sport === "golf" ? "Avg score" : "Points won", sport === "golf" ? (a.strokes != null ? one(a.strokes) : "–") : pct(a.unitShare), null, null, "emoji_events"),
        ];
  return h("div", { class: "stats four" }, tiles.map((t) => h("div", { class: "tile" }, t)));
}

/** "Up 12% over your last 5 matches" when there's enough to compare, else a count. */
function trend(vals, o) {
  if (vals.length < 6) return `${vals.length} match${vals.length === 1 ? "" : "es"} with data so far: trends show from 6.`;
  const recent = mean(vals.slice(-5));
  const before = mean(vals.slice(-10, -5));
  if (!before) return "";
  const d = (recent - before) / before;
  if (Math.abs(d) < 0.03) return `Steady: your last 5 matches are level with the 5 before (${o.fmt(recent)}).`;
  const better = o.lowerIsBetter == null ? null : (d < 0) === o.lowerIsBetter;
  const verdict = better == null ? "" : better ? ` ${o.good}` : ` ${o.bad}`;
  return `${o.label} is ${d > 0 ? "up" : "down"} ${Math.abs(Math.round(d * 100))}% over your last 5 matches (${o.fmt(recent)} vs ${o.fmt(before)}).${verdict}`;
}

function trendPoints(list, pick, describe) {
  return list
    .filter((m) => pick(m) != null)
    .map((m) => ({
      t: m.startedAt,
      v: pick(m),
      color: m.result === "win" ? "var(--c-win-fill)" : m.result === "loss" ? "var(--c-loss-fill)" : "var(--c-steps)",
      label: `${dfDate.format(m.startedAt)}, ${matchTitle(m)}: ${describe(m)}`,
      tip: () => [{ head: `${dfDay.format(m.startedAt)} · ${matchTitle(m)}` }, { value: describe(m), label: resultWord(m) }],
      onClick: () => go("match", m.id),
    }));
}

function trendCard(title, iconName, points, o) {
  if (!points.length) {
    return h("div", { class: "card half" }, cardHead(title, iconName), h("p", { class: "body-medium muted", text: o.empty }));
  }
  return h(
    "div",
    { class: "card half" },
    cardHead(title, iconName),
    h("p", { class: "body-medium", style: "margin-bottom:12px", text: trend(points.map((p) => p.v), o) }),
    chartBox(trendChart(points, { aria: `${title} per match, oldest to newest`, color: o.color, fmt: o.axis || o.fmt })),
    legend([
      ["dot", "var(--c-win-fill)", "Won"],
      ["dot", "var(--c-loss-fill)", "Lost"],
      ["line", "var(--md-on-surface-variant)", "Average"],
    ]),
    o.note ? h("p", { class: "body-small muted", style: "margin-top:8px", text: o.note }) : null,
  );
}

function effortTrendCard(sport, chrono) {
  return trendCard(
    "Effort",
    "bolt",
    trendPoints(chrono, (m) => (m.hr ? m.hr.load : null), (m) => `load ${m.hr.load} · ${Math.round(m.hr.avg)} bpm avg`),
    {
      label: "Load per match",
      fmt: (v) => int(v),
      color: "var(--c-load)",
      empty: "Effort shows once your matches have heart rate.",
      note: "Load counts each minute by heart-rate zone: 1 point a minute in zone 1, up to 5 in zone 5.",
    },
  );
}

function efficiencyTrendCard(sport, chrono) {
  if (sport === "all") return null;
  const unit = sportOf(sport).unit;
  const won = unit === "hole" ? "" : " won";
  return trendCard(
    `Effort per ${unit}${won}`,
    "speed",
    trendPoints(chrono, (m) => (m.efficiency ? m.efficiency.beatsPerUnit : null), (m) => `${one(m.efficiency.beatsPerUnit)} beats per ${unit}${won}`),
    {
      label: `Effort per ${unit}${won}`,
      fmt: (v) => one(v),
      lowerIsBetter: true,
      good: `You're winning ${unit}s more cheaply.`,
      bad: `Each ${unit} won is costing you more.`,
      color: "var(--c-hr)",
      empty: "Needs heart rate for your matches.",
      note: `Heartbeats above resting for each ${unit} you won. Lower means more efficient.`,
    },
  );
}

function opponentsCard(sum) {
  const opps = sum.opponents.slice(0, 8);
  if (!opps.length) return null;
  const withHr = opps.filter((o) => o.avgHr != null);
  // Only call someone the toughest once you've played them, and someone else, more than once.
  const regulars = withHr.filter((o) => o.played >= 2);
  const toughest = regulars.length > 1 ? regulars.reduce((a, o) => (o.avgHr > a.avgHr ? o : a)) : null;
  const maxHr = Math.max(...withHr.map((o) => o.avgHr), 1);
  const minHr = Math.min(...withHr.map((o) => o.avgHr), maxHr) - 10;
  return h(
    "div",
    { class: "card half" },
    cardHead("Opponents", "group"),
    toughest ? h("p", { class: "body-medium", style: "margin-bottom:14px", text: `${toughest.name} makes you work hardest: ${toughest.avgHr} bpm on average.` }) : null,
    h(
      "div",
      { class: "bar-list" },
      opps.map((o) =>
        h(
          "div",
          { class: "bar-item" },
          h("span", { class: "title-small", text: o.name }),
          h("span", { class: "body-small muted num", text: `${o.won}–${o.lost}${o.avgHr != null ? ` · ${o.avgHr} bpm` : ""}` }),
          o.avgHr != null
            ? h("div", { class: "bar", role: "img", "aria-label": `${o.avgHr} bpm average against ${o.name}` }, h("i", { style: `width:${Math.max(4, (100 * (o.avgHr - minHr)) / (maxHr - minHr))}%;background:var(--c-hr)` }))
            : null,
        ),
      ),
    ),
  );
}

function readinessInsightCard(list) {
  const rated = list.filter((m) => m.daily && m.daily.sleepMinutes != null && m.result);
  if (rated.length < 6) {
    return h(
      "div",
      { class: "card half" },
      cardHead("Sleep and results", "bedtime"),
      h("p", {
        class: "body-medium muted",
        text: `${rated.length} match${rated.length === 1 ? "" : "es"} with sleep data so far. From 6, this shows whether a good night's sleep goes with better results.`,
      }),
    );
  }
  const split = (test) => {
    const g = rated.filter(test);
    const won = g.filter((m) => m.result === "win").length;
    return { n: g.length, rate: g.length ? won / g.length : null, load: mean(g.filter((m) => m.hr).map((m) => m.hr.load)) };
  };
  const good = split((m) => m.daily.sleepMinutes >= 420);
  const short = split((m) => m.daily.sleepMinutes < 420);
  const row = (label, g) =>
    h(
      "div",
      { class: "bar-item" },
      h("span", { class: "title-small", text: label }),
      h("span", { class: "body-small muted num", text: g.n ? `won ${pct(g.rate)} of ${g.n}` : "no matches" }),
      h("div", { class: "bar" }, h("i", { style: `width:${Math.max(2, (g.rate || 0) * 100)}%;background:var(--c-win-fill)` })),
    );
  return h(
    "div",
    { class: "card half" },
    cardHead("Sleep and results", "bedtime"),
    h("div", { class: "bar-list" }, row("7 hours or more", good), row("Under 7 hours", short)),
    h("p", { class: "body-small muted", style: "margin-top:12px", text: "Sleep is the night before each match, from your Fitbit. With a dozen matches or so this starts to mean something." }),
  );
}

function panel(title, sub, ...content) {
  const d = h(
    "details",
    { class: "panel" },
    h("summary", {}, h("div", { class: "li-body" }, h("div", { class: "title-medium", text: title }), sub ? h("div", { class: "body-small muted", text: sub }) : null), icon("expand_more", "chev")),
    h("div", { class: "panel-body" }, content),
  );
  d.addEventListener("toggle", () => d.open && mountCharts());
  return d;
}

function figure(title, sub, chart, legendNode, note) {
  return h(
    "div",
    {},
    h("h3", { class: "title-small", text: title }),
    sub ? h("p", { class: "body-small muted", style: "margin-bottom:8px", text: sub }) : null,
    chart,
    legendNode || null,
    note ? h("p", { class: "body-small muted", style: "margin-top:8px", text: note }) : null,
  );
}

const winLegend = () =>
  legend([
    ["swatch", "var(--c-steps)", "Rallies won"],
    ["line", "var(--md-on-surface)", "Expected if it made no difference"],
  ]);

function rallySection() {
  const ins = S.data.me && S.data.insights ? S.data.insights[S.data.me.id] : null;
  if (!ins || ins.record.rallies[0] + ins.record.rallies[1] === 0) return null;
  const logged = S.data.quality.completeLogs;
  const tones = { strength: ["trending_up", "Strength"], weakness: ["trending_down", "Watch"], neutral: ["info", "Observation"] };
  const evidence = { clear: "Clear difference (p < 0.05)", possible: "Possible difference; needs more matches", none: "No clear difference yet" };
  const findings = ins.headlines.length
    ? ins.headlines.map((f) =>
        h(
          "div",
          { class: `finding ${f.tone}` },
          h("div", { class: "label-medium" }, icon(tones[f.tone][0], "xs"), tones[f.tone][1]),
          h("div", { class: "title-small", text: f.title }),
          h("p", { class: "body-medium", text: f.detail }),
          f.evidence ? h("p", { class: "body-small muted", text: evidence[f.evidence] }) : null,
        ),
      )
    : h("p", { class: "body-medium muted", text: "Not enough complete point logs yet to say anything reliable." });
  const parts = [
    panel("What stands out", "The strongest patterns in your rallies", findings),
    panel(
      "Under pressure",
      "Win rate by score and by what's at stake",
      figure("By score situation", "Your lead or deficit before the rally", chartBox(winColumns(ins.byDiff, shortDiff)), winLegend()),
      figure("By pressure", "How much the rally could swing the match", chartBox(winColumns(ins.byPressure)), winLegend()),
      figure("Key moments", "The situations that decide games", chartBox(barChartH(ins.situations, { aria: "Rally win rate in key moments", color: "var(--c-steps)" })), winLegend()),
      figure("Momentum", "After a run of won (W) or lost (L) rallies", chartBox(winColumns(ins.momentum, shortMomentum)), winLegend()),
    ),
    panel(
      "As the match goes on",
      "Do you fade or finish strong?",
      figure("By game", "Rally win rate in each game", chartBox(winColumns(ins.byGame)), winLegend()),
      figure("By stage of the game", "Early (to 4), middle (5-7), late (8+)", chartBox(winColumns(ins.byPhase, shortPhase)), winLegend()),
    ),
  ];
  if (ins.hasHr) {
    parts.push(
      panel(
        "Heart rate and the score",
        "Is your heart rate different when behind or under pressure?",
        figure("By score situation", "Heart rate above or below your usual at that point of a game", chartBox(hrColumns(ins.byDiff, shortDiff))),
        figure("By pressure", null, chartBox(hrColumns(ins.byPressure))),
        ins.byHrZone ? figure("Rally win rate by heart-rate zone", "Does a higher heart rate cost you rallies?", chartBox(winColumns(ins.byHrZone, shortZone)), winLegend()) : null,
      ),
    );
  }
  if (ins.recovery.length) {
    parts.push(
      panel(
        "Recovery between games",
        `${ins.recovery.length} breaks measured`,
        figure("Heart-rate drop in the first 60 seconds of rest", "Higher is faster recovery", chartBox(recoveryChart(ins.recovery))),
      ),
    );
  }
  return h(
    "section",
    { class: "section" },
    h("h2", { class: "title-large section-title", text: "Squash rally analysis" }),
    h("p", {
      class: "body-medium muted",
      style: "margin:0 4px 12px",
      text: `From your ${logged} match${logged === 1 ? "" : "es"} with a point-by-point log. Matches you score live here are added; ones logged with final scores only aren't.`,
    }),
    parts,
  );
}

function howItWorks() {
  return h(
    "section",
    { class: "section" },
    panel(
      "How these numbers work",
      "Zones, load, effort, training load and the rally analysis",
      h("p", { class: "body-medium" }, h("b", { text: "Heart-rate zones " }), "are shares of your max heart rate: zone 1 from 50%, then 60, 70, 80 and 90%. Your max is the highest seen in your matches unless you set it in Settings."),
      h("p", { class: "body-medium" }, h("b", { text: "Load " }), "counts each minute by zone (1 point in zone 1 up to 5 in zone 5), so a long easy round and a short brutal match can be compared."),
      h("p", { class: "body-medium" }, h("b", { text: "Effort " }), "is heartbeats above your resting rate. Effort per point (squash) or per game (padel) won shows how much each win cost; lower is more efficient."),
      h("p", { class: "body-medium" }, h("b", { text: "Training load " }), "compares the last 7 days' load with your usual week (last 28 days ÷ 4). 0.8–1.3 is the sweet spot; above 1.5 is a spike, when overuse injuries are most likely."),
      h("p", { class: "body-medium" }, h("b", { text: "Felt vs heart rate " }), "multiplies how hard it felt (1–10) by the minutes played and compares that with the heart-rate load. Feeling much harder than usual for the same load often means tiredness, poor sleep or illness."),
      h("p", { class: "body-medium" }, h("b", { text: "Match times " }), "come from the Fitbit workout you pick when logging (exact), otherwise from the time you type."),
      h(
        "p",
        { class: "body-medium" },
        h("b", { text: "Rally analysis " }),
        "compares each situation with what the same games would give if the situation made no difference (rallies reshuffled within each game, 200 times). A finding is called clear only when it would rarely happen by chance (p < 0.05); expect about one clear finding in twenty to be a fluke.",
      ),
    ),
  );
}
