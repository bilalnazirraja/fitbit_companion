import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { simulateWearable } from "../src/demo/simulate.ts";
import type { WearableData } from "../src/model.ts";
import { createApp } from "../src/server/app.ts";
import { memoryKv } from "../src/server/kv.ts";
import { SCOPES } from "../src/sources/google-health/oauth.ts";
import { leagueSessions } from "./fixtures.ts";

const SCORES = readFileSync(resolve(import.meta.dirname, "..", "scores.txt"), "utf8");
const BASE = "https://journal.test";
const iso = (t: number) => new Date(t).toISOString();

/** Scores app, Google's token endpoint and the Google Health API, answering from simulated watch data. */
function fakeInternet(wearable: WearableData) {
  const calls: string[] = [];
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
    if (url.hostname === "health.googleapis.com") {
      const type = url.pathname.split("/dataTypes/")[1].split("/")[0];
      const [from, to] = [...(url.searchParams.get("filter") ?? "").matchAll(/"([^"]+)"/g)].map((m) => Date.parse(m[1]));
      if (type === "exercise") {
        return Response.json({
          dataPoints: wearable.recordings.map((r) => ({
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
      return Response.json({ dataPoints: [] });
    }
    throw new Error(`Unexpected request to ${url.href}`);
  }) as typeof fetch;
  return { doFetch, calls };
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

function setup(env: Record<string, string> = {}, extra: { syncBudgetMs?: number } = {}) {
  const { wearable } = simulateWearable(leagueSessions(), "Usama", { seed: 3 });
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
    ...extra,
  });
  return { app, kv, net, open: browser(app) };
}

type SyncReply = { ok: boolean; pending: number; message: string };
const reply = async (res: Response) => (await res.json()) as SyncReply;

const embedded = (html: string) =>
  JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)![1]);

test("nothing is visible without the password", async () => {
  const { open } = setup();
  const home = await open("/");
  assert.equal(home.status, 303);
  assert.equal(home.headers.get("location"), "/login");
  assert.equal((await open("/sync", { method: "POST" })).status, 401);
  assert.equal((await open("/login", form({ password: "wrong" }))).status, 401);

  const ok = await open("/login", form({ password: "correct horse" }));
  assert.equal(ok.status, 303);
  const page = await (await open("/")).text();
  assert.match(page, /Performance Journal/);
  assert.match(page, /Connect Google Health/);
  assert.equal(embedded(page).sessions.length, 51, "scores come straight from the league app");
});

test("connect Google Health, sync, and get heart rate on the dashboard", async () => {
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

  assert.equal((await open("/me", form({ me: "Usama" }))).status, 303);
  const synced = await reply(await open("/sync", { method: "POST", headers: { origin: BASE } }));
  assert.equal(synced.ok, true, synced.message);
  assert.equal(synced.pending, 0);

  const dataset = embedded(await (await open("/")).text());
  assert.equal(dataset.me.name, "Usama");
  assert.ok(dataset.quality.withHr >= 15, `${dataset.quality.withHr} matches with heart rate`);
  assert.ok([...kv.data.keys()].some((k) => k.startsWith("pj:hr:")), "heart rate stored per day");

  // A second sync only lists workouts; heart rate that's already in isn't downloaded again.
  const before = net.calls.length;
  await open("/sync", { method: "POST", headers: { origin: BASE } });
  const hrCalls = net.calls.slice(before).filter((c) => c.includes("/dataTypes/heart-rate/")).length;
  assert.equal(hrCalls, 0);
});

test("a sync that runs out of time resumes where it stopped", async () => {
  const { open } = setup({ ME: "Usama" }, { syncBudgetMs: -1 });
  await open("/login", form({ password: "correct horse" }));
  const start = new URL((await open("/connect")).headers.get("location")!);
  await open(`/oauth/callback?state=${start.searchParams.get("state")}&code=good-code`);
  const first = await reply(await open("/sync", { method: "POST", headers: { origin: BASE } }));
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
});

test("nightly sync needs the cron secret", async () => {
  const { app } = setup({ CRON_SECRET: "s3cret" });
  assert.equal((await app(new Request(`${BASE}/cron/sync`))).status, 401);
  const res = await app(new Request(`${BASE}/cron/sync`, { headers: { authorization: "Bearer s3cret" } }));
  assert.equal(res.status, 200);
  assert.equal((await reply(res)).ok, true);
});

test("cross-site form posts are rejected", async () => {
  const { open } = setup();
  await open("/login", form({ password: "correct horse" }));
  const res = await open("/sync", { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});
