// Log a match: sport, when (a watch workout, or typed), who, the score, and how it felt.
// The form keeps a draft in memory, so leaving and coming back doesn't lose what was typed.

let draft = null;
let draftFor = null;
let formHost = null;
let workoutsHost = null;
let resultHost = null;
let golfHost = null;
let workoutsRequest = 0;
let saving = false;

PAGES.log = (r) => {
  if (!HOSTED) return notFoundView("Logging matches works in the web app.");
  if (r.id && !S.entries[r.id]) return notFoundView("Only matches you logged in the app can be edited.");
  const key = r.id || "";
  if (!draft || draftFor !== key) {
    draft = newDraft(r.id);
    draftFor = key;
  }
  formHost = h("div", { class: "log-form" });
  renderForm();
  return {
    full: true,
    close: closeForm,
    title: r.id ? "Edit match" : "Log a match",
    actions: [h("button", { class: "btn filled small", type: "button", text: "Save", onclick: saveDraft })],
    body: [formHost],
    mounted: () => {
      if (draft && draft.workoutsState === "idle") loadWorkouts();
    },
  };
};

const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const emptyRows = (sport) => Array.from({ length: sport === "padel" ? 2 : 3 }, () => ["", ""]);
const emptyGolf = () => ({ course: "", holes: 18, strokes: "", par: "", perHole: [], showHoles: false });

function newDraft(id) {
  const base = { dirty: false, workouts: [], workoutsState: "idle", workoutsMessage: "" };
  if (id) {
    const e = S.entries[id];
    const note = S.notes[id];
    const g = e.golf;
    const rows = e.scores.map(([a, b]) => [String(a), String(b)]);
    return {
      ...base,
      id,
      sport: e.sport,
      date: dayKey(e.startedAt),
      time: hhmm(new Date(e.startedAt)),
      minutes: String(Math.round((e.endedAt - e.startedAt) / 60_000)),
      workoutId: e.workoutId,
      opponent: e.sport === "squash" ? e.opponents[0] || "" : "",
      partner: e.partner || "",
      opp1: e.sport === "padel" ? e.opponents[0] || "" : "",
      opp2: e.sport === "padel" ? e.opponents[1] || "" : "",
      players: e.sport === "golf" ? e.opponents.join(", ") : "",
      scores: rows.length ? rows : emptyRows(e.sport),
      golf: g
        ? {
            course: g.course || "",
            holes: g.holes,
            strokes: String(g.strokes),
            par: String(g.par),
            perHole: (g.perHole || []).map((v) => (v == null ? "" : String(v))),
            showHoles: Boolean(g.perHole),
          }
        : emptyGolf(),
      rpe: note ? note.rpe : null,
      text: note ? note.text : "",
    };
  }
  const last = prefs.get("lastSport");
  const sport = SPORT[last] ? last : "squash";
  const minutes = SPORT[sport].minutes;
  const start = new Date(Math.floor((Date.now() - minutes * 60_000) / 300_000) * 300_000);
  return {
    ...base,
    id: null,
    sport,
    date: dayKey(start.getTime()),
    time: hhmm(start),
    minutes: String(minutes),
    workoutId: null,
    opponent: "",
    partner: "",
    opp1: "",
    opp2: "",
    players: "",
    scores: emptyRows(sport),
    golf: emptyGolf(),
    rpe: null,
    text: "",
  };
}

function formSection(title, iconName, ...content) {
  return h("section", { class: "form-section" }, h("h2", { class: "title-small" }, icon(iconName), title), ...content);
}

function renderForm() {
  if (!formHost || !draft) return;
  fill(formHost, 
    sportSection(),
    whenSection(),
    whoSection(),
    draft.sport === "golf" ? golfSection() : scoreSection(),
    formSection(
      "How it felt",
      "edit_note",
      rpeInput(draft.rpe, (v) => {
        draft.rpe = v;
        draft.dirty = true;
      }),
      h("div", { style: "height:20px" }),
      field(
        "Comment",
        h("textarea", {
          rows: "4",
          maxlength: "2000",
          value: draft.text,
          placeholder: "How did you feel? Energy, nerves, what worked, what didn't…",
          oninput: (e) => {
            draft.text = e.target.value;
            draft.dirty = true;
          },
        }),
      ),
    ),
    h(
      "div",
      { class: "form-actions" },
      h("button", { class: "btn text", type: "button", text: "Cancel", onclick: closeForm }),
      h("button", { class: "btn filled", type: "button", onclick: saveDraft }, icon("check"), "Save match"),
    ),
  );
}

function sportSection() {
  return formSection(
    "Sport",
    "sports_tennis",
    h(
      "div",
      { class: "segmented", role: "group", "aria-label": "Sport" },
      SPORT_KEYS.map((k) =>
        h(
          "button",
          { class: "seg-btn", type: "button", "aria-pressed": String(draft.sport === k), onclick: () => setDraftSport(k) },
          icon(draft.sport === k ? "check" : SPORT[k].icon),
          SPORT[k].label,
        ),
      ),
    ),
  );
}

function setDraftSport(k) {
  if (draft.sport === k) return;
  const typicalLength = draft.minutes === String(SPORT[draft.sport].minutes);
  if (typicalLength && !draft.workoutId) draft.minutes = String(SPORT[k].minutes);
  if (draft.scores.every(([a, b]) => a === "" && b === "")) draft.scores = emptyRows(k);
  draft.sport = k;
  draft.dirty = true;
  renderForm();
}

// ---------- when ----------
function whenSection() {
  const unlink = () => {
    draft.dirty = true;
    if (draft.workoutId) {
      draft.workoutId = null;
      paintWorkouts();
    }
  };
  const date = h("input", {
    type: "date",
    value: draft.date,
    max: dayKey(Date.now()),
    required: true,
    onchange: (e) => {
      draft.date = e.target.value;
      unlink();
      loadWorkouts();
    },
  });
  const time = h("input", {
    type: "time",
    value: draft.time,
    required: true,
    oninput: (e) => {
      draft.time = e.target.value;
      unlink();
    },
  });
  const minutes = h("input", {
    type: "number",
    inputmode: "numeric",
    min: "5",
    max: "480",
    step: "5",
    value: draft.minutes,
    oninput: (e) => {
      draft.minutes = e.target.value;
      unlink();
    },
  });
  workoutsHost = h("div", { style: "margin-top:20px" });
  paintWorkouts();
  return formSection(
    "When",
    "schedule",
    h("div", { class: "fields" }, h("div", { class: "wide" }, field("Date", date)), field("Started", time), field("Minutes played", minutes)),
    workoutsHost,
  );
}

async function loadWorkouts() {
  const [y, mo, d] = (draft.date || "").split("-").map(Number);
  if (!y) return;
  const from = new Date(y, mo - 1, d).getTime();
  const to = new Date(y, mo - 1, d + 1).getTime();
  const request = ++workoutsRequest;
  draft.workoutsState = "loading";
  paintWorkouts();
  const res = await api(`/api/workouts?from=${from}&to=${to}`);
  if (request !== workoutsRequest || !draft) return;
  if (!res.ok) {
    draft.workoutsState = "error";
    draft.workoutsMessage = res.message;
  } else if (!res.connected) {
    draft.workoutsState = "offline";
  } else {
    draft.workouts = res.workouts.sort((a, b) => b.start - a.start);
    draft.workoutsState = "done";
    const free = draft.workouts.filter((w) => !w.usedBy || w.usedBy === draft.id);
    // One workout that day and it isn't another match's: that's almost certainly this one.
    if (!draft.id && !draft.workoutId && free.length === 1) {
      pickWorkout(free[0], true);
      return;
    }
  }
  paintWorkouts();
}

function paintWorkouts() {
  if (!workoutsHost || !draft) return;
  const st = draft.workoutsState;
  const head = h(
    "div",
    { class: "row", style: "margin-bottom:10px" },
    icon("watch", "sm"),
    h("span", { class: "title-small", text: "Your Fitbit workouts that day" }),
    h("span", { class: "spacer" }),
    st === "done" || st === "error" ? h("button", { class: "btn text small", type: "button", onclick: loadWorkouts }, icon("refresh"), "Refresh") : null,
  );
  let body = null;
  if (st === "loading" || st === "idle") body = h("div", { class: "progress indeterminate", role: "progressbar", "aria-label": "Looking for workouts" }, h("i"));
  else if (st === "offline") body = h("p", { class: "body-small muted", text: "Connect Google Health in Settings to pick a workout here. Until then, type the time above." });
  else if (st === "error") body = h("p", { class: "body-small", style: "color:var(--md-error)", text: draft.workoutsMessage });
  else if (!draft.workouts.length) {
    body = h("p", {
      class: "body-small muted",
      text: "None found that day yet. If you've just finished, let your Fitbit sync to its phone app, then refresh. Or type the time above.",
    });
  } else {
    body = h("div", { class: "choices" }, draft.workouts.map(workoutChoice));
  }
  fill(workoutsHost, 
    head,
    body,
    draft.workoutId
      ? h("p", { class: "body-small muted", style: "margin-top:8px", text: "The match uses this workout's exact start and stop." })
      : null,
  );
}

function prettyWorkout(w) {
  const raw = (w.name && w.name !== w.type ? w.name : w.type || "Workout").replace(/^EXERCISE_TYPE_/, "").replace(/_/g, " ").toLowerCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function workoutChoice(w) {
  const taken = w.usedBy && w.usedBy !== draft.id;
  const picked = draft.workoutId === w.id;
  const bits = [
    `${dfTime.format(w.start)}–${dfTime.format(w.end)}`,
    duration((w.end - w.start) / 60_000),
    w.avgHr ? `${Math.round(w.avgHr)} bpm` : null,
    w.steps ? `${int(w.steps)} steps` : null,
  ].filter(Boolean);
  return h(
    "button",
    { class: "choice", type: "button", "aria-pressed": String(picked), onclick: () => pickWorkout(w) },
    icon(picked ? "check" : "watch"),
    h(
      "span",
      { class: "li-body" },
      h("span", { class: "title-small", style: "display:block", text: prettyWorkout(w) }),
      h("span", { class: "body-small", style: "display:block;opacity:0.8", text: bits.join(" · ") }),
      taken ? h("span", { class: "body-small", style: "display:block;color:var(--c-loss)", text: "Already used for another match" }) : null,
    ),
  );
}

function pickWorkout(w, automatic) {
  if (draft.workoutId === w.id && !automatic) {
    draft.workoutId = null;
    paintWorkouts();
    return;
  }
  draft.workoutId = w.id;
  draft.date = dayKey(w.start);
  draft.time = hhmm(new Date(w.start));
  draft.minutes = String(Math.max(5, Math.round((w.end - w.start) / 60_000)));
  if (!automatic) draft.dirty = true;
  renderForm();
}

// ---------- who ----------
function textInput(key, label, opts = {}) {
  return field(
    label,
    h("input", {
      type: "text",
      value: draft[key],
      list: opts.list || "people",
      autocomplete: "off",
      autocapitalize: "words",
      maxlength: "40",
      placeholder: opts.placeholder || null,
      oninput: (e) => {
        draft[key] = e.target.value;
        draft.dirty = true;
      },
    }),
  );
}

function whoSection() {
  const people = h("datalist", { id: "people" }, opponentsList().map((n) => h("option", { value: n })));
  let fields;
  if (draft.sport === "squash") fields = [h("div", { class: "wide" }, textInput("opponent", "Opponent"))];
  else if (draft.sport === "padel") {
    fields = [h("div", { class: "wide" }, textInput("partner", "Your partner")), textInput("opp1", "Opponent"), textInput("opp2", "Opponent")];
  } else {
    const courses = [...new Set(allMatches().map((m) => m.strokes && m.strokes.course).filter(Boolean))];
    const courseList = h("datalist", { id: "courses" }, courses.map((n) => h("option", { value: n })));
    const course = h("input", {
      type: "text",
      value: draft.golf.course,
      list: "courses",
      autocomplete: "off",
      autocapitalize: "words",
      maxlength: "40",
      oninput: (e) => {
        draft.golf.course = e.target.value;
        draft.dirty = true;
      },
    });
    fields = [
      h("div", { class: "wide" }, field("Course", course), courseList),
      h("div", { class: "wide" }, textInput("players", "Played with (optional)", { placeholder: "Names, separated by commas" })),
    ];
  }
  return formSection(draft.sport === "golf" ? "Where and with whom" : "Who", "group", h("div", { class: "fields" }, fields), people);
}

// ---------- score ----------
function scoreSection() {
  const sp = SPORT[draft.sport];
  resultHost = h("div", { class: "result-line" });
  paintResult();
  return formSection(
    "Score",
    "scoreboard",
    h("div", { class: "score-head" }, h("span"), h("span", { text: draft.sport === "padel" ? "You two" : "You" }), h("span"), h("span", { text: "Them" }), h("span")),
    h("div", { class: "score-rows" }, draft.scores.map((row, i) => scoreRow(row, i))),
    draft.scores.length < 5
      ? h(
          "button",
          {
            class: "btn text",
            type: "button",
            style: "margin-top:8px",
            onclick: () => {
              draft.scores.push(["", ""]);
              renderForm();
            },
          },
          icon("add"),
          `Add ${sp.part.toLowerCase()}`,
        )
      : null,
    resultHost,
  );
}

function scoreRow(row, i) {
  const sp = SPORT[draft.sport];
  const input = (k) =>
    h("input", {
      type: "number",
      inputmode: "numeric",
      min: "0",
      max: "99",
      value: row[k],
      "aria-label": `${sp.part} ${i + 1}: ${k === 0 ? "your" : "their"} score`,
      oninput: (e) => {
        row[k] = e.target.value;
        draft.dirty = true;
        paintResult();
      },
    });
  return h(
    "div",
    { class: "score-row" },
    h("span", { class: "label-large muted", text: `${sp.part} ${i + 1}` }),
    h("div", { class: "field" }, input(0)),
    h("span", { class: "dash", text: "–" }),
    h("div", { class: "field" }, input(1)),
    draft.scores.length > 1
      ? iconButton("close", `Remove ${sp.part.toLowerCase()} ${i + 1}`, () => {
          draft.scores.splice(i, 1);
          draft.dirty = true;
          renderForm();
        })
      : h("span"),
  );
}

const squashGameOk = (a, b) => {
  const w = Math.max(a, b);
  const l = Math.min(a, b);
  return w === 11 ? l <= 9 : w > 11 && w - l === 2;
};

function paintResult() {
  if (!resultHost) return;
  let won = 0;
  let lost = 0;
  const notes = [];
  draft.scores.forEach(([a, b], i) => {
    if (a === "" || b === "") return;
    const x = Number(a);
    const y = Number(b);
    if (x > y) won++;
    else if (y > x) lost++;
    else notes.push(`${SPORT[draft.sport].part} ${i + 1} can't be a draw.`);
    if (draft.sport === "squash" && x !== y && !squashGameOk(x, y)) notes.push(`Game ${i + 1}: squash games end at 11, or 2 clear after 10-all.`);
  });
  fill(resultHost, 
    won + lost === 0
      ? h("span", { class: "body-small muted", text: `Enter each ${SPORT[draft.sport].part.toLowerCase()}'s score, yours first.` })
      : won > lost
        ? h("span", { class: "badge win", text: `You win ${won}–${lost}` })
        : lost > won
          ? h("span", { class: "badge loss", text: `You lose ${won}–${lost}` })
          : h("span", { class: "badge", text: `Level ${won}–${lost}` }),
    notes.length ? h("span", { class: "body-small muted", text: notes[0] }) : null,
  );
}

function golfSection() {
  const g = draft.golf;
  const holes = h(
    "div",
    { class: "segmented", role: "group", "aria-label": "Holes" },
    [9, 18].map((n) =>
      h(
        "button",
        {
          class: "seg-btn",
          type: "button",
          "aria-pressed": String(g.holes === n),
          onclick: () => {
            g.holes = n;
            g.perHole = g.perHole.slice(0, n);
            draft.dirty = true;
            renderForm();
          },
        },
        g.holes === n ? icon("check") : null,
        `${n} holes`,
      ),
    ),
  );
  const strokes = h("input", {
    type: "number",
    inputmode: "numeric",
    min: String(g.holes),
    max: "300",
    value: g.strokes,
    oninput: (e) => {
      g.strokes = e.target.value;
      draft.dirty = true;
      paintGolf();
    },
  });
  const par = h("input", {
    type: "number",
    inputmode: "numeric",
    min: String(g.holes * 2),
    max: String(g.holes * 6),
    value: g.par,
    placeholder: g.holes === 9 ? "36" : "72",
    oninput: (e) => {
      g.par = e.target.value;
      draft.dirty = true;
      paintGolf();
    },
  });
  const grid = g.showHoles
    ? h(
        "div",
        { class: "holes", style: "margin-top:16px" },
        Array.from({ length: g.holes }, (_, i) =>
          field(
            String(i + 1),
            h("input", {
              type: "number",
              inputmode: "numeric",
              min: "1",
              max: "20",
              value: g.perHole[i] || "",
              "aria-label": `Hole ${i + 1} strokes`,
              oninput: (e) => {
                g.perHole[i] = e.target.value;
                draft.dirty = true;
                const filled = Array.from({ length: g.holes }, (_, k) => Number(g.perHole[k]));
                if (filled.every((v) => v > 0)) {
                  g.strokes = String(filled.reduce((a, v) => a + v, 0));
                  strokes.value = g.strokes;
                }
                paintGolf();
              },
            }),
          ),
        ),
      )
    : null;
  golfHost = h("div", { class: "result-line" });
  paintGolf();
  return formSection(
    "Score",
    "flag",
    holes,
    h("div", { class: "fields", style: "margin-top:20px" }, field("Total strokes", strokes), field("Course par", par)),
    h(
      "button",
      {
        class: "btn text",
        type: "button",
        style: "margin-top:8px",
        onclick: () => {
          g.showHoles = !g.showHoles;
          renderForm();
        },
      },
      icon(g.showHoles ? "close" : "add"),
      g.showHoles ? "Hide hole by hole" : "Enter hole by hole (optional)",
    ),
    grid,
    golfHost,
  );
}

function paintGolf() {
  if (!golfHost) return;
  const g = draft.golf;
  const strokes = Number(g.strokes);
  const par = Number(g.par) || (g.holes === 9 ? 36 : 72);
  const d = strokes - par;
  fill(golfHost, 
    strokes > 0
      ? h("span", { class: "badge", text: `${strokes} · ${d === 0 ? "level par" : d > 0 ? `+${d} over par` : `${-d} under par`}` })
      : h("span", { class: "body-small muted", text: "Enter your total, or fill in the holes and it adds up for you." }),
  );
}

// ---------- save / close ----------
function buildPayload() {
  const [y, mo, d] = (draft.date || "").split("-").map(Number);
  const [hh, mm] = (draft.time || "").split(":").map(Number);
  if (!y || !Number.isFinite(hh)) return "Enter the date and the time you started.";
  const start = new Date(y, mo - 1, d, hh, mm || 0);
  const minutes = Number(draft.minutes);
  if (!Number.isFinite(minutes) || minutes < 5) return "Enter how many minutes you played.";
  const base = {
    id: draft.id || undefined,
    sport: draft.sport,
    startedAt: start.getTime(),
    endedAt: start.getTime() + minutes * 60_000,
    utcOffsetMinutes: -start.getTimezoneOffset(),
    workoutId: draft.workoutId,
    note: { text: draft.text, rpe: draft.rpe },
  };
  if (draft.sport === "squash") return { ...base, opponents: [draft.opponent], scores: draft.scores };
  if (draft.sport === "padel") return { ...base, partner: draft.partner, opponents: [draft.opp1, draft.opp2], scores: draft.scores };
  const g = draft.golf;
  return {
    ...base,
    opponents: draft.players.split(",").map((x) => x.trim()).filter(Boolean),
    scores: [],
    golf: { course: g.course, holes: g.holes, strokes: g.strokes, par: g.par, perHole: g.showHoles ? g.perHole.slice(0, g.holes) : [] },
  };
}

async function saveDraft() {
  if (saving || !draft) return;
  const payload = buildPayload();
  if (typeof payload === "string") {
    snack(payload);
    return;
  }
  saving = true;
  for (const b of document.querySelectorAll(".log-form .btn.filled, .topbar .btn.filled")) b.disabled = true;
  const res = await api("/api/matches", "POST", payload);
  saving = false;
  for (const b of document.querySelectorAll(".log-form .btn.filled, .topbar .btn.filled")) b.disabled = false;
  if (!res.ok) {
    snack(res.message, { long: true });
    return;
  }
  S = res.state;
  prefs.set("lastSport", payload.sport);
  draft = null;
  draftFor = null;
  location.replace(href("match", res.id));
  const fetch = S.google && S.google.connected;
  snack(fetch ? "Saved. Fetching heart rate and steps…" : "Saved.");
  if (fetch) syncNow();
}

async function closeForm() {
  if (draft && draft.dirty) {
    const ok = await confirmDialog({ title: "Discard this match?", text: "What you've entered so far will be lost.", confirm: "Discard", danger: true });
    if (!ok) return;
  }
  const back = draft && draft.id ? href("match", draft.id) : previousHash || "#/";
  draft = null;
  draftFor = null;
  location.hash = back;
}
