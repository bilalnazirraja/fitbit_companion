// Command-line entry point: `npm run <command>` (see package.json and README).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildDataset } from "./analysis/dataset.ts";
import { config } from "./config.ts";
import { renderApp, staticState } from "./dashboard/render.ts";
import { simulateWearable } from "./demo/simulate.ts";
import type { Session, WearableData } from "./model.ts";
import { fetchLeagueState, parseLeagueState, toSessions, type LeagueState } from "./sources/club-squash-league.ts";
import { createClient } from "./sources/google-health/client.ts";
import { authorize, refresh, type StoredToken } from "./sources/google-health/oauth.ts";
import { googleHealthProvider } from "./sources/google-health/provider.ts";
import { paths, readJson, writeJson, writeText } from "./store.ts";
import { guessMe, syncWearable } from "./sync/wearable-sync.ts";

const [command = "help", ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

const commands: Record<string, () => Promise<void> | void> = {
  async auth() {
    const client = googleClient();
    const token = await authorize(client, config.google.port);
    writeJson(paths.token, token, true);
    console.log("Connected to Google Health. Next: npm run sync");
  },

  async "sync-scores"() {
    const state: LeagueState = flags.file
      ? parseLeagueState(JSON.parse(readFileSync(flags.file, "utf8")))
      : await fetchLeagueState(config.scoresUrl);
    writeJson(paths.scoresLatest, state);
    writeJson(paths.scoresSnapshot(String(state.updatedAt)), state);
    const sessions = toSessions(state);
    const complete = sessions.filter((s) => s.quality.logComplete).length;
    console.log(`Scores: ${sessions.length} completed matches (${complete} with full point-by-point logs).`);
  },

  async "sync-wearable"() {
    const sessions = loadSessions();
    await getAccessToken(); // fail fast (and refresh) before any work
    const client = createClient({ getAccessToken, onPage: archivePage });
    const provider = googleHealthProvider(client, (m) => console.log(`  ${m}`));
    const previous = readJson<WearableData>(paths.wearable);
    const { data } = await syncWearable(provider, sessions, previous, {
      me: config.me,
      from: flags.from ? Date.parse(`${flags.from}T00:00:00Z`) : undefined,
      to: flags.to ? Date.parse(`${flags.to}T23:59:59Z`) : undefined,
      full: flags.full === "true",
      log: (m) => console.log(m),
    });
    writeJson(paths.wearable, data);
    console.log(
      `Wearable: ${data.recordings.length} match workouts, ${data.heartRate.length.toLocaleString()} heart-rate samples, ${data.daily.length} days of daily context.`,
    );
    if (!config.me) commands.whoami();
  },

  async sync() {
    await commands["sync-scores"]();
    await commands["sync-wearable"]();
  },

  whoami() {
    const data = readJson<WearableData>(paths.wearable);
    if (!data) throw new Error("No wearable data yet. Run `npm run sync` first.");
    const ranking = guessMe(loadSessions(), data.recordings);
    console.log("\nMatches that line up with a workout on your watch:");
    for (const r of ranking) console.log(`  ${r.name.padEnd(10)} ${r.matched}/${r.played}`);
    const top = ranking[0];
    if (top && top.matched > 0) console.log(`\nThat looks like ${top.name}. Put ME=${top.name} in .env, then npm run build`);
    else console.log("\nNo workouts overlap any match yet.");
  },

  build() {
    const sessions = loadSessions();
    const wearable = readJson<WearableData>(paths.wearable) ?? null;
    const me = flags.me ?? config.me;
    if (!me) throw new Error("Set ME=<your name> in .env first: the dashboard shows your matches only (npm run whoami helps).");
    const dataset = buildDataset(sessions, wearable, {
      me,
      hrMax: config.hrMax,
      breakSec: config.gameBreakSeconds,
      onlyMine: true,
      players: [me],
    });
    writeJson(paths.dataset, dataset);
    publish(dataset, "index.html");
  },

  demo() {
    const sessions = loadSessions();
    const me = flags.me ?? config.me ?? busiestPlayer(sessions);
    const { wearable } = simulateWearable(sessions, me, {
      seed: 7,
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
    });
    writeJson(paths.demoWearable, wearable);
    const dataset = buildDataset(sessions, wearable, { me, breakSec: config.gameBreakSeconds, demo: true, onlyMine: true, players: [me] });
    console.log(`Demo: simulated heart rate for ${me}'s ${wearable.recordings.length} timed matches (scores are real).`);
    publish(dataset, "demo.html");
  },

  status() {
    const scores = readJson<LeagueState>(paths.scoresLatest);
    const token = readJson<StoredToken>(paths.token);
    const wearable = readJson<WearableData>(paths.wearable);
    const line = (label: string, value: string) => console.log(`${label.padEnd(12)} ${value}`);
    line("Me", config.me ?? "not set (ME in .env)");
    line("Scores", scores ? `${toSessions(scores).length} matches, league updated ${when(scores.updatedAt)}` : "not synced");
    line("Google", token ? `connected (access token ${token.expires_at > Date.now() ? "valid" : "will refresh"})` : "not connected (npm run auth)");
    line(
      "Wearable",
      wearable
        ? `${wearable.recordings.length} workouts, ${wearable.heartRate.length.toLocaleString()} HR samples, synced ${when(wearable.syncedAt)}`
        : "not synced",
    );
  },

  help() {
    console.log(`Sports Companion

  npm run sync:scores    Pull matches from the scoring app (or --file export.json)
  npm run auth           Connect your Google account (Fitbit data) once
  npm run sync:wearable  Pull heart rate, workouts and daily context around your matches
  npm run sync           Both syncs
  npm run whoami         Work out which player you are from your watch workouts
  npm run build          Analyse and write dashboard/index.html
  npm run demo           Preview the dashboard with simulated heart rate (--me Name)
  npm run status         What's synced so far`);
  },
};

async function main() {
  const run = commands[command];
  if (!run) {
    commands.help();
    process.exitCode = 1;
    return;
  }
  await run();
}

main().catch((err: Error) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});

function loadSessions(): Session[] {
  const state = readJson<LeagueState>(paths.scoresLatest);
  if (!state) throw new Error("No match data yet. Run `npm run sync:scores` first.");
  return toSessions(state);
}

function googleClient() {
  const { clientId, clientSecret } = config.google;
  if (!clientId || !clientSecret) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (README: Connect your Fitbit).");
  }
  return { clientId, clientSecret };
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  let token = readJson<StoredToken>(paths.token);
  if (!token) throw new Error("Not connected to Google yet. Run `npm run auth`.");
  if (forceRefresh || token.expires_at - 60_000 < Date.now()) {
    token = await refresh(googleClient(), token);
    writeJson(paths.token, token, true);
  }
  return token.access_token;
}

/** Keep every raw API page: cheap insurance while Google's health APIs are still changing. */
function archivePage(dataType: string, filter: string, page: number, body: unknown): void {
  const key = `${createHash("sha1").update(filter).digest("hex").slice(0, 12)}-${page}`;
  writeJson(paths.googleRaw(dataType, key), { fetchedAt: Date.now(), filter, page, body });
}

function publish(dataset: ReturnType<typeof buildDataset>, file: string): void {
  const out = join(config.dashboardDir, file);
  writeText(out, renderApp(staticState(dataset)));
  const q = dataset.quality;
  console.log(
    `${q.matches} matches (${q.completeLogs} with full point logs), ${q.withHr} with heart rate.` +
      `\nDashboard: ${pathToFileURL(out).href}`,
  );
}

function busiestPlayer(sessions: Session[]): string {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    if (!s.quality.logComplete || s.quality.timing !== "live") continue;
    for (const p of s.participants) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  }
  const [name] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return name;
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(args[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true");
  }
  return out;
}

function when(t: number): string {
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
