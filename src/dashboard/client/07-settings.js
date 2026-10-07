// Settings: you, your watch, the AI coach (model, budget, usage), the league import and appearance.

PAGES.settings = () => {
  if (!HOSTED) return notFoundView();
  if (!EDIT) {
    return {
      title: "Settings",
      body: [
        h(
          "div",
          { class: "grid" },
          h(
            "div",
            { class: "card half" },
            cardHead("Sign in", "key"),
            h("p", { class: "body-medium muted", text: "Anyone can look at this journal. Sign in to log matches, add notes, sync the watch or ask the AI." }),
            h("div", { class: "card-foot" }, h("a", { class: "btn filled", href: "/login" }, icon("key"), "Sign in")),
          ),
          appearanceCard(),
        ),
      ],
    };
  }
  return {
    title: "Settings",
    body: [h("div", { class: "grid" }, profileCard(), watchCard(), aiSettingsCard(), leagueCard(), appearanceCard(), accountCard())],
  };
};

async function saveSettings(patch, done = "Saved.") {
  const res = await api("/api/settings", "PUT", patch);
  if (!res.ok) {
    snack(res.message);
    return false;
  }
  S = res.state;
  render();
  snack(done);
  return true;
}

function profileCard() {
  const st = S.settings;
  const name = h("input", { type: "text", value: st.name || "", maxlength: "40", autocomplete: "given-name", placeholder: (S.league && S.league.me) || "" });
  const hrMax = h("input", {
    type: "number",
    inputmode: "numeric",
    min: "120",
    max: "230",
    value: st.hrMax == null ? "" : String(st.hrMax),
    placeholder: S.data.hrMax && S.data.hrMaxSource === "observed" ? String(S.data.hrMax) : "",
  });
  const help =
    st.hrMax != null
      ? "Used for zones and load. Clear it to use the highest heart rate seen in your matches."
      : S.data.hrMax
        ? `Empty uses ${S.data.hrMax} bpm, the highest seen in your matches. Set it if you know yours.`
        : "Used for zones and load. Leave empty to use the highest seen in your matches.";
  return h(
    "div",
    { class: "card half" },
    cardHead("You", "person"),
    h("div", { class: "stack" }, field("Name", name), field("Max heart rate (bpm)", hrMax, help)),
    h(
      "div",
      { class: "card-foot", style: "justify-content:flex-end" },
      h("button", {
        class: "btn tonal",
        type: "button",
        text: "Save",
        onclick: () => saveSettings({ name: name.value, hrMax: hrMax.value === "" ? null : Number(hrMax.value) }),
      }),
    ),
  );
}

function watchCard() {
  const g = S.google;
  const last = g.lastSync;
  return h(
    "div",
    { class: "card half" },
    cardHead("Fitbit via Google Health", "watch", g.connected ? h("span", { class: "badge win", text: "Connected" }) : h("span", { class: "badge", text: "Not connected" })),
    h("p", {
      class: "body-medium muted",
      text: !g.configured
        ? "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel to connect your watch."
        : last
          ? `Last sync ${dfStamp.format(last.at)}: ${last.message}`
          : "Not synced yet.",
    }),
    g.configured
      ? h(
          "div",
          { class: "card-foot" },
          g.connected ? h("button", { class: "btn filled", type: "button", disabled: syncing, onclick: () => syncNow() }, icon("sync", syncing ? "spin" : null), syncing ? "Syncing…" : "Sync now") : null,
          h("a", { class: g.connected ? "btn text" : "btn filled", href: "/connect" }, icon("link"), g.connected ? "Reconnect" : "Connect Google Health"),
        )
      : null,
    g.connected
      ? h("p", { class: "body-small muted", style: "margin-top:12px", text: "While your Google Cloud app is in Testing mode the connection lasts 7 days. Reconnect when a sync asks you to." })
      : null,
  );
}

function aiSettingsCard() {
  const ai = S.ai;
  const u = ai.usage;
  const budget = h("input", { type: "number", inputmode: "decimal", min: "0", max: "500", step: "0.5", value: String(u.budgetUsd) });
  return h(
    "div",
    { class: "card half" },
    cardHead("AI coach", "auto_awesome", ai.configured ? h("span", { class: "badge win", text: "On" }) : h("span", { class: "badge", text: "Off" })),
    ai.configured
      ? h("p", { class: "body-medium muted", text: "Answers are only requested when you tap Get insight, saved, and never bought twice for the same data. Only summary numbers and your notes are sent; OpenAI doesn't keep them." })
      : h(
          "div",
          { class: "stack", style: "gap:8px" },
          h("p", { class: "body-medium", text: "To switch it on:" }),
          h(
            "ol",
            { class: "body-medium muted" },
            h("li", {}, "Create a key at platform.openai.com → API keys (and add a few dollars of credit)."),
            h("li", {}, "In Vercel: your project → Settings → Environment Variables → add ", h("b", { text: "OPENAI_API_KEY" }), "."),
            h("li", {}, "Redeploy, then come back here."),
          ),
        ),
    h("div", { style: "margin-top:16px" }, usageBar(u, false)),
    h(
      "p",
      { class: "body-small muted", style: "margin-top:8px" },
      `${int(u.month.requests)} answer${u.month.requests === 1 ? "" : "s"} this month · ${int(u.month.input)} tokens in, ${int(u.month.output)} out. All time ${money(u.total.costUsd)}.`,
    ),
    h("h3", { class: "title-small", style: "margin:20px 0 8px", text: "Model" }),
    h(
      "div",
      { class: "choices" },
      ai.models.map((m) =>
        h(
          "button",
          {
            class: "choice",
            type: "button",
            "aria-pressed": String(m.id === u.model),
            onclick: () => m.id !== u.model && saveSettings({ aiModel: m.id }, `AI model: ${m.label}.`),
          },
          icon(m.id === u.model ? "check" : "auto_awesome"),
          h(
            "span",
            { class: "li-body" },
            h("span", { class: "title-small", style: "display:block", text: m.label }),
            h("span", { class: "body-small", style: "display:block;opacity:0.8", text: `${m.note} · about ${money(answerCost(m))} an answer` }),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "row", style: "margin-top:20px;align-items:flex-start" },
      h("div", { style: "flex:1;min-width:0" }, field("Monthly budget (US$)", budget, "AI requests stop for the month once this is spent.")),
      h("button", { class: "btn tonal", type: "button", style: "margin-top:8px", text: "Save", onclick: () => saveSettings({ aiBudgetUsd: Number(budget.value) }) }),
    ),
  );
}

function leagueCard() {
  if (!S.league) return null;
  const select = h(
    "select",
    { disabled: S.league.locked },
    h("option", { value: "", text: "Not set" }),
    S.league.players.map((p) => {
      const o = h("option", { value: p, text: p });
      if (p === S.league.me) o.selected = true;
      return o;
    }),
  );
  const imported = (S.data.matches || []).filter((m) => m.source === "league").length;
  return h(
    "div",
    { class: "card half" },
    cardHead("Squash league history", "scoreboard"),
    h("p", {
      class: "body-medium muted",
      text: `Imported once from the Club Squash League app: ${imported} of your matches, with point-by-point logs. Other players' matches aren't kept in view.`,
    }),
    h("div", { style: "margin-top:16px" }, field("You are", select, S.league.locked ? "Set by ME in your Vercel environment variables." : null)),
    S.league.locked
      ? null
      : h(
          "div",
          { class: "card-foot", style: "justify-content:flex-end" },
          h("button", {
            class: "btn tonal",
            type: "button",
            text: "Save",
            onclick: async () => {
              const res = await api("/me", "POST", { me: select.value });
              if (!res.ok) {
                snack(res.message);
                return;
              }
              S = res.state;
              render();
              snack(res.message);
            },
          }),
        ),
  );
}

function appearanceCard() {
  const current = theme();
  const options = [
    ["system", "System", "contrast"],
    ["light", "Light", "light_mode"],
    ["dark", "Dark", "dark_mode"],
  ];
  return h(
    "div",
    { class: "card half" },
    cardHead("Appearance", "contrast"),
    h(
      "div",
      { class: "segmented", role: "group", "aria-label": "Theme" },
      options.map(([key, label, ic]) =>
        h(
          "button",
          {
            class: "seg-btn",
            type: "button",
            "aria-pressed": String(current === key),
            onclick: () => {
              setTheme(key);
              render();
            },
          },
          icon(current === key ? "check" : ic),
          label,
        ),
      ),
    ),
    h("p", { class: "body-small muted", style: "margin-top:12px", text: "Remembered on this device." }),
  );
}

function accountCard() {
  return h(
    "div",
    { class: "card half" },
    cardHead("Account", "key"),
    h("p", { class: "body-medium muted", text: "Your data lives in your own Upstash database. Signing out ends this device's session." }),
    h("div", { class: "card-foot" }, h("a", { class: "btn outlined", href: "/logout" }, icon("logout"), "Sign out")),
  );
}
