// Matches: the list, and one match in detail.

PAGES.matches = () => {
  const sport = currentSport();
  const list = matchesFor(sport);
  const groups = [];
  for (const m of list) {
    const label = dfMonth.format(m.startedAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(m);
    else groups.push([label, [m]]);
  }
  return {
    title: "Matches",
    actions: [syncButton()],
    body: [
      sportChips(sport, (v) => {
        prefs.set("sport", v);
        render();
      }),
      list.length
        ? groups.map(([label, items]) => [
            h("h2", { class: "title-small muted list-group", text: `${label} · ${items.length}` }),
            h("div", { class: "list-card" }, items.map(matchItem)),
          ])
        : [h("div", { style: "height:12px" }), emptyMatches(sport)],
    ],
  };
};

function matchItem(m) {
  const sp = sportOf(m.sport);
  const note = S.notes[m.id];
  const sub = [relDay(m.startedAt), m.minutes != null ? duration(m.minutes) : null].filter(Boolean).join(" · ");
  return h(
    "a",
    { class: "list-item", href: href("match", m.id) },
    h("span", { class: `li-lead ${resultClass(m)}` }, icon(sp.icon)),
    h(
      "div",
      { class: "li-body" },
      h("div", { class: "li-head", text: matchTitle(m) }),
      h(
        "div",
        { class: "li-sub body-medium" },
        sub,
        m.hr ? [h("span", { text: " ·" }), icon("favorite", "fill"), `${Math.round(m.hr.avg)}`] : null,
        note ? [h("span", { text: " ·" }), icon("chat_bubble")] : null,
      ),
    ),
    h("div", { class: "li-trail" }, h("span", { class: "score", text: scoreShort(m) }), resultBadge(m)),
  );
}

PAGES.match = (r) => {
  const m = matchById(r.id);
  if (!m) return notFoundView("That match isn't in your journal.");
  const sp = sportOf(m.sport);
  const editable = HOSTED && Boolean(S.entries[m.id]);
  return {
    back: previousHash.startsWith("#/match") ? "#/matches" : previousHash,
    title: matchTitle(m),
    subtitle: `${sp.label} · ${dfDay.format(m.startedAt)}, ${dfTime.format(m.startedAt)}`,
    nav: "matches",
    fab: false,
    actions: editable ? [iconButton("edit", "Edit match", () => go("log", m.id)), iconButton("delete", "Delete match", () => deleteMatch(m))] : [],
    body: [
      h(
        "div",
        { class: "grid" },
        heroCard(m),
        statsCard(m),
        chartCard(m),
        m.hr ? zonesCard(m) : null,
        efficiencyCard(m),
        feelCard(m),
        HOSTED
          ? aiCard({
              key: `match:${m.id}`,
              request: { scope: "match", id: m.id },
              title: "AI coach",
              blurb: "A short read on this match against your usual numbers, with one thing to try next time.",
            })
          : null,
        readinessCard(m),
        rallyCard(m),
        sourceNote(m),
      ),
    ],
  };
};

function heroCard(m) {
  const golf = m.sport === "golf";
  const win = m.result === "win";
  const label = golf ? (m.strokes ? `${m.strokes.holes} holes · par ${m.strokes.par}` : "Round") : win ? "You won" : m.result === "loss" ? "You lost" : "Level";
  return h(
    "div",
    { class: `card ${win || golf ? "accent" : "tonal"} wide` },
    h(
      "div",
      { class: "row", style: "align-items:flex-start;justify-content:space-between" },
      h(
        "div",
        {},
        h("div", { class: "label-large", text: label }),
        h("div", { class: "big-number", text: scoreShort(m) }),
        golf && m.strokes ? h("div", { class: "title-medium", text: `${overPar(m)} ${m.strokes.strokes === m.strokes.par ? "(level par)" : "vs par"}` }) : null,
      ),
      h("span", { class: "li-lead", style: "width:48px;height:48px;background:rgba(0,0,0,0.08);color:inherit" }, icon(sportOf(m.sport).icon)),
    ),
    m.score.length
      ? h(
          "div",
          { class: "score-chips", style: "margin-top:12px" },
          m.score.map(([a, b], i) => h("span", { class: `score-chip${a > b ? " won" : ""}`, title: `${sportOf(m.sport).part} ${i + 1}`, text: `${a}–${b}` })),
        )
      : null,
    golf && m.strokes && m.strokes.perHole
      ? h(
          "div",
          { class: "score-chips", style: "margin-top:12px" },
          m.strokes.perHole.map((v, i) => h("span", { class: "score-chip", title: `Hole ${i + 1}`, text: `${i + 1}: ${v == null ? "–" : v}` })),
        )
      : null,
    m.tally
      ? h("p", { class: "body-medium muted", style: "margin-top:12px", text: `${m.tally.won} ${m.tally.unit}s won, ${m.tally.lost} lost${m.tally.unit === "point" ? " (rallies)" : ""}.` })
      : null,
  );
}

function compareNode(value, usual, unit = "") {
  if (value == null || usual == null || !usual) return null;
  const d = (value - usual) / usual;
  if (Math.abs(d) < 0.03) return h("span", { class: "delta" }, icon("trending_flat"), "about usual");
  return h("span", { class: "delta" }, icon(d > 0 ? "trending_up" : "trending_down"), `${Math.abs(Math.round(d * 100))}% ${d > 0 ? "above" : "below"} usual${unit}`);
}

function statsCard(m) {
  const u = (S.data.summaries[m.sport] || {}).avg || {};
  return h(
    "div",
    { class: "card wide" },
    h(
      "div",
      { class: "stats four" },
      stat("Played", duration(m.minutes), null, compareNode(m.minutes, u.minutes), "timer"),
      stat("Avg heart rate", m.hr ? int(m.hr.avg) : "–", m.hr ? "bpm" : null, m.hr ? `max ${m.hr.max}` : null, "favorite"),
      stat("Steps", m.steps ? int(m.steps.total) : "–", null, m.steps ? `${one(m.steps.perMin)} a minute` : null, "steps"),
      stat("Load", m.hr && m.hr.load != null ? int(m.hr.load) : "–", null, m.hr ? compareNode(m.hr.load, u.load) : null, "bolt"),
    ),
    m.calories ? h("p", { class: "body-small muted", style: "margin-top:12px", text: `${int(m.calories)} kcal by your watch.` }) : null,
  );
}

const BASIS = {
  measured: "Game times come from per-point timestamps.",
  "per-game-recordings": "Game times come from your separate watch workout for each game.",
  "watch-pauses": "Game times come from your watch pauses between games.",
  "heart-rate": "Games are placed from the heart-rate dips during the rests between them.",
  proportional: "Games are spread over the match by their scores, with a short rest between each.",
  "recording-window": "Placed using your watch workout only, so timing is rough.",
};

function chartCard(m) {
  const has = m.chart && (m.chart.hr.length > 1 || m.chart.steps.length > 0);
  if (!has) {
    return h(
      "div",
      { class: "card wide" },
      cardHead("Heart rate & steps", "monitor_heart"),
      h("p", {
        class: "body-medium muted",
        text: HOSTED
          ? "No watch data for this match yet. If your Fitbit was on, wait for it to upload to the Fitbit app, then sync."
          : "No watch data for this match.",
      }),
      HOSTED && S.google && S.google.connected
        ? h("div", { class: "card-foot" }, h("button", { class: "btn tonal", type: "button", disabled: syncing, onclick: () => syncNow() }, icon("sync"), "Sync now"))
        : null,
    );
  }
  const keys = [];
  if (m.chart.hr.length > 1) keys.push(["line", "var(--c-hr)", "Heart rate"]);
  if (m.chart.steps.length) keys.push(["swatch", "var(--c-steps)", "Steps per minute"]);
  keys.push(["swatch", "var(--rest)", m.chart.rests.length ? "Rest, warm-up, cool-down" : "Before and after"]);
  return h(
    "div",
    { class: "card wide" },
    cardHead("Heart rate & steps", "monitor_heart"),
    chartBox(effortChart(m)),
    legend(keys),
    m.timing ? h("p", { class: "body-small muted", style: "margin-top:8px", text: BASIS[m.timing.basis] || "" }) : null,
  );
}

function zonesCard(m) {
  const u = (S.data.summaries[m.sport] || {}).avg || {};
  const hard = m.hr.zones[3] + m.hr.zones[4];
  const names = ["very light", "light", "moderate", "hard", "max"];
  const top = m.hr.zones.indexOf(Math.max(...m.hr.zones));
  const lead = hard >= 60 ? `${duration(hard / 60)} hard or harder (zones 4–5).` : `Mostly zone ${top + 1} (${names[top]}).`;
  return h(
    "div",
    { class: "card half" },
    cardHead("Heart-rate zones", "favorite"),
    zoneBar(m.hr.zones),
    h("p", { class: "body-small muted", style: "margin-top:6px", text: "Z1 very light · Z2 light · Z3 moderate · Z4 hard · Z5 max" }),
    h(
      "p",
      { class: "body-medium", style: "margin-top:14px" },
      `${lead} Load ${m.hr.load ?? "–"}`,
      u.load != null ? h("span", { class: "muted", text: ` · your usual ${sportOf(m.sport).label.toLowerCase()} match is ${u.load}` }) : null,
      ".",
    ),
    S.data.hrMax
      ? h("p", { class: "body-small muted", style: "margin-top:6px", text: `Zones are shares of your max heart rate, ${S.data.hrMax} bpm${S.data.hrMaxSource === "observed" ? " (the highest seen in your matches)" : ""}.` })
      : null,
  );
}

function efficiencyCard(m) {
  const e = m.efficiency;
  if (!e) return null;
  const u = (S.data.summaries[m.sport] || {}).avg || {};
  const unit = e.unit;
  const rows = [];
  if (e.beatsPerUnit != null) {
    rows.push(
      effRow(
        unit === "hole" ? "Effort per hole" : `Effort per ${unit} won`,
        one(e.beatsPerUnit),
        "beats",
        u.beatsPerUnit,
        e.beatsPerUnit,
        unit === "hole" ? null : true,
        unit === "hole" ? "Heartbeats above resting for each hole." : `Heartbeats above resting for each ${unit} you won. Lower means you won them more cheaply.`,
      ),
    );
  }
  if (e.stepsPerUnit != null) {
    rows.push(
      effRow(
        unit === "point" ? "Steps per rally" : `Steps per ${unit}`,
        one(e.stepsPerUnit),
        "steps",
        u.stepsPerUnit,
        e.stepsPerUnit,
        null,
        unit === "point" ? "How much you moved for each rally played." : unit === "game" ? "How much you moved for each game played." : "Walking per hole.",
      ),
    );
  }
  if (e.beatsPerStep != null) {
    rows.push(
      effRow("Effort per step", two(e.beatsPerStep), "beats", u.beatsPerStep, e.beatsPerStep, true, "What each step cost your heart. Falling over the weeks means fitter, more economical movement."),
    );
  }
  const assumed = m.restingHr && m.restingHr.source !== "day";
  return h(
    "div",
    { class: "card half" },
    cardHead("Efficiency", "speed"),
    h("div", { class: "stack", style: "gap:18px" }, rows),
    assumed
      ? h("p", {
          class: "body-small muted",
          style: "margin-top:14px",
          text:
            m.restingHr.source === "typical"
              ? `Effort uses your usual resting heart rate (${m.restingHr.bpm} bpm); the watch had none for that day.`
              : `Effort assumes a resting heart rate of ${m.restingHr.bpm} bpm until your watch provides one.`,
        })
      : null,
  );
}

function effRow(label, value, unit, usual, current, lowerIsBetter, help) {
  let delta = null;
  if (usual != null && current != null && usual > 0) {
    const d = (current - usual) / usual;
    const flat = Math.abs(d) < 0.03;
    const good = lowerIsBetter == null || flat ? null : lowerIsBetter ? d < 0 : d > 0;
    delta = h(
      "span",
      { class: `delta${good == null ? "" : good ? " good" : " bad"}` },
      icon(flat ? "trending_flat" : d > 0 ? "trending_up" : "trending_down"),
      flat ? `about usual (${usual})` : `${Math.abs(Math.round(d * 100))}% ${d > 0 ? "above" : "below"} your usual ${usual}`,
    );
  }
  return h(
    "div",
    {},
    h(
      "div",
      { class: "row", style: "justify-content:space-between;align-items:baseline" },
      h("span", { class: "title-small", text: label }),
      h("span", { class: "stat-value", style: "font-size:22px;line-height:28px" }, value, h("span", { class: "unit", text: unit })),
    ),
    delta,
    h("p", { class: "body-small muted", style: "margin-top:2px", text: help }),
  );
}

function rpeWord(v) {
  return v <= 2 ? "Very easy" : v <= 4 ? "Easy" : v <= 6 ? "Moderate" : v <= 8 ? "Hard" : v === 9 ? "Very hard" : "All-out";
}

/** "How hard was it?" 1-10, unset until touched. */
function rpeInput(value, onChange) {
  const out = h("span", { class: "title-large num" });
  const word = h("span", { class: "body-medium muted" });
  const range = h("input", { type: "range", min: "1", max: "10", step: "1", value: String(value ?? 5), "aria-label": "How hard it felt, from 1 to 10" });
  let set = value != null;
  const show = () => {
    out.textContent = set ? `${range.value}/10` : "–";
    word.textContent = set ? rpeWord(Number(range.value)) : "Not rated: tap or drag";
    range.style.opacity = set ? "1" : "0.5";
  };
  const touch = () => {
    set = true;
    onChange(Number(range.value));
    show();
  };
  range.addEventListener("input", touch);
  range.addEventListener("change", touch);
  const clear = h("button", {
    class: "btn text small",
    type: "button",
    text: "Clear",
    onclick: () => {
      set = false;
      onChange(null);
      show();
    },
  });
  show();
  return h(
    "div",
    {},
    h("div", { class: "row", style: "justify-content:space-between" }, h("span", { class: "title-small", text: "How hard was it?" }), clear),
    h("div", { class: "rpe-value" }, out, word),
    range,
    h("div", { class: "rpe-scale" }, h("span", { text: "1 · very easy" }), h("span", { text: "10 · all-out" })),
  );
}

function feelCard(m) {
  const card = h("div", { class: "card half" });
  let editing = false;
  const paint = () => {
    const note = S.notes[m.id];
    if (editing) {
      let rpe = note ? note.rpe : null;
      const area = h("textarea", { rows: "4", maxlength: "2000", placeholder: "How did you feel? Energy, nerves, what worked, what didn't…", value: note ? note.text : "" });
      const save = h("button", {
        class: "btn filled",
        type: "button",
        text: "Save",
        onclick: async () => {
          save.disabled = true;
          const res = await api(`/api/notes/${encodeURIComponent(m.id)}`, "PUT", { text: area.value, rpe });
          save.disabled = false;
          if (!res.ok) {
            snack(res.message);
            return;
          }
          S.notes = res.notes;
          editing = false;
          paint();
          snack("Saved.");
        },
      });
      fill(card, 
        cardHead("How it felt", "edit_note"),
        rpeInput(rpe, (v) => (rpe = v)),
        h("div", { style: "height:20px" }),
        field("Comment", area),
        h(
          "div",
          { class: "card-foot", style: "justify-content:flex-end" },
          h("button", {
            class: "btn text",
            type: "button",
            text: "Cancel",
            onclick: () => {
              editing = false;
              paint();
            },
          }),
          save,
        ),
      );
      area.focus();
      return;
    }
    const start = () => {
      editing = true;
      paint();
    };
    fill(card, 
      cardHead("How it felt", "edit_note", HOSTED && note ? iconButton("edit", "Edit how it felt", start) : null),
      note
        ? [
            note.rpe != null
              ? h("div", { class: "rpe-value" }, h("span", { class: "stat-value", text: `${note.rpe}` }), h("span", { class: "body-medium muted", text: `/10 · ${rpeWord(note.rpe)}` }))
              : null,
            note.text ? h("p", { class: "body-large", style: "margin-top:6px;white-space:pre-wrap", text: note.text }) : null,
          ]
        : h("p", {
            class: "body-medium muted",
            text: HOSTED ? "How hard it felt and a few words make patterns (and the AI coach) far more useful." : "No notes for this match.",
          }),
      !note && HOSTED ? h("div", { class: "card-foot" }, h("button", { class: "btn tonal", type: "button", onclick: start }, icon("edit_note"), "Add how it felt")) : null,
    );
  };
  paint();
  return card;
}

function readinessCard(m) {
  const d = m.daily;
  if (!d || (d.sleepMinutes == null && d.restingHr == null && d.hrvMs == null)) return null;
  return h(
    "div",
    { class: "card half" },
    cardHead("That day", "bedtime"),
    h(
      "div",
      { class: "stats" },
      d.sleepMinutes != null ? stat("Sleep the night before", sleepText(d.sleepMinutes)) : null,
      d.restingHr != null ? stat("Resting heart rate", int(d.restingHr), "bpm") : null,
      d.hrvMs != null ? stat("Heart-rate variability", int(d.hrvMs), "ms") : null,
    ),
  );
}

function rallyCard(m) {
  if (!m.rallies) return null;
  const sv = (S.data.sessions || []).find((x) => x.id === m.id);
  if (!sv || !sv.rallies.length) return null;
  const keys = [
    ["swatch", "color-mix(in srgb, var(--c-win-fill) 40%, transparent)", "You ahead"],
    ["swatch", "color-mix(in srgb, var(--c-loss-fill) 40%, transparent)", "You behind"],
    ["dot", "var(--md-on-surface)", "High-stakes rally"],
  ];
  if (sv.align) keys.unshift(["line", "var(--c-hr)", "Heart rate"]);
  const panelEl = h(
    "details",
    { class: "panel wide" },
    h(
      "summary",
      {},
      icon("scoreboard"),
      h("div", { class: "li-body" }, h("div", { class: "title-medium", text: "Rally by rally" }), h("div", { class: "body-small muted", text: "Score, pressure and heart rate through the match" })),
      icon("expand_more", "chev"),
    ),
    h("div", { class: "panel-body" }, chartBox(timelineChart(sv, m)), legend(keys)),
  );
  panelEl.addEventListener("toggle", () => panelEl.open && mountCharts());
  return panelEl;
}

function sourceNote(m) {
  const bits = [m.source === "journal" ? "Logged in the app." : "Imported from the Club Squash League app."];
  if (m.hr) bits.push(`Heart rate covers ${Math.round(m.hr.coverage * 100)}% of the match.`);
  return h("p", { class: "body-small muted wide", style: "padding:4px 8px 8px", text: bits.join(" ") });
}

async function deleteMatch(m) {
  const ok = await confirmDialog({
    title: "Delete this match?",
    text: "Its score, notes and AI read are removed. Your watch data stays in Google Health.",
    confirm: "Delete",
    danger: true,
  });
  if (!ok) return;
  const res = await api(`/api/matches/${encodeURIComponent(m.id)}`, "DELETE");
  if (!res.ok) {
    snack(res.message);
    return;
  }
  S = res.state;
  location.replace(href("matches"));
  snack("Match deleted.");
}
