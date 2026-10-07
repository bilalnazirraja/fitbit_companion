// Home: the last match, your record, the AI coach, effort per match and this month, nothing more.

PAGES.home = () => {
  const sport = currentSport();
  const list = matchesFor(sport);
  return {
    brand: true,
    actions: [syncButton(), avatarButton()],
    fab: "extended",
    body: [
      h(
        "div",
        { class: "page-head" },
        h("h1", { class: "headline-medium", text: greeting() }),
        h("p", { class: "body-medium muted", text: dfLong.format(Date.now()) }),
      ),
      setupCards(),
      sportChips(sport, (v) => {
        prefs.set("sport", v);
        render();
      }),
      h("div", { style: "height:12px" }),
      list.length ? homeGrid(sport, list, S.data.summaries[sport]) : emptyMatches(sport),
    ],
  };
};

function greeting() {
  const hour = new Date().getHours();
  const part = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 17 ? "Good afternoon" : "Good evening";
  return S.name ? `${part}, ${S.name}` : part;
}

function setupCards() {
  const cards = [];
  if (S.data.demo) {
    cards.push(
      h(
        "div",
        { class: "card tonal" },
        h(
          "div",
          { class: "banner" },
          icon("info"),
          h("p", { class: "body-medium", text: "Demo: the scores are real, the heart rate is simulated so you can preview the app. Patterns here mean nothing." }),
        ),
      ),
    );
  }
  if (EDIT && S.league && !S.league.me && !S.league.locked && S.league.players.length) {
    cards.push(
      h(
        "div",
        { class: "card accent" },
        h(
          "div",
          { class: "banner" },
          icon("person"),
          h(
            "div",
            {},
            h("h2", { class: "title-medium", text: "Which player are you?" }),
            h("p", { class: "body-medium muted", text: "Your squash league history is imported. Pick yourself and only your matches are kept." }),
          ),
        ),
        h(
          "div",
          { class: "row wrap", style: "margin-top:12px" },
          S.league.players.map((p) => h("button", { class: "chip", type: "button", text: p, onclick: () => chooseLeaguePlayer(p) })),
        ),
      ),
    );
  }
  if (EDIT && S.google && S.google.configured && !S.google.connected) {
    cards.push(
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "banner" },
          icon("watch"),
          h(
            "div",
            { class: "stack", style: "gap:8px" },
            h("h2", { class: "title-medium", text: "Connect your Fitbit" }),
            h("p", { class: "body-medium muted", text: "Heart rate comes from Google Health. Connect once and every match gets its effort data." }),
            h("div", {}, h("a", { class: "btn filled", href: "/connect" }, icon("link"), "Connect Google Health")),
          ),
        ),
      ),
    );
  }
  return cards.length ? h("div", { class: "stack", style: "margin-bottom:16px" }, cards) : null;
}

async function chooseLeaguePlayer(name) {
  const res = await api("/me", "POST", { me: name });
  if (!res.ok) {
    snack(res.message);
    return;
  }
  S = res.state;
  render();
  snack(res.message);
}

function emptyMatches(sport) {
  const sp = sport === "all" ? null : sportOf(sport);
  return h(
    "div",
    { class: "card empty" },
    icon(sp ? sp.icon : "scoreboard"),
    h("p", { class: "title-medium", text: sp ? `No ${sp.label.toLowerCase()} matches yet` : "No matches yet" }),
    h("p", {
      class: "body-medium",
      text: EDIT ? "Log a match after you play. Your Fitbit fills in the heart rate." : "Matches appear here once they're synced.",
    }),
    EDIT ? h("a", { class: "btn filled", href: href("log") }, icon("add"), "Log a match") : null,
  );
}

function homeGrid(sport, list, sum) {
  return h(
    "div",
    { class: "grid" },
    lastMatchCard(list[0]),
    sport === "golf" ? golfCard(list, sum) : recordCard(sport, sum),
    HOSTED && S.ai && (S.ai.configured || EDIT)
      ? aiCard({
          key: `overview:${sport}`,
          request: { scope: "overview", sport },
          title: "Coach's read",
          blurb: `A short read on your last ${Math.min(10, list.length)} ${sport === "all" ? "" : `${sportOf(sport).label.toLowerCase()} `}matches: form, effort and one thing to try.`,
        })
      : null,
    effortCard(list),
    trainingLoadCard(),
    monthCard(list),
  );
}

function metricBits(m) {
  return [
    m.minutes != null ? h("span", { class: "metric" }, icon("timer"), duration(m.minutes)) : null,
    m.hr ? h("span", { class: "metric hr" }, icon("favorite", "fill"), `${Math.round(m.hr.avg)} bpm`) : null,
    m.hr && m.hr.load != null ? h("span", { class: "metric load" }, icon("bolt", "fill"), `load ${m.hr.load}`) : null,
  ];
}

function resultWord(m) {
  if (m.sport === "golf") return m.strokes ? `${overPar(m)} · par ${m.strokes.par}` : "Golf";
  return m.result === "win" ? "Won" : m.result === "loss" ? "Lost" : "Draw";
}

function lastMatchCard(m) {
  const sp = sportOf(m.sport);
  return h(
    "a",
    { class: "card accent link half", href: href("match", m.id), "aria-label": `Last match: ${matchTitle(m)}, ${resultWord(m)} ${scoreShort(m)}` },
    h("div", { class: "card-head" }, icon(sp.icon), h("h2", { class: "title-medium", text: "Last match" }), h("span", { class: "label-medium muted", text: relDay(m.startedAt) })),
    h(
      "div",
      { class: "row", style: "align-items:flex-end;gap:16px" },
      h("div", { class: "big-number", text: scoreShort(m) }),
      h(
        "div",
        { style: "padding-bottom:8px;min-width:0" },
        h("div", { class: "title-medium", style: "white-space:nowrap;overflow:hidden;text-overflow:ellipsis", text: matchTitle(m) }),
        h("div", { class: "body-medium muted", text: resultWord(m) }),
      ),
    ),
    m.score.length
      ? h("div", { class: "score-chips", style: "margin-top:10px" }, m.score.map(([a, b]) => h("span", { class: `score-chip${a > b ? " won" : ""}`, text: `${a}–${b}` })))
      : null,
    h("div", { class: "metric-row", style: "margin-top:14px" }, metricBits(m)),
  );
}

function recordCard(sport, sum) {
  const decided = sum.wins + sum.losses;
  const rate = decided ? sum.wins / decided : null;
  const sp = sport === "all" ? null : sportOf(sport);
  return h(
    "div",
    { class: "card half" },
    cardHead("Record", "emoji_events"),
    h(
      "div",
      { class: "row", style: "gap:20px" },
      ring(rate, 96, `Won ${pct(rate)} of decided matches`),
      h(
        "div",
        { class: "stack", style: "gap:12px;min-width:0" },
        h("div", {}, h("div", { class: "title-large num", text: `${sum.wins}–${sum.losses}` }), h("div", { class: "body-small muted", text: "won – lost" })),
        sum.form.length
          ? h(
              "div",
              {},
              h("div", { class: "label-medium muted", style: "margin-bottom:6px", text: "Last 5" }),
              h(
                "div",
                { class: "form-dots" },
                sum.form.slice(0, 5).map((r) => h("span", { class: `form-dot ${r}`, text: r })),
              ),
            )
          : null,
      ),
    ),
    sp && sum.avg.unitShare != null
      ? h("p", { class: "body-small muted", style: "margin-top:12px", text: `You win ${pct(sum.avg.unitShare)} of the ${sp.unit}s you play.` })
      : null,
  );
}

function golfCard(list, sum) {
  const rounds = list.filter((m) => m.strokes);
  const best = rounds.length ? rounds.reduce((a, m) => (m.strokes.strokes - m.strokes.par < a.strokes.strokes - a.strokes.par ? m : a)) : null;
  return h(
    "div",
    { class: "card half" },
    cardHead("Scoring", "flag"),
    h(
      "div",
      { class: "stats" },
      stat("Average", sum.avg.strokes != null ? one(sum.avg.strokes) : "–", null, sum.avg.overPar != null ? `${signed(sum.avg.overPar)} vs par` : null),
      stat("Best round", best ? String(best.strokes.strokes) : "–", null, best ? `${overPar(best)} · ${dfDate.format(best.startedAt)}` : null),
    ),
    rounds.length
      ? h(
          "div",
          { class: "form-dots", style: "margin-top:14px" },
          rounds.slice(0, 5).map((m) => h("span", { class: "form-dot", style: "width:auto;padding:0 8px;border-radius:16px", text: String(m.strokes.strokes) })),
        )
      : null,
  );
}

function effortCard(list) {
  const recent = list.slice(0, 12).reverse();
  const loads = recent.filter((m) => m.hr && m.hr.load != null).map((m) => m.hr.load);
  if (!loads.length) {
    return h(
      "div",
      { class: "card half" },
      cardHead("Effort per match", "bolt"),
      h("p", { class: "body-medium muted", text: EDIT ? "Effort shows once your matches have heart rate. Sync after your Fitbit has uploaded." : "No heart-rate data yet." }),
    );
  }
  const avg = mean(loads);
  return h(
    "div",
    { class: "card half" },
    cardHead("Effort per match", "bolt", h("span", { class: "label-medium muted", text: `avg load ${int(avg)}` })),
    chartBox(
      barsChart(
        recent.map((m) => ({
          v: m.hr && m.hr.load != null ? m.hr.load : null,
          color: m.result === "win" ? "var(--c-win-fill)" : m.result === "loss" ? "var(--c-loss-fill)" : "var(--c-blue)",
          label: `${dfDate.format(m.startedAt)}, ${matchTitle(m)}: load ${m.hr ? m.hr.load : "unknown"}`,
          tip: () => [
            { head: `${dfDay.format(m.startedAt)} · ${matchTitle(m)}` },
            { value: String(m.hr.load), label: "load (zone-weighted minutes)", key: "var(--c-load)" },
            { value: `${Math.round(m.hr.avg)} bpm`, label: "average heart rate", key: "var(--c-hr)" },
            { value: duration(m.minutes), label: "played" },
          ],
          onClick: () => go("match", m.id),
        })),
        { aria: "Effort per match, oldest to newest", avg, height: 136 },
      ),
    ),
    legend([
      ["dot", "var(--c-win-fill)", "Won"],
      ["dot", "var(--c-loss-fill)", "Lost"],
      ["line", "var(--md-on-surface-variant)", "Your average"],
    ]),
  );
}

function monthCard(list) {
  const month = list.filter((m) => m.startedAt >= Date.now() - 30 * 86_400_000);
  const minutes = month.reduce((a, m) => a + (m.minutes || 0), 0);
  const load = month.reduce((a, m) => a + (m.hr && m.hr.load ? m.hr.load : 0), 0);
  const won = month.filter((m) => m.result === "win").length;
  const hrs = month.filter((m) => m.hr).map((m) => m.hr.avg);
  return h(
    "div",
    { class: "card half" },
    cardHead("Last 30 days", "calendar_month"),
    h(
      "div",
      { class: "stats" },
      stat("Matches", String(month.length), null, won ? `${won} won` : null),
      stat("Time played", duration(minutes)),
      stat("Total load", int(load)),
      stat("Avg heart rate", hrs.length ? int(mean(hrs)) : "–", hrs.length ? "bpm" : null),
    ),
  );
}

function stat(label, value, unit, sub, iconName) {
  return h(
    "div",
    { class: "stat" },
    h("span", { class: "stat-label" }, iconName ? icon(iconName) : null, label),
    h("span", { class: "stat-value" }, value, unit ? h("span", { class: "unit", text: unit }) : null),
    sub ? (typeof sub === "string" ? h("span", { class: "body-small muted", text: sub }) : sub) : null,
  );
}

// ---------- AI coach ----------
function modelLabel(id) {
  const m = S.ai && S.ai.models.find((x) => x.id === id);
  return m ? m.label : id;
}
function answerCost(model) {
  return (700 * model.input + 500 * model.output) / 1e6;
}
function usageBar(u, compact) {
  const share = u.budgetUsd > 0 ? u.month.costUsd / u.budgetUsd : u.month.costUsd > 0 ? 1 : 0;
  const cls = share >= 0.9 ? " over" : share >= 0.7 ? " warn" : "";
  return h(
    "div",
    { style: compact ? "margin-top:16px" : "" },
    h(
      "div",
      { class: "usage-line" },
      h("span", { class: compact ? "label-medium muted" : "title-small", text: compact ? "AI used this month" : "Used this month" }),
      h("span", { class: `${compact ? "label-medium" : "body-medium"} num`, text: `${money(u.month.costUsd)} of ${money(u.budgetUsd)}` }),
    ),
    h(
      "div",
      { class: `progress${cls}`, role: "progressbar", "aria-label": "AI budget used this month", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(Math.min(1, share) * 100)) },
      h("i", { style: `width:${Math.min(100, share * 100)}%` }),
    ),
  );
}

/** A coach's read from the AI: asked on request only, saved, and never re-bought for unchanged data. */
function aiCard({ key, request, title, blurb, cls = "half" }) {
  const card = h("div", { class: `card spot ${cls}` });
  let busy = false;
  let error = null;
  async function run() {
    if (busy) return;
    busy = true;
    error = null;
    paint();
    const res = await api("/api/ai", "POST", request);
    busy = false;
    if (res.usage) S.ai.usage = res.usage;
    if (res.ok) {
      S.ai.insights[key] = res.insight;
      if (res.cached) snack("Nothing has changed since the last answer, so nothing was spent.");
    } else {
      error = res.message;
    }
    paint();
  }
  function paint() {
    const ai = S.ai;
    const saved = ai && ai.insights[key];
    const model = ai && ai.models.find((m) => m.id === ai.usage.model);
    const parts = [cardHead(title, "auto_awesome", saved && EDIT && ai.configured && !busy ? iconButton("refresh", "Ask again", run) : null)];
    if (saved && !EDIT) {
      parts.push(h("p", { class: "ai-text", text: saved.text }), h("p", { class: "ai-meta muted", text: `${modelLabel(saved.model)} · ${dfStamp.format(saved.at)}` }));
    } else if (!EDIT) {
      parts.push(h("p", { class: "body-medium muted", text: "No AI read for this yet." }));
    } else if (!ai || !ai.configured) {
      parts.push(
        h("p", { class: "body-medium muted", text: "Add your OpenAI key and get a short coach's read on your matches, for a fraction of a cent each." }),
        h("div", { class: "card-foot" }, h("a", { class: "btn outlined", href: href("settings") }, "Set it up")),
      );
    } else if (busy) {
      parts.push(
        h("div", { class: "progress indeterminate", role: "progressbar", "aria-label": "Waiting for the AI" }, h("i")),
        h("p", { class: "body-medium muted", style: "margin-top:12px", text: "Reading your numbers…" }),
      );
    } else if (saved) {
      parts.push(
        h("p", { class: "ai-text", text: saved.text }),
        h("p", { class: "ai-meta muted", text: `${modelLabel(saved.model)} · ${dfStamp.format(saved.at)} · ${money(saved.costUsd)}${saved.complete ? "" : " · cut short"}` }),
      );
    } else {
      parts.push(
        h("p", { class: "body-medium muted", text: blurb }),
        h(
          "div",
          { class: "card-foot" },
          h("button", { class: "btn filled", type: "button", onclick: run }, icon("auto_awesome"), "Get insight"),
          model ? h("span", { class: "body-small muted", text: `≈ ${money(answerCost(model))}` }) : null,
        ),
      );
    }
    if (error) parts.push(h("p", { class: "body-small", role: "alert", style: "margin-top:10px;color:var(--c-loss-fill)", text: error }));
    if (EDIT && ai && ai.configured) parts.push(usageBar(ai.usage, true));
    fill(card, ...parts);
  }
  paint();
  return card;
}

/**
 * Acute:chronic load: the last 7 days against your weekly average over the last 28. Around 0.8-1.3
 * is the usual sweet spot; a jump past 1.5 is when overuse injuries tend to follow.
 */
function trainingLoadCard() {
  const now = Date.now();
  const sum = (days) => allMatches().filter((m) => m.hr && m.hr.load && m.startedAt >= now - days * 86_400_000).reduce((a, m) => a + m.hr.load, 0);
  const acute = sum(7);
  const chronic = sum(28) / 4;
  const card = h("div", { class: "card half" }, cardHead("Training load", "bolt"));
  if (!chronic) {
    card.append(h("p", { class: "body-medium muted", text: "Needs a few weeks of matches with heart rate. Compares this week's load with your usual week." }));
    return card;
  }
  const ratio = acute / chronic;
  const [label, note, cls] =
    ratio > 1.5
      ? ["Spike", "Much more than your usual week. Injury risk rises: take an easier day.", "over"]
      : ratio > 1.3
        ? ["Building fast", "Above your usual. Fine for a week, watch for soreness.", "warn"]
        : ratio >= 0.8
          ? ["Sweet spot", "In line with what your body is used to.", ""]
          : ["Light week", "Below your usual: room to push, or a deliberate rest.", ""];
  card.append(
    h("div", { class: "row", style: "align-items:baseline;gap:10px" }, h("span", { class: "stat-value num", text: two(ratio) }), h("span", { class: "title-medium", text: label })),
    h("div", { class: `progress${cls ? ` ${cls}` : ""}`, style: "margin:10px 0", role: "img", "aria-label": `Load ratio ${two(ratio)}` }, h("i", { style: `width:${Math.min(100, (ratio / 2) * 100)}%` })),
    h("p", { class: "body-medium", text: note }),
    h("p", { class: "body-small muted", style: "margin-top:6px", text: `Last 7 days ${int(acute)} · usual week ${int(chronic)} (last 28 days ÷ 4)` }),
  );
  return card;
}
