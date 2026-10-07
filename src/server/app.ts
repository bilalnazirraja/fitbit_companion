// The hosted Performance Journal as one Web-standard request handler (Request → Response).
// The Vercel function and `npm run serve` both run this.
//
//   GET  /login, POST /login, GET /logout       password sign-in (everything else requires it)
//   GET  /                                      the app, with your data embedded
//   GET  /api/data                              the same data as JSON
//   POST /api/matches                           log a match, or edit one (the body carries its id)
//   DELETE /api/matches/:id                     delete a match you logged
//   PUT  /api/notes/:id                         how a match felt: comment and effort (1-10)
//   GET  /api/workouts?from=&to=                your watch workouts in a time range, to fill in times
//   POST /api/ai                                an AI read on one match or on recent form (OpenAI)
//   PUT  /api/settings                          name, max heart rate, AI model and monthly AI budget
//   POST /me                                    which player you are in the imported squash league
//   GET  /connect → Google → /oauth/callback    connect Google Health (Fitbit data)
//   POST /sync                                  pull watch data for your matches, rebuild the analysis
//   GET  /cron/sync                             nightly sync (Vercel Cron, needs CRON_SECRET)
//   GET  /manifest.webmanifest, /icon.svg       lets a phone add the app to its home screen
import { createHash, randomBytes } from "node:crypto";
import { buildDataset, DATASET_VERSION, type Dataset } from "../analysis/dataset.ts";
import { AiError, ask, costUsd, MODELS, modelInfo, type TokenCounts } from "../ai/openai.ts";
import { INSTRUCTIONS, matchPrompt, overviewPrompt } from "../ai/prompts.ts";
import { renderApp, type AppState, type UsageSummary } from "../dashboard/render.ts";
import { entryToSession, InputError, parseEntry, parseNote, SPORTS, type Sport } from "../journal/entries.ts";
import type { Session, WearableData } from "../model.ts";
import { fetchLeagueState, toSessions, type LeagueState } from "../sources/club-squash-league.ts";
import { createClient } from "../sources/google-health/client.ts";
import { buildAuthUrl, exchangeCode, pkcePair, ReconnectError, refresh, type OAuthClient } from "../sources/google-health/oauth.ts";
import { googleHealthProvider } from "../sources/google-health/provider.ts";
import { syncWearable } from "../sync/wearable-sync.ts";
import type { Kv } from "./kv.ts";
import { loginPage, messagePage, setupPage } from "./pages.ts";
import { parseSettings, repo, type AiUsage, type Repo, type SavedInsight, type Settings, type SyncStatus } from "./repo.ts";
import { parseCookies, passwordMatches, sameText, setCookie, signer, type Signer } from "./session.ts";

export interface AppEnv {
  APP_PASSWORD?: string;
  SESSION_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** e.g. https://my-journal.vercel.app — keeps Google's redirect address stable across deployments. */
  PUBLIC_URL?: string;
  SCORES_URL?: string;
  ME?: string;
  HR_MAX?: string;
  GAME_BREAK_SECONDS?: string;
  CRON_SECRET?: string;
  /** Turns on AI insights. */
  OPENAI_API_KEY?: string;
  /** Offer a model besides the GPT-5.6 ones (priced like the dearest of them, to be safe). */
  OPENAI_MODEL?: string;
}

export interface AppDeps {
  /** null when no storage is configured: the app then only shows setup help. */
  kv: Kv | null;
  env: AppEnv;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
  /** After this long, a sync stops starting downloads and reports what's left (ms). */
  syncBudgetMs?: number;
}

const SESSION_COOKIE = "pj_session";
const OAUTH_COOKIE = "pj_oauth";
const SESSION_DAYS = 30;
const DEFAULT_SCORES_URL = "https://club-squash-league.vercel.app/api/state";
const DAY = 86_400_000;
/** Saved AI answers kept; the oldest go first. */
const MAX_INSIGHTS = 200;

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  const { env } = deps;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const budgetMs = deps.syncBudgetMs ?? 45_000;
  const scoresUrl = env.SCORES_URL || DEFAULT_SCORES_URL;
  const modelIds = [...MODELS.map((m) => m.id), ...(env.OPENAI_MODEL ? [env.OPENAI_MODEL] : [])];

  const google: OAuthClient | null =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, fetch: doFetch }
      : null;

  return async (req) => {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof InputError) return json(400, { ok: false, message: err.message });
      log(`Unhandled error: ${(err as Error).stack ?? String(err)}`);
      if (new URL(req.url).pathname.startsWith("/api/")) return json(500, { ok: false, message: (err as Error).message });
      return html(500, messagePage("Something went wrong", (err as Error).message));
    }
  };

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // Public: they hold no data, and the phone fetches them without the sign-in cookie.
    if (path === "/manifest.webmanifest") return asset(JSON.stringify(MANIFEST), "application/manifest+json");
    if (path === "/icon.svg") return asset(ICON_SVG, "image/svg+xml");

    const missing = [
      !env.APP_PASSWORD && "APP_PASSWORD: the password that protects your data",
      !deps.kv && "A Redis store: Storage → Create Database → Upstash for Redis, connected to this project",
    ].filter((m): m is string => Boolean(m));
    if (missing.length > 0) return html(503, setupPage(missing));

    const r = repo(deps.kv!);
    const sign = signer(env.SESSION_SECRET || env.APP_PASSWORD!, now);
    const secure = url.protocol === "https:";
    const cookies = parseCookies(req.headers.get("cookie"));
    const isApi = path.startsWith("/api/");

    if (path === "/cron/sync") return cron(req, r);
    if (path === "/login") return req.method === "POST" ? login(req, sign, secure) : html(200, loginPage());
    if (path === "/logout") return redirect("/login", [setCookie(SESSION_COOKIE, "", { maxAgeSec: 0, secure })]);

    if (!sign.open(cookies[SESSION_COOKIE])) {
      return req.method === "GET" && !isApi
        ? redirect("/login")
        : json(401, { ok: false, message: "Signed out. Reload the page and sign in again." });
    }
    // Session cookies are SameSite=Lax already; this also rejects any cross-site requests that change things.
    const origin = req.headers.get("origin");
    if (req.method !== "GET" && req.method !== "HEAD" && origin && origin !== url.origin) {
      return json(403, { ok: false, message: "Cross-site request blocked." });
    }

    if (isApi) {
      const [, , kind, id] = path.split("/");
      try {
        return await api(req, url, r, kind, id === undefined ? undefined : decodeURIComponent(id));
      } catch (err) {
        if (err instanceof ReconnectError || err instanceof AiError) return json(200, { ok: false, message: err.message });
        throw err;
      }
    }
    switch (`${req.method} ${path}`) {
      case "GET /":
        return html(200, renderApp(await state(r, url.searchParams.get("flash"))));
      case "GET /connect":
        return connect(url, sign, secure);
      case "GET /oauth/callback":
        return callback(url, r, sign, cookies[OAUTH_COOKIE], secure);
      case "POST /sync":
        return json(200, await sync(r));
      case "POST /me":
        return saveMe(req, r);
      default:
        return html(404, messagePage("Not found", "There's nothing at this address."));
    }
  }

  async function api(req: Request, url: URL, r: Repo, kind: string, id: string | undefined): Promise<Response> {
    switch (`${req.method} ${kind}${id === undefined ? "" : "/:id"}`) {
      case "GET data":
        return json(200, await state(r, null));
      case "GET status":
        return json(200, { connected: Boolean(await r.token()), me: await currentMe(r), lastSync: await r.syncStatus() });
      case "POST matches":
        return saveMatch(req, r);
      case "DELETE matches/:id":
        return deleteMatch(r, id!);
      case "PUT notes/:id":
        return saveNote(req, r, id!);
      case "GET workouts":
        return workouts(url, r);
      case "POST ai":
        return insight(req, r);
      case "PUT settings":
        return saveSettings(req, r);
      default:
        return json(404, { ok: false, message: "Not found." });
    }
  }

  async function login(req: Request, sign: Signer, secure: boolean): Promise<Response> {
    const form = await req.formData();
    if (!passwordMatches(String(form.get("password") ?? ""), env.APP_PASSWORD!)) {
      await new Promise((resolve) => setTimeout(resolve, 600)); // slow down guessing
      return html(401, loginPage("That password didn't match."));
    }
    const ttl = SESSION_DAYS * 86_400;
    return redirect("/", [setCookie(SESSION_COOKIE, sign.seal({ v: 1 }, ttl), { maxAgeSec: ttl, secure })]);
  }

  function redirectUri(url: URL): string {
    return `${env.PUBLIC_URL?.replace(/\/+$/, "") || url.origin}/oauth/callback`;
  }

  function connect(url: URL, sign: Signer, secure: boolean): Response {
    if (!google) return html(503, setupPage(["GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from your Google Cloud OAuth client"]));
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("hex");
    const target = buildAuthUrl(google.clientId, redirectUri(url), state, challenge);
    return redirect(target, [setCookie(OAUTH_COOKIE, sign.seal({ state, verifier }, 600), { maxAgeSec: 600, secure })], 302);
  }

  async function callback(url: URL, r: Repo, sign: Signer, cookie: string | undefined, secure: boolean): Promise<Response> {
    const clear = setCookie(OAUTH_COOKIE, "", { maxAgeSec: 0, secure });
    const error = url.searchParams.get("error");
    if (error) return redirect(flashUrl(`Google sign-in didn't complete (${error}).`), [clear]);
    const saved = sign.open<{ state: string; verifier: string }>(cookie);
    if (!google || !saved || saved.state !== url.searchParams.get("state")) {
      return html(400, messagePage("Sign-in expired", "That sign-in link has expired or didn't come from this app. Press Connect again."), [clear]);
    }
    const { token, missingScopes } = await exchangeCode(google, url.searchParams.get("code") ?? "", redirectUri(url), saved.verifier);
    await r.saveToken(token);
    const message =
      missingScopes.length > 0
        ? "Connected, but some permissions were left unticked, so some data will be missing. Reconnect and tick all three."
        : "Google Health connected. Sync to pull your heart rate and steps.";
    return redirect(flashUrl(message), [clear]);
  }

  async function currentMe(r: Repo): Promise<string | null> {
    return env.ME || (await r.me());
  }

  async function accessToken(r: Repo, force = false): Promise<string> {
    let token = await r.token();
    if (!token || !google) throw new ReconnectError("Google Health isn't connected. Connect it in Settings.");
    if (force || token.expires_at - 60_000 < now()) {
      token = await refresh(google, token);
      await r.saveToken(token);
    }
    return token.access_token;
  }

  /** The squash league as imported, fetched from the scoring app only if it was never imported. */
  async function league(r: Repo): Promise<LeagueState | null> {
    const stored = await r.scores();
    if (stored) return stored;
    try {
      const state = await fetchLeagueState(scoresUrl, doFetch);
      await r.saveScores(state);
      return state;
    } catch (err) {
      log(`League import skipped: ${(err as Error).message}`);
      return null;
    }
  }

  /** Your matches: the league ones you played (nobody else's) plus the ones you logged. */
  async function mySessions(r: Repo, wearable: WearableData | null): Promise<{ sessions: Session[]; me: string | null }> {
    const [state, journal, settings, leagueMe] = await Promise.all([league(r), r.journal(), r.settings(), currentMe(r)]);
    const player = leagueMe ? state?.players.find((p) => p.name.toLowerCase() === leagueMe.toLowerCase()) : undefined;
    const me = { id: player?.id ?? "me", name: player?.name ?? settings.name ?? "Me" };
    const fromLeague = player && state ? toSessions(state).filter((s) => s.participants.some((p) => p.id === player.id)) : [];
    const logged = journal.map((e) => entryToSession(e, me, wearable?.recordings ?? []));
    const sessions = [...fromLeague, ...logged].sort((a, b) => a.startedAt - b.startedAt);
    return { sessions, me: sessions.length > 0 ? me.name : null };
  }

  function analyse(sessions: Session[], wearable: WearableData | null, me: string | null, settings: Settings): Dataset {
    const opts = { hrMax: settings.hrMax ?? num(env.HR_MAX), breakSec: num(env.GAME_BREAK_SECONDS) ?? 90, onlyMine: true };
    try {
      return buildDataset(sessions, wearable, { ...opts, me: me ?? undefined, players: me ? [me] : [] });
    } catch (err) {
      log(`Analysis without a player: ${(err as Error).message}`);
      return buildDataset([], wearable, opts);
    }
  }

  async function rebuild(r: Repo, wearable?: WearableData | null): Promise<Dataset> {
    const w = wearable === undefined ? await r.wearable() : wearable;
    const { sessions, me } = await mySessions(r, w);
    const data = analyse(sessions, w, me, await r.settings());
    await r.saveDataset(data);
    return data;
  }

  async function dataset(r: Repo): Promise<Dataset> {
    const stored = await r.dataset();
    return stored && stored.version === DATASET_VERSION ? stored : rebuild(r);
  }

  async function state(r: Repo, flash: string | null): Promise<AppState> {
    const data = await dataset(r);
    const [token, lastSync, settings, notes, journal, scores, leagueMe, usage, insights] = await Promise.all([
      r.token(),
      r.syncStatus(),
      r.settings(),
      r.notes(),
      r.journal(),
      r.scores(),
      currentMe(r),
      r.aiUsage(),
      r.aiInsights(),
    ]);
    return {
      data,
      hosted: true,
      name: settings.name ?? leagueMe ?? null,
      notes,
      entries: Object.fromEntries(journal.map((e) => [e.id, e])),
      league: scores ? { players: scores.players.map((p) => p.name).sort(), me: leagueMe, locked: Boolean(env.ME) } : null,
      google: { configured: Boolean(google), connected: Boolean(token), lastSync },
      ai: {
        configured: Boolean(env.OPENAI_API_KEY),
        models: modelIds.map(modelInfo),
        usage: usageSummary(usage, settings),
        insights,
      },
      settings,
      flash,
    };
  }

  async function sync(r: Repo): Promise<SyncStatus> {
    const started = now();
    try {
      let wearable = await r.wearable();
      const { sessions } = await mySessions(r, wearable);
      let pending = 0;
      let note = "";
      if (sessions.length === 0) {
        note = " Log a match, then sync to pull its heart rate.";
      } else if (google && (await r.token())) {
        const client = createClient({ getAccessToken: (force) => accessToken(r, force), fetch: doFetch });
        const result = await syncWearable(googleHealthProvider(client, log), sessions, wearable ?? undefined, {
          mine: () => true,
          deadline: started + budgetMs,
          log,
        });
        wearable = result.data;
        pending = result.pending;
        await r.saveWearable(wearable, result.changedDays);
      } else {
        note = " Connect Google Health to add your heart rate.";
      }
      // Logged matches snap to watch workouts found just now, so the sessions are rebuilt.
      const q = (await rebuild(r, wearable)).quality;
      const status: SyncStatus = {
        at: now(),
        ok: true,
        pending,
        message:
          `${q.matches} matches, ${q.withHr} with heart rate.` + (pending > 0 ? ` ${pending} workout(s) still downloading.` : "") + note,
      };
      await r.saveSyncStatus(status);
      return status;
    } catch (err) {
      log(`Sync failed: ${(err as Error).stack ?? String(err)}`);
      const message = err instanceof ReconnectError ? err.message : `Sync failed: ${(err as Error).message.split("\n")[0]}`;
      const status: SyncStatus = { at: now(), ok: false, pending: 0, message };
      await r.saveSyncStatus(status).catch(() => {});
      return status;
    }
  }

  async function saveMatch(req: Request, r: Repo): Promise<Response> {
    const input = (await readJson(req)) as Record<string, unknown>;
    const journal = await r.journal();
    const id = typeof input.id === "string" && input.id ? input.id : null;
    const existing = id ? journal.find((e) => e.id === id) : undefined;
    if (id && !existing) throw new InputError("That match no longer exists. Reload the page.");
    const entry = parseEntry(input, now(), existing);
    const note = input.note === undefined ? null : parseNote(input.note, now());
    await r.saveJournal(existing ? journal.map((e) => (e.id === entry.id ? entry : e)) : [...journal, entry]);
    if (note) {
      const notes = await r.notes();
      if (note.text || note.rpe !== null) notes[entry.id] = note;
      else delete notes[entry.id];
      await r.saveNotes(notes);
    }
    await rebuild(r);
    return json(200, { ok: true, id: entry.id, state: await state(r, null) });
  }

  async function deleteMatch(r: Repo, id: string): Promise<Response> {
    const journal = await r.journal();
    if (!journal.some((e) => e.id === id)) throw new InputError("Only matches you logged here can be deleted.");
    await r.saveJournal(journal.filter((e) => e.id !== id));
    const [notes, insights] = await Promise.all([r.notes(), r.aiInsights()]);
    if (notes[id]) {
      delete notes[id];
      await r.saveNotes(notes);
    }
    if (insights[`match:${id}`]) {
      delete insights[`match:${id}`];
      await r.saveAiInsights(insights);
    }
    await rebuild(r);
    return json(200, { ok: true, state: await state(r, null) });
  }

  async function saveNote(req: Request, r: Repo, id: string): Promise<Response> {
    const note = parseNote(await readJson(req), now());
    const data = await dataset(r);
    if (!data.matches.some((m) => m.id === id)) throw new InputError("That match isn't in your journal.");
    const notes = await r.notes();
    if (note.text || note.rpe !== null) notes[id] = note;
    else delete notes[id];
    await r.saveNotes(notes);
    return json(200, { ok: true, notes });
  }

  async function saveSettings(req: Request, r: Repo): Promise<Response> {
    const current = await r.settings();
    const next = parseSettings(await readJson(req), current, modelIds);
    await r.saveSettings(next);
    if (next.hrMax !== current.hrMax || next.name !== current.name) await rebuild(r);
    return json(200, { ok: true, state: await state(r, null) });
  }

  async function saveMe(req: Request, r: Repo): Promise<Response> {
    const asJson = (req.headers.get("content-type") ?? "").includes("application/json");
    const name = asJson
      ? String(((await readJson(req)) as { me?: unknown }).me ?? "")
      : String((await req.formData()).get("me") ?? "");
    const fail = (message: string) => (asJson ? json(400, { ok: false, message }) : redirect(flashUrl(message)));
    if (env.ME) return fail(`ME is set to ${env.ME} in the environment variables; change it there.`);
    const state0 = await league(r);
    if (name && !state0?.players.some((p) => p.name === name)) return fail("That player isn't in the league.");
    await r.saveMe(name);
    await rebuild(r);
    const message = name ? `Saved: you're ${name}. Only your matches are shown.` : "Cleared.";
    return asJson ? json(200, { ok: true, message, state: await state(r, null) }) : redirect(flashUrl(message));
  }

  /** Watch workouts in [from, to), straight from Google Health, so the log form can use their times. */
  async function workouts(url: URL, r: Repo): Promise<Response> {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 3 * DAY) {
      throw new InputError("Ask for at most three days of workouts.");
    }
    if (!google || !(await r.token())) return json(200, { ok: true, connected: false, workouts: [] });
    const client = createClient({ getAccessToken: (force) => accessToken(r, force), fetch: doFetch });
    const found = await googleHealthProvider(client, log).recordings({ from, to });
    const journal = await r.journal();
    return json(200, {
      ok: true,
      connected: true,
      workouts: found.map((w) => ({
        id: w.id,
        name: w.name,
        type: w.type,
        start: w.start,
        end: w.end,
        avgHr: w.summary.avgHr ?? null,
        steps: w.summary.steps ?? null,
        calories: w.summary.calories ?? null,
        usedBy: journal.find((e) => e.workoutId === w.id)?.id ?? null,
      })),
    });
  }

  function usageSummary(usage: Record<string, AiUsage>, settings: Settings): UsageSummary {
    const total = emptyUsage();
    for (const u of Object.values(usage)) addUsage(total, u, u.costUsd, u.requests);
    return { model: settings.aiModel, budgetUsd: settings.aiBudgetUsd, month: usage[monthOf(now())] ?? emptyUsage(), total };
  }

  async function insight(req: Request, r: Repo): Promise<Response> {
    if (!env.OPENAI_API_KEY) {
      return json(200, { ok: false, message: "Add OPENAI_API_KEY in Vercel (Settings → Environment Variables), then redeploy." });
    }
    const body = (await readJson(req)) as { scope?: unknown; id?: unknown; sport?: unknown; force?: unknown };
    const [data, settings, notes, saved, usage] = await Promise.all([dataset(r), r.settings(), r.notes(), r.aiInsights(), r.aiUsage()]);
    const name = settings.name ?? (await currentMe(r));

    let key: string;
    let input: string;
    if (body.scope === "match") {
      const m = data.matches.find((x) => x.id === body.id);
      if (!m) throw new InputError("That match isn't in your journal.");
      const before = data.matches.filter((x) => x.sport === m.sport && x.startedAt < m.startedAt && x.opponents.join() === m.opponents.join());
      key = `match:${m.id}`;
      input = matchPrompt(m, {
        name,
        usual: data.summaries[m.sport],
        note: notes[m.id],
        hrMax: data.hrMax,
        headToHead: before.length > 0 ? { won: before.filter((x) => x.result === "win").length, lost: before.filter((x) => x.result === "loss").length } : null,
      });
    } else {
      const sport = SPORTS.includes(body.sport as Sport) ? (body.sport as Sport) : "all";
      const matches = data.matches.filter((m) => sport === "all" || m.sport === sport);
      if (matches.length === 0) throw new InputError("Log a match first.");
      key = `overview:${sport}`;
      input = overviewPrompt(matches, { name, sport, summaries: data.summaries, notes });
    }

    const model = settings.aiModel;
    const hash = createHash("sha256").update(`${model}\n${INSTRUCTIONS}\n${input}`).digest("hex").slice(0, 16);
    // Same data, same model: the saved answer is all a new request would give.
    if (saved[key]?.hash === hash) return json(200, { ok: true, insight: saved[key], cached: true, usage: usageSummary(usage, settings) });

    const month = monthOf(now());
    const spent = usage[month]?.costUsd ?? 0;
    if (spent >= settings.aiBudgetUsd) {
      return json(200, {
        ok: false,
        message: `This month's AI budget ($${settings.aiBudgetUsd.toFixed(2)}) is used up. Raise it in Settings if you want more.`,
      });
    }

    const answer = await ask({ apiKey: env.OPENAI_API_KEY, model, instructions: INSTRUCTIONS, input, fetch: doFetch });
    const cost = costUsd(model, answer.tokens);
    const bucket = usage[month] ?? emptyUsage();
    addUsage(bucket, answer.tokens, cost, 1);
    usage[month] = bucket;
    await r.saveAiUsage(usage);
    if (!answer.text) {
      return json(200, { ok: false, message: "The AI ran out of room before it answered. Try again.", usage: usageSummary(usage, settings) });
    }

    const result: SavedInsight = { text: answer.text, at: now(), model, hash, costUsd: cost, complete: answer.complete };
    saved[key] = result;
    const keep = Object.entries(saved).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_INSIGHTS);
    await r.saveAiInsights(Object.fromEntries(keep));
    return json(200, { ok: true, insight: result, cached: false, usage: usageSummary(usage, settings) });
  }

  async function cron(req: Request, r: Repo): Promise<Response> {
    const auth = req.headers.get("authorization") ?? "";
    if (!env.CRON_SECRET || !sameText(auth, `Bearer ${env.CRON_SECRET}`)) {
      return json(401, { ok: false, message: "Nightly sync is off. Set CRON_SECRET to turn it on." });
    }
    return json(200, await sync(r));
  }
}

async function readJson(req: Request): Promise<unknown> {
  // Requiring JSON also means a plain cross-site form can't reach these endpoints.
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) throw new InputError("Expected JSON.");
  const text = await req.text();
  if (text.length > 100_000) throw new InputError("That's too much data in one go.");
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError("Couldn't read that request.");
  }
}

function emptyUsage(): AiUsage {
  return { requests: 0, input: 0, cached: 0, output: 0, reasoning: 0, costUsd: 0 };
}

function addUsage(into: AiUsage, t: TokenCounts, cost: number, requests: number): void {
  into.requests += requests;
  into.input += t.input;
  into.cached += t.cached;
  into.output += t.output;
  into.reasoning += t.reasoning;
  into.costUsd = Math.round((into.costUsd + cost) * 1e6) / 1e6;
}

const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);

function flashUrl(message: string): string {
  return `/?flash=${encodeURIComponent(message)}`;
}

function num(v: string | undefined): number | undefined {
  const n = Number(v);
  return v && Number.isFinite(n) ? n : undefined;
}

const MANIFEST = {
  name: "Performance Journal",
  short_name: "Journal",
  description: "Your matches, heart rate and steps in one place.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#121411",
  theme_color: "#121411",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
};

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#121411"/><path d="M92 272h78l40-92 56 176 44-120 28 36h82" fill="none" stroke="#c6f432" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

function withCookies(headers: Record<string, string>, cookies: string[]): Headers {
  const h = new Headers({ ...SECURITY_HEADERS, ...headers });
  for (const c of cookies) h.append("set-cookie", c);
  return h;
}

function html(status: number, body: string, cookies: string[] = []): Response {
  return new Response(body, { status, headers: withCookies({ "content-type": "text/html; charset=utf-8" }, cookies) });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: withCookies({ "content-type": "application/json" }, []) });
}

function asset(body: string, type: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": type, "cache-control": "public, max-age=86400" } });
}

function redirect(location: string, cookies: string[] = [], status = 303): Response {
  return new Response(null, { status, headers: withCookies({ location }, cookies) });
}
