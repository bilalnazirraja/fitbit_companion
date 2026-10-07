// Live squash scoring: tap who won each point. Every point is timed, so the rally analysis
// (pressure, momentum, heart rate by score) keeps growing. Kept on this device until saved.

const LIVE_KEY = "live";
let live = null;

function loadLive() {
  try {
    return JSON.parse(prefs.get(LIVE_KEY) || "null");
  } catch {
    return null;
  }
}
function storeLive() {
  prefs.set(LIVE_KEY, live ? JSON.stringify(live) : null);
}

/** Games won and the current game's score, replayed from the points (PAR scoring to 11, 2 clear). */
function liveState(l) {
  const games = [[0, 0]];
  const won = [0, 0];
  for (const p of l.points) {
    const g = games[games.length - 1];
    g[p.w === "a" ? 0 : 1]++;
    const [a, b] = g;
    if ((a >= 11 || b >= 11) && Math.abs(a - b) >= 2) {
      won[a > b ? 0 : 1]++;
      games.push([0, 0]);
    }
  }
  const need = Math.ceil(l.bestOf / 2);
  const over = won[0] >= need || won[1] >= need;
  return { games, current: games[games.length - 1], won, over, game: games.length };
}

PAGES.live = () => {
  if (!EDIT) return notFoundView("Sign in to score a match.");
  live = live || loadLive();
  return {
    full: true,
    close: () => {
      location.hash = previousHash || "#/";
    },
    title: live ? `vs ${live.opponent}` : "Score live",
    subtitle: live ? "Squash · live" : null,
    body: [live ? liveBoard() : liveSetup()],
  };
};

function liveSetup() {
  let bestOf = 3;
  const opp = h("input", { type: "text", list: "people", autocomplete: "off", autocapitalize: "words", maxlength: "40" });
  const seg = h("div", { class: "segmented", role: "group", "aria-label": "Match length" });
  const paintSeg = () =>
    fill(
      seg,
      [3, 5].map((n) =>
        h(
          "button",
          {
            class: "seg-btn",
            type: "button",
            "aria-pressed": String(bestOf === n),
            onclick: () => {
              bestOf = n;
              paintSeg();
            },
          },
          bestOf === n ? icon("check") : null,
          `Best of ${n}`,
        ),
      ),
    );
  paintSeg();
  return h(
    "div",
    { class: "stack" },
    h("p", { class: "body-medium muted", text: "Tap who won each point. Every point is timed, so this match joins the rally analysis. Start your Fitbit workout too." }),
    field("Opponent", opp),
    h("datalist", { id: "people" }, opponentsList().map((n) => h("option", { value: n }))),
    seg,
    h(
      "button",
      {
        class: "btn filled",
        type: "button",
        onclick: () => {
          const name = opp.value.trim();
          if (!name) return snack("Who are you playing?");
          live = { opponent: name, bestOf, startedAt: Date.now(), points: [] };
          storeLive();
          render();
        },
      },
      icon("timer"),
      "Start match",
    ),
  );
}

function liveBoard() {
  const st = liveState(live);
  const me = S.name || "You";
  const point = (w) => {
    if (st.over) return;
    live.points.push({ g: st.game, w, at: Date.now() });
    storeLive();
    render();
  };
  const big = (w, label, score) =>
    h(
      "button",
      { class: `live-btn${w === "a" ? " mine" : ""}`, type: "button", disabled: st.over, onclick: () => point(w), "aria-label": `Point to ${label}` },
      h("span", { class: "live-score num", text: String(score) }),
      h("span", { class: "title-medium", text: label }),
    );
  return h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "row", style: "justify-content:space-between" },
      h("span", { class: "title-medium", text: st.over ? "Match over" : `Game ${st.game}` }),
      h("span", { class: "title-medium num", text: `Games ${st.won[0]}–${st.won[1]}` }),
    ),
    h(
      "div",
      { class: "score-chips" },
      st.games.slice(0, -1).map(([a, b]) => h("span", { class: `score-chip${a > b ? " won" : ""}`, text: `${a}–${b}` })),
    ),
    h("div", { class: "live-grid" }, big("a", me, st.current[0]), big("b", live.opponent, st.current[1])),
    h(
      "div",
      { class: "row wrap" },
      h(
        "button",
        {
          class: "btn outlined",
          type: "button",
          disabled: live.points.length === 0,
          onclick: () => {
            live.points.pop();
            storeLive();
            render();
          },
        },
        icon("refresh"),
        "Undo",
      ),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn text danger",
          type: "button",
          onclick: async () => {
            if (!(await confirmDialog({ title: "Abandon this match?", text: "The points scored so far are thrown away.", confirm: "Abandon", danger: true }))) return;
            live = null;
            storeLive();
            render();
          },
        },
        "Abandon",
      ),
      h("button", { class: "btn filled", type: "button", onclick: finishLive }, icon("check"), "Finish"),
    ),
  );
}

async function finishLive() {
  if (!live.points.length) return snack("Score a point first.");
  const end = Math.max(Date.now(), live.startedAt + 5 * 60_000);
  const res = await api("/api/matches", "POST", {
    sport: "squash",
    startedAt: live.startedAt,
    endedAt: end,
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    opponents: [live.opponent],
    points: live.points,
  });
  if (!res.ok) return snack(res.message, { long: true });
  live = null;
  storeLive();
  S = res.state;
  location.replace(href("match", res.id));
  snack("Saved. Add how it felt below.");
  if (S.google && S.google.connected) syncNow({ quiet: true });
}
