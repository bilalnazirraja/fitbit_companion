// The hosted Performance Journal as one Web-standard request handler (Request → Response).
// The Vercel function and `npm run serve` both run this.
//
//   GET  /login, POST /login, GET /logout   password sign-in (everything else requires it)
//   GET  /                                  the dashboard, with sync controls on top
//   GET  /connect → Google → /oauth/callback  connect Google Health (Fitbit data)
//   POST /sync                              pull scores + watch data, rebuild the analysis
//   POST /me                                say which league player you are
//   GET  /cron/sync                         nightly sync (Vercel Cron, needs CRON_SECRET)
import { randomBytes } from "node:crypto";
import { buildDataset, type Dataset } from "../analysis/dataset.ts";
import { renderDashboard } from "../dashboard/render.ts";
import type { Session, WearableData } from "../model.ts";
import { fetchLeagueState, toSessions } from "../sources/club-squash-league.ts";
import { createClient } from "../sources/google-health/client.ts";
import { buildAuthUrl, exchangeCode, pkcePair, ReconnectError, refresh, type OAuthClient } from "../sources/google-health/oauth.ts";
import { googleHealthProvider } from "../sources/google-health/provider.ts";
import { guessMe, syncWearable } from "../sync/wearable-sync.ts";
import type { Kv } from "./kv.ts";
import { controlsHtml, loginPage, messagePage, setupPage } from "./pages.ts";
import { repo, type Repo, type SyncStatus } from "./repo.ts";
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

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  const { env } = deps;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const budgetMs = deps.syncBudgetMs ?? 45_000;
  const scoresUrl = env.SCORES_URL || DEFAULT_SCORES_URL;

  const google: OAuthClient | null =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, fetch: doFetch }
      : null;

  return async (req) => {
    try {
      return await route(req);
    } catch (err) {
      log(`Unhandled error: ${(err as Error).stack ?? String(err)}`);
      return html(500, messagePage("Something went wrong", (err as Error).message));
    }
  };

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const missing = [
      !env.APP_PASSWORD && "APP_PASSWORD: the password that protects your data",
      !deps.kv && "A Redis store: Storage → Create Database → Upstash for Redis, connected to this project",
    ].filter((m): m is string => Boolean(m));
    if (missing.length > 0) return html(503, setupPage(missing));

    const r = repo(deps.kv!);
    const sign = signer(env.SESSION_SECRET || env.APP_PASSWORD!, now);
    const secure = url.protocol === "https:";
    const cookies = parseCookies(req.headers.get("cookie"));

    if (path === "/cron/sync") return cron(req, r);
    if (path === "/login") return req.method === "POST" ? login(req, sign, secure) : html(200, loginPage());
    if (path === "/logout") return redirect("/login", [setCookie(SESSION_COOKIE, "", { maxAgeSec: 0, secure })]);

    if (!sign.open(cookies[SESSION_COOKIE])) {
      return req.method === "GET" ? redirect("/login") : json(401, { ok: false, message: "Signed out. Reload the page and sign in again." });
    }
    // Session cookies are SameSite=Lax already; this also rejects any cross-site form posts.
    const origin = req.headers.get("origin");
    if (req.method === "POST" && origin && origin !== url.origin) return json(403, { ok: false, message: "Cross-site request blocked." });

    switch (`${req.method} ${path}`) {
      case "GET /":
        return dashboard(r, url);
      case "GET /connect":
        return connect(url, sign, secure);
      case "GET /oauth/callback":
        return callback(url, r, sign, cookies[OAUTH_COOKIE], secure);
      case "POST /sync":
        return json(200, await sync(r));
      case "POST /me":
        return saveMe(req, r);
      case "GET /api/status":
        return json(200, { connected: Boolean(await r.token()), me: await currentMe(r), lastSync: await r.syncStatus() });
      default:
        return html(404, messagePage("Not found", "There's nothing at this address."));
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
        : "Google Health connected. Press Sync now to pull your heart rate.";
    return redirect(flashUrl(message), [clear]);
  }

  async function currentMe(r: Repo): Promise<string | null> {
    return env.ME || (await r.me());
  }

  async function accessToken(r: Repo, force = false): Promise<string> {
    let token = await r.token();
    if (!token || !google) throw new ReconnectError("Google Health isn't connected. Press Connect Google Health.");
    if (force || token.expires_at - 60_000 < now()) {
      token = await refresh(google, token);
      await r.saveToken(token);
    }
    return token.access_token;
  }

  function analyse(sessions: Session[], wearable: WearableData | null, me: string | null): { dataset: Dataset; note: string } {
    const opts = { hrMax: num(env.HR_MAX), breakSec: num(env.GAME_BREAK_SECONDS) ?? 90 };
    try {
      return { dataset: buildDataset(sessions, wearable, { ...opts, me: me ?? undefined }), note: "" };
    } catch (err) {
      // An unknown ME shouldn't take the whole dashboard down.
      return { dataset: buildDataset(sessions, wearable, opts), note: ` ${(err as Error).message}` };
    }
  }

  async function sync(r: Repo): Promise<SyncStatus> {
    const started = now();
    try {
      const state = await fetchLeagueState(scoresUrl, doFetch);
      await r.saveScores(state);
      const sessions = toSessions(state);
      const me = await currentMe(r);
      let wearable = await r.wearable();
      let pending = 0;
      let note = "";
      if (google && (await r.token())) {
        const client = createClient({ getAccessToken: (force) => accessToken(r, force), fetch: doFetch });
        const result = await syncWearable(googleHealthProvider(client, log), sessions, wearable ?? undefined, {
          me: me ?? undefined,
          deadline: started + budgetMs,
          log,
        });
        wearable = result.data;
        pending = result.pending;
        await r.saveWearable(wearable, result.changedDays);
      } else {
        note = " Connect Google Health to add your heart rate.";
      }
      const built = analyse(sessions, wearable, me);
      await r.saveDataset(built.dataset);
      const q = built.dataset.quality;
      const top = !me && wearable ? guessMe(sessions, wearable.recordings)[0] : undefined;
      const status: SyncStatus = {
        at: now(),
        ok: true,
        pending,
        message:
          `${q.matches} matches, ${q.withHr} with heart rate.` +
          (pending > 0 ? ` ${pending} workout(s) still downloading.` : "") +
          note +
          built.note,
        guess: top && top.matched > 0 ? top.name : null,
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

  /** The league as last synced, fetched from the scoring app the first time. */
  async function league(r: Repo) {
    let state = await r.scores();
    if (!state) {
      state = await fetchLeagueState(scoresUrl, doFetch);
      await r.saveScores(state);
    }
    return state;
  }

  async function dashboard(r: Repo, url: URL): Promise<Response> {
    let dataset = await r.dataset();
    if (!dataset) {
      // First visit: show the scores straight away, heart rate comes with the first sync.
      dataset = analyse(toSessions(await league(r)), await r.wearable(), await currentMe(r)).dataset;
      await r.saveDataset(dataset);
    }
    const [token, status, me] = await Promise.all([r.token(), r.syncStatus(), currentMe(r)]);
    const controls = controlsHtml({
      googleConfigured: Boolean(google),
      connected: Boolean(token),
      status,
      me,
      meLocked: Boolean(env.ME),
      players: dataset.players.map((p) => p.name),
      flash: url.searchParams.get("flash"),
    });
    return html(200, renderDashboard(dataset, { controls }));
  }

  async function saveMe(req: Request, r: Repo): Promise<Response> {
    if (env.ME) return redirect(flashUrl(`ME is set to ${env.ME} in the environment variables; change it there.`));
    const name = String((await req.formData()).get("me") ?? "");
    const state = await league(r);
    if (name && !state.players.some((p) => p.name === name)) return redirect(flashUrl("That player isn't in the league."));
    await r.saveMe(name);
    await r.saveDataset(analyse(toSessions(state), await r.wearable(), name || null).dataset);
    return redirect(flashUrl(name ? `Saved: you're ${name}. Heart rate is matched to your games.` : "Cleared."));
  }

  async function cron(req: Request, r: Repo): Promise<Response> {
    const auth = req.headers.get("authorization") ?? "";
    if (!env.CRON_SECRET || !sameText(auth, `Bearer ${env.CRON_SECRET}`)) {
      return json(401, { ok: false, message: "Nightly sync is off. Set CRON_SECRET to turn it on." });
    }
    return json(200, await sync(r));
  }
}

function flashUrl(message: string): string {
  return `/?flash=${encodeURIComponent(message)}`;
}

function num(v: string | undefined): number | undefined {
  const n = Number(v);
  return v && Number.isFinite(n) ? n : undefined;
}

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

function redirect(location: string, cookies: string[] = [], status = 303): Response {
  return new Response(null, { status, headers: withCookies({ location }, cookies) });
}
