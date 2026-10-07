import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { mulberry32 } from "../src/analysis/stats.ts";
import { simulateSession, simulateWearable } from "../src/demo/simulate.ts";
import type { WearableData } from "../src/model.ts";
import { createApp } from "../src/server/app.ts";
import { memoryKv } from "../src/server/kv.ts";
import { SCOPES } from "../src/sources/google-health/oauth.ts";
import { leagueSessions, syntheticMatch } from "./fixtures.ts";

const SCORES = readFileSync(resolve(import.meta.dirname, "..", "scores.txt"), "utf8");
const BASE = "https://journal.test";
const iso = (t: number) => new Date(t).toISOString();

/** Scores app, Google's token endpoint, the Google Health API and OpenAI, answering from simulated data. */
function fakeInternet(wearable: WearableData) {
  const calls: string[] = [];
  const openai: Record<string, any>[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.hostname}${url.pathname}`);
    if (url.hostname === "scores.test") return Response.json(JSON.parse(SCORES));
    if (url.href === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "authorization_code" && form.get("code") !== "good-code") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: SCOPES.join(" ") });
    }
    if (url.hostname === "api.openai.com") {
      openai.push(JSON.parse(String(init?.body)));
      return Response.json({
        status: "completed",
        output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "- Solid match.\nTry: hold the T." }] }],
        usage: { input_tokens: 600, input_tokens_details: { cached_tokens: 0 }, output_tokens: 400, output_tokens_details: { reasoning_tokens: 200 } },
      });
    }
    if (url.hostname === "health.googleapis.com") {
      const type = url.pathname.split("/dataTypes/")[1].split("/")[0];
      const [from, to] = [...(url.searchParams.get("filter") ?? "").matchAll(/"([^"]+)"/g)].map((m) => Date.parse(m[1]));
      if (type === "exercise") {
        return Response.json({
          dataPoints: wearable.recordings
            .filter((r) => r.start >= from && r.start < to)
            .map((r) => ({
              name: `users/me/dataTypes/exercise/dataPoints/${r.id}`,
              exercise: { interval: { startTime: iso(r.start), endTime: iso(r.end), startUtcOffset: "18000s" }, exerciseType: "SQUASH" },
            })),
        });
      }
      if (type === "heart-rate") {
        return Response.json({
          dataPoints: wearable.heartRate
            .filter((s) => s.t >= from && s.t < to)
            .map((s) => ({ heartRate: { sampleTime: { physicalTime: iso(s.t) }, beatsPerMinute: String(s.bpm) } })),
        });
      }
      if (type === "steps") {
        return Response.json({
          dataPoints: wearable.steps
            .filter((s) => s.start >= from && s.start < to)
            .map((s) => ({ steps: { interval: { startTime: iso(s.start), endTime: iso(s.end) }, count: String(s.count) } })),
        });
      }
      return Response.json({ dataPoints: [] });
    }
    throw new Error(`Unexpected request to ${url.href}`);
  }) as typeof fetch;
  return { doFetch, calls, openai };
}

/** A tiny browser: keeps cookies, never follows redirects. */
function browser(handle: (req: Request) => Promise<Response>) {
  const jar = new Map<string, string>();
  return async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await handle(new Request(`${BASE}${path}`, { ...init, headers }));
    for (const c of res.headers.getSetCookie()) {
      const [name, value] = c.split(";")[0].split("=");
      if (/Max-Age=0/.test(c)) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
  body: new URLSearchParams(fields).toString(),
});
const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify(body),
});
const post = { method: "POST", headers: { origin: BASE } };

function setup(env: Record<string, string> = {}, extra: { syncBudgetMs?: number; wearable?: WearableData } = {}) {
  const wearable = extra.wearable ?? simulateWearable(leagueSessions(), "Usama", { seed: 3 }).wearable;
  const net = fakeInternet(wearable);
  const kv = memoryKv();
  const app = createApp({
    kv,
    env: {
      APP_PASSWORD: "correct horse",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      SCORES_URL: "https://scores.test/api/state",
      ...env,
    },
    fetch: net.doFetch,
    syncBudgetMs: extra.syncBudgetMs,
  });
  return { app, kv, net, open: browser(app) };
}

async function connect(open: ReturnType<typeof browser>) {
  const start = new URL((await open("/connect")).headers.get("location")!);
  await open(`/oauth/callback?state=${start.searchParams.get("state")}&code=good-code`);
}

type Reply = { ok: boolean; message: string; pending: number; id: string; state: any; notes: any; insight: any; cached: boolean; usage: any };
const reply = async (res: Response) => (await res.json()) as Reply;

const embedded = (html: string) =>
  JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)![1]);

test("anyone can look; only you can change anything", async () => {
  const { open } = setup();
  const home = await open("/");
  assert.equal(home.status, 200, "the journal is public");
  const visitor = embedded(await home.text());
  assert.equal(visitor.canEdit, false);
  assert.equal((await open("/api/data")).status, 200);
  assert.equal((await open("/sync", { method: "POST" })).status, 401);
  assert.equal((await open("/api/matches", send("POST", { sport: "squash" }))).status, 401);
  assert.equal((await open("/api/ai", send("POST", { scope: "overview" }))).status, 401, "visitors can't spend on AI");
  assert.equal((await open("/api/workouts?from=0&to=1")).status, 401);
  assert.equal((await open("/connect")).status, 303);
  assert.equal((await open("/login", form({ password: "wrong" }))).status, 401);

  const ok = await open("/login", form({ password: "correct horse" }));
  assert.equal(ok.status, 303);
  const page = await (await open("/")).text();
  assert.match(page, /Powered by/);
  const state = embedded(page);
  assert.equal(state.canEdit, true);
  assert.equal(state.league.players.length, 6, "the league is imported once");
  assert.equal(state.data.matches.length, 0, "nobody's matches until you say which player you are");
});

test("a live-scored match joins the rally analysis", async () => {
  const { open } = setup();
  await open("/login", form({ password: "correct horse" }));
  await open("/me", send("POST", { me: "Bilal" }));
  const t = Date.UTC(2026, 9, 6, 14, 0);
  // 11-9 then 11-4, alternating points so no game ends early.
  const points: { g: number; w: string; at: number }[] = [];
  const game = (g: number, a: number, b: number) => {
    const seq: string[] = [];
    while (a + b > 0) {
      if (b > 0 && (seq.length % 2 === 1 || a === 0)) {
        seq.push("b");
        b--;
      } else {
        seq.push("a");
        a--;
      }
    }
    for (const w of seq) points.push({ g, w, at: t + points.length * 20_000 });
  };
  game(1, 11, 9);
  game(2, 11, 4);
  const saved = await reply(await open("/api/matches", send("POST", { sport: "squash", startedAt: t, endedAt: t + points.length * 20_000 + 60_000, opponents: ["Usama"], points })));
  assert.equal(saved.ok, true, saved.message);
  const m = saved.state.data.matches.find((x: { id: string }) => x.id === saved.id);
  assert.deepEqual(m.score, [[11, 9], [11, 4]]);
  assert.equal(m.rallies, true);
  const sv = saved.state.data.sessions.find((x: { id: string }) => x.id === saved.id);
  assert.equal(sv.rallies.length, 35);
});

test("only your own matches are kept", async () => {
  const { open, net } = setup();
  await open("/login", form({ password: "correct horse" }));
  const picked = await reply(await open("/me", send("POST", { me: "Bilal" })));
  assert.equal(picked.ok, true, picked.message);
  const matches = picked.state.data.matches;
  assert.equal(matches.length, 22);
  assert.ok(matches.every((m: { opponents: string[] }) => m.opponents.length === 1 && !m.opponents.includes("Bilal")));
  assert.ok(picked.state.data.sessions.every((s: { players: { name: string }[] }) => s.players.some((p) => p.name === "Bilal")));
  assert.equal(net.calls.filter((c) => c.startsWith("scores.test")).length, 1, "the scoring app is only asked once");
  await open("/sync", post);
  assert.equal(net.calls.filter((c) => c.startsWith("scores.test")).length, 1, "syncing no longer reads the scoring app");
});

test("connect Google Health, sync, and get heart rate on your matches", async () => {
  const { open, kv, net } = setup();
  await open("/login", form({ password: "correct horse" }));

  const start = await open("/connect");
  assert.equal(start.status, 302);
  const google = new URL(start.headers.get("location")!);
  assert.equal(google.origin, "https://accounts.google.com");
  assert.equal(google.searchParams.get("redirect_uri"), `${BASE}/oauth/callback`);

  const forged = await open(`/oauth/callback?state=not-the-state&code=good-code`);
  assert.equal(forged.status, 400, "a callback without our state is refused");
  const again = new URL((await open("/connect")).headers.get("location")!);
  const back = await open(`/oauth/callback?state=${again.searchParams.get("state")}&code=good-code`);
  assert.equal(back.status, 303);
  assert.match(decodeURIComponent(back.headers.get("location")!), /Google Health connected/);
  assert.ok(kv.data.has("pj:token"));

  assert.equal((await open("/me", form({ me: "Usama" }))).status, 303, "the old form post still works");
  const synced = await reply(await open("/sync", post));
  assert.equal(synced.ok, true, synced.message);
  assert.equal(synced.pending, 0);

  const state = embedded(await (await open("/")).text());
  assert.equal(state.data.me.name, "Usama");
  assert.ok(state.data.quality.withHr >= 15, `${state.data.quality.withHr} matches with heart rate`);
  const efficient = state.data.matches.filter((m: { efficiency: unknown }) => m.efficiency);
  assert.ok(efficient.length >= 15, `${efficient.length} matches with efficiency`);
  assert.ok([...kv.data.keys()].some((k) => k.startsWith("pj:hr:")), "heart rate stored per day");

  // A second sync only lists workouts; heart rate that's already in isn't downloaded again.
  const before = net.calls.length;
  await open("/sync", post);
  const hrCalls = net.calls.slice(before).filter((c) => c.includes("/dataTypes/heart-rate/")).length;
  assert.equal(hrCalls, 0);
});

test("log a match with how it felt, then edit and delete it", async () => {
  const { open } = setup();
  await open("/login", form({ password: "correct horse" }));
  const t = Date.UTC(2026, 9, 1, 15, 0);
  const padel = { sport: "padel", startedAt: t, endedAt: t + 85 * 60_000, utcOffsetMinutes: 300, partner: "Ali", opponents: ["Hamza", "Saad"] };

  const draw = await open("/api/matches", send("POST", { ...padel, scores: [[6, 6]] }));
  assert.equal(draw.status, 400);
  assert.match((await reply(draw)).message, /can't be a draw/);
  const asForm = await open("/api/matches", form({ sport: "padel" }));
  assert.equal(asForm.status, 400, "the API only takes JSON");

  const saved = await reply(await open("/api/matches", send("POST", { ...padel, scores: [[6, 4], [3, 6], [7, 5]], note: { text: "Felt sharp", rpe: 6 } })));
  assert.equal(saved.ok, true, saved.message);
  const match = saved.state.data.matches.find((m: { id: string }) => m.id === saved.id);
  assert.equal(match.sport, "padel");
  assert.equal(match.result, "win");
  assert.equal(match.partner, "Ali");
  assert.deepEqual(match.opponents, ["Hamza", "Saad"]);
  assert.deepEqual(saved.state.notes[saved.id], { text: "Felt sharp", rpe: 6, updatedAt: saved.state.notes[saved.id].updatedAt });

  const note = await reply(await open(`/api/notes/${saved.id}`, send("PUT", { text: "Legs heavy in set 2", rpe: 8 })));
  assert.equal(note.notes[saved.id].rpe, 8);

  const edited = await reply(await open("/api/matches", send("POST", { ...padel, id: saved.id, scores: [[4, 6], [3, 6]] })));
  assert.equal(edited.id, saved.id);
  assert.equal(edited.state.data.matches.filter((m: { sport: string }) => m.sport === "padel").length, 1);
  assert.equal(edited.state.data.matches.find((m: { id: string }) => m.id === saved.id).result, "loss");

  const golf = await reply(
    await open("/api/matches", send("POST", { sport: "golf", startedAt: t + 86_400_000, endedAt: t + 86_400_000 + 130 * 60_000, golf: { holes: 9, strokes: 44, par: 36, course: "DHA" } })),
  );
  assert.deepEqual(golf.state.data.matches.find((m: { id: string }) => m.id === golf.id).strokes, { course: "DHA", holes: 9, strokes: 44, par: 36, perHole: null });

  const gone = await reply(await open(`/api/matches/${saved.id}`, { method: "DELETE", headers: { origin: BASE } }));
  assert.equal(gone.ok, true);
  assert.ok(!gone.state.data.matches.some((m: { id: string }) => m.id === saved.id));
  assert.equal(gone.state.notes[saved.id], undefined, "its note goes too");
  assert.equal((await open("/api/matches/csl:whatever", { method: "DELETE", headers: { origin: BASE } })).status, 400, "imported matches can't be deleted");
});

test("a logged match gets the heart rate of the watch workout picked for it", async () => {
  const session = syntheticMatch();
  const sim = simulateSession(session, mulberry32(4), {}, "a")!;
  // Whole milliseconds, as the API reports them.
  const recording = { ...sim.recording, id: "workout-1", start: Math.floor(sim.recording.start), end: Math.floor(sim.recording.end) };
  const steps = Array.from({ length: Math.ceil((recording.end - recording.start) / 60_000) }, (_, k) => ({
    start: recording.start + k * 60_000,
    end: recording.start + (k + 1) * 60_000,
    count: 70,
  }));
  const wearable: WearableData = { provider: "test", syncedAt: 0, recordings: [recording], heartRate: sim.samples, steps, daily: [] };
  const { open } = setup({}, { wearable });
  await open("/login", form({ password: "correct horse" }));
  await connect(open);
  await open("/api/settings", send("PUT", { name: "Bilal" }));

  const found = await reply(await open(`/api/workouts?from=${recording.start - 3600_000}&to=${recording.end + 3600_000}`));
  assert.deepEqual((found as unknown as { workouts: { id: string }[] }).workouts.map((w) => w.id), ["workout-1"]);

  const saved = await reply(
    await open(
      "/api/matches",
      send("POST", {
        sport: "squash",
        // Typed a few minutes off; the workout's start and stop are used.
        startedAt: session.startedAt + 4 * 60_000,
        endedAt: session.endedAt! - 2 * 60_000,
        opponents: ["Bob"],
        scores: [[11, 9], [5, 11], [12, 10]],
        workoutId: "workout-1",
      }),
    ),
  );
  assert.equal(saved.ok, true, saved.message);
  const synced = await reply(await open("/sync", post));
  assert.equal(synced.ok, true, synced.message);
  const state = await reply(await open("/api/data"));
  const m = (state as unknown as { data: { matches: any[] } }).data.matches.find((x) => x.id === saved.id);
  assert.equal(m.startedAt, recording.start);
  assert.equal(m.endedAt, recording.end);
  assert.ok(m.hr && m.hr.avg > 100, "heart rate from the workout");
  assert.equal(m.tally.won, 28);
  assert.ok(m.efficiency.beatsPerUnit > 0);
  assert.equal(m.chart.segments.length, 3, "games placed on the clock");
});

test("AI insights: asked on request, cached, costed, and stopped at the monthly budget", async () => {
  const { open, net } = setup({ OPENAI_API_KEY: "sk-test" });
  await open("/login", form({ password: "correct horse" }));
  await open("/me", send("POST", { me: "Bilal" }));

  const first = await reply(await open("/api/ai", send("POST", { scope: "overview", sport: "all" })));
  assert.equal(first.ok, true, first.message);
  assert.equal(first.cached, false);
  assert.match(first.insight.text, /hold the T/);
  assert.equal(first.usage.month.requests, 1);
  assert.ok(Math.abs(first.usage.month.costUsd - 0.0006) < 1e-9, `cost ${first.usage.month.costUsd}`);

  const sent = net.openai[0];
  assert.equal(sent.model, "gpt-5.6-luna");
  assert.equal(sent.store, false, "nothing kept at OpenAI");
  assert.ok(sent.input.length < 2000, `a compact prompt (${sent.input.length} chars)`);

  const again = await reply(await open("/api/ai", send("POST", { scope: "overview", sport: "all" })));
  assert.equal(again.cached, true);
  assert.equal(net.openai.length, 1, "the same data isn't paid for twice");

  assert.equal((await open("/api/settings", send("PUT", { aiBudgetUsd: 0.0005 }))).status, 200);
  const data = (await (await open("/api/data")).json()) as { data: { matches: { id: string }[] } };
  const capped = await reply(await open("/api/ai", send("POST", { scope: "match", id: data.data.matches[0].id })));
  assert.equal(capped.ok, false);
  assert.match(capped.message, /budget/);
  assert.equal(net.openai.length, 1);

  assert.equal((await open("/api/settings", send("PUT", { hrMax: 300 }))).status, 400);
  assert.equal((await open("/api/settings", send("PUT", { aiModel: "gpt-nope" }))).status, 400);
});

test("without an OpenAI key the AI explains how to switch it on", async () => {
  const { open } = setup();
  await open("/login", form({ password: "correct horse" }));
  await open("/me", send("POST", { me: "Bilal" }));
  const res = await reply(await open("/api/ai", send("POST", { scope: "overview" })));
  assert.equal(res.ok, false);
  assert.match(res.message, /OPENAI_API_KEY/);
});

test("a sync that runs out of time resumes where it stopped", async () => {
  const { open } = setup({ ME: "Usama" }, { syncBudgetMs: -1 });
  await open("/login", form({ password: "correct horse" }));
  await connect(open);
  const first = await reply(await open("/sync", post));
  assert.equal(first.ok, true);
  assert.ok(first.pending > 0, "everything left for later");
});

test("without configuration it only shows setup help", async () => {
  const app = createApp({ kv: null, env: {} });
  const res = await app(new Request(`${BASE}/`));
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.match(text, /APP_PASSWORD/);
  assert.match(text, /Upstash for Redis/);
  const manifest = await app(new Request(`${BASE}/manifest.webmanifest`));
  assert.equal(manifest.status, 200, "the home-screen manifest needs no sign-in");
});

test("nightly sync needs the cron secret", async () => {
  const { app } = setup({ CRON_SECRET: "s3cret" });
  assert.equal((await app(new Request(`${BASE}/cron/sync`))).status, 401);
  const res = await app(new Request(`${BASE}/cron/sync`, { headers: { authorization: "Bearer s3cret" } }));
  assert.equal(res.status, 200);
  assert.equal((await reply(res)).ok, true);
});

test("cross-site requests that change things are rejected", async () => {
  const { open } = setup();
  await open("/login", form({ password: "correct horse" }));
  assert.equal((await open("/sync", { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
  const del = await open("/api/matches/x", { method: "DELETE", headers: { origin: "https://evil.example" } });
  assert.equal(del.status, 403);
});
