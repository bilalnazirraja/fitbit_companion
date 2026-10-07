// The app's page: one HTML file with the stylesheet, script and data inlined, so the same page works
// served by the web app and opened straight from disk (`npm run build`).
import { readdirSync, readFileSync } from "node:fs";
import type { Dataset } from "../analysis/dataset.ts";
import type { ModelInfo } from "../ai/openai.ts";
import type { JournalEntry, Note } from "../journal/entries.ts";
import type { AiUsage, SavedInsight, Settings, SyncStatus } from "../server/repo.ts";

// Read relative to this module; the Vercel build copies them next to the bundled function.
const here = new URL("./", import.meta.url);
const css = readFileSync(new URL("app.css", here), "utf8");
const clientDir = new URL("client/", here);
// Plain scripts sharing one scope, concatenated in file-name order (01-core.js first).
const js = readdirSync(clientDir)
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((f) => `// ---- ${f}\n${readFileSync(new URL(f, clientDir), "utf8")}`)
  .join("\n");

/** The app's stylesheet, for the server's other pages (sign-in, setup). */
export const dashboardCss = css;

// Material Symbols, trimmed to the icons the app uses (the full font is several megabytes).
// Names must stay in alphabetical order.
export const ICONS = [
  "add", "arrow_back", "auto_awesome", "bedtime", "bolt", "calendar_month", "chat_bubble", "check", "close",
  "contrast", "dark_mode", "delete", "edit", "edit_note", "emoji_events", "expand_more", "favorite", "flag", "group",
  "help", "home", "info", "insights", "key", "light_mode", "link", "logout", "monitor_heart", "padel", "person",
  "refresh", "schedule", "scoreboard", "settings", "speed", "sports_golf", "sports_tennis", "steps", "sync",
  "sync_problem", "timer", "trending_down", "trending_flat", "trending_up", "watch",
];
const ICON_FONT_URL =
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,400..500,0..1,0" +
  `&icon_names=${ICONS.join(",")}&display=block`;
// Text shows straight away in a fallback font; icons stay hidden until theirs arrives.
export const TEXT_FONT_URL = "https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,300..700&display=swap";

export interface UsageSummary {
  model: string;
  budgetUsd: number;
  month: AiUsage;
  total: AiUsage;
}

/** Everything the page needs, embedded as JSON. */
export interface AppState {
  data: Dataset;
  /** Served by the web app, so logging, notes, sync and AI work (not a file opened from disk). */
  hosted: boolean;
  /** Your name, for the greeting. */
  name: string | null;
  notes: Record<string, Note>;
  /** Matches you logged in the app, by id, for editing. */
  entries: Record<string, JournalEntry>;
  /** The squash league imported once: who you are in it. */
  league: { players: string[]; me: string | null; locked: boolean } | null;
  google: { configured: boolean; connected: boolean; lastSync: SyncStatus | null } | null;
  ai: { configured: boolean; models: ModelInfo[]; usage: UsageSummary; insights: Record<string, SavedInsight> } | null;
  settings: Settings | null;
  flash: string | null;
}

export function renderApp(state: AppState): string {
  // "<" escaped so names and notes can never close the script tag.
  const json = JSON.stringify(state).replace(/</g, "\\u003c");
  const title = state.data.demo ? "Performance Journal (demo)" : "Performance Journal";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f4f5ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121411" media="(prefers-color-scheme: dark)">
${state.hosted ? `<link rel="manifest" href="/manifest.webmanifest">\n<link rel="icon" href="/icon.svg" type="image/svg+xml">` : ""}
<title>${title}</title>
<script>try{var t=localStorage.getItem("pj:theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${TEXT_FONT_URL}">
<link rel="stylesheet" href="${ICON_FONT_URL}">
<style>
${css}
</style>
</head>
<body>
<div id="app"></div>
<script id="data" type="application/json">${json}</script>
<script>
(() => {
"use strict";
${js}
})();
</script>
</body>
</html>
`;
}

/** The read-only page `npm run build` writes: your matches and analysis, no logging or AI. */
export function staticState(data: Dataset): AppState {
  return {
    data,
    hosted: false,
    name: data.me?.name ?? null,
    notes: {},
    entries: {},
    league: null,
    google: null,
    ai: null,
    settings: null,
    flash: null,
  };
}
