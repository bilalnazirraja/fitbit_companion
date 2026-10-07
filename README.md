# Performance Journal

A personal sports companion that lines up **what happened in the match** (from the Club Squash League
scoring app) with **what your body was doing** (heart rate from your Fitbit), so you can see how your
physiology and performance change with the score:

> score → game situation → heart rate → rally outcome

It answers questions like: how does my heart rate react when I'm 3-4 points down? Do I win fewer
rallies when my heart rate is near max? Do I fade in game 3? How fast do I recover between games?
Do I fold after losing a couple of rallies in a row?

## Quick start

Needs Node 23.6+ (it runs the TypeScript directly; no build step). Runtime has no dependencies.

```bash
npm install
cp .env.example .env
npm run sync:scores   # pull every match from club-squash-league.vercel.app/api/state
npm run build         # analyse and write dashboard/index.html
npm run demo          # preview with simulated heart rate -> dashboard/demo.html
```

Open the printed `file://` link. Score-based analysis (pressure, momentum, key moments) works right
away for every player; heart-rate sections light up once your watch is connected.

## Connect your Fitbit (Google Health API)

**Why not the Fitbit Web API:** Google shuts it down on **30 October 2026** and closed new
registrations. Its replacement is the [Google Health API](https://developers.google.com/health),
which serves the same Fitbit data through your Google account. This project only uses the new API.

One-time setup (about 10 minutes, all in [Google Cloud console](https://console.cloud.google.com)):

1. Create a project.
2. **APIs & Services → Library →** enable **Google Health API**.
3. **Google Auth Platform → Branding / Audience:** user type *External*; add your own Google
   account (the one your Fitbit is linked to) under **Test users**.
4. **Data Access → Add scopes:**
   - `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly` (workouts, steps)
   - `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` (heart rate, resting HR, HRV)
   - `https://www.googleapis.com/auth/googlehealth.sleep.readonly` (sleep)
5. **Clients → Create client → Web application.** Authorized redirect URI:
   `http://localhost:8787/oauth/callback`
6. Put the client ID and secret in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).

Then:

```bash
npm run auth    # opens Google's consent screen; tick all three permissions
npm run sync    # scores + workouts + 1-second heart rate + resting HR/HRV/sleep around your matches
npm run whoami  # works out which league player you are from your workouts
# set ME=<your name> in .env
npm run build
```

While the consent screen is in **Testing** mode, Google expires the login after 7 days, so you'll
re-run `npm run auth` weekly. To avoid that, publish the app (**Audience → Publish app**); as your own
unverified app you'll click through a warning on the consent screen once.

Tokens live in `data/secrets/` and every raw API response is archived under `data/raw/`. Both are
git-ignored, and so are the generated dashboards, because they contain your health data.

> The Google Health client is written against Google's published schemas and unit-tested with mock
> responses, but it hasn't run against the live API yet. If the first `npm run sync` errors, the
> message includes Google's response, and `data/raw/google-health/` has the exact pages received.

## Run it on Vercel

The hosted version is a private, password-protected site with **Connect Google Health** and
**Sync now** buttons. Your data lives in a free Upstash Redis database attached to the project, and
the analysis is the same as the local version.

1. **Create the project** from this folder:
   ```bash
   npm i -g vercel
   vercel login
   vercel link
   ```
   Answer "no" to linking an existing project and name it (e.g. `performance-journal`).
2. **Add storage.** In the Vercel dashboard, open the project → **Storage → Create Database →
   Upstash for Redis** (free plan) → connect it to the project. This adds `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` for you. Use a new database rather than the scoring app's, to keep health data
   separate.
3. **Environment variables** (project → **Settings → Environment Variables**):

   | Name | Value |
   |---|---|
   | `APP_PASSWORD` | the password you'll sign in with |
   | `SESSION_SECRET` | any long random string, e.g. from `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from your Google Cloud OAuth client ([above](#connect-your-fitbit-google-health-api)) |
   | `PUBLIC_URL` | your production address, e.g. `https://performance-journal.vercel.app` (project → **Domains**) |
   | `CRON_SECRET` | optional: any random string turns on a nightly sync (02:00 UTC) |

4. **Google Cloud:** in your OAuth client, add the authorized redirect URI
   `https://<your-project>.vercel.app/oauth/callback`. Keep the localhost one for the command line.
5. **Deploy:**
   ```bash
   vercel --prod
   ```
6. Open your site, sign in, press **Connect Google Health** (tick all three permissions), then
   **Sync now**, and pick which player you are.

Good to know:

- While the Google consent screen is in Testing mode, the connection expires after 7 days. Press
  **Reconnect Google Health** when a sync says so (or publish the app, see above).
- A sync stops starting new downloads after about 45 seconds and the button carries on by itself,
  so the first big sync may take a couple of rounds.
- To try it on your machine first: add `APP_PASSWORD=...` to `.env`, run `npm run serve`, and open
  <http://localhost:8787>. It uses the same Google redirect address as `npm run auth`.
- Prefer GitHub? Push this folder to a **private** repo and import it in Vercel instead of steps 1
  and 5; `vercel.json` already sets the build. `.env`, `data/` and the generated dashboards are never
  uploaded (`.vercelignore`, `.gitignore`).

## Your match routine

- **Start a workout on the watch when the match starts, stop it when it ends** (Squash if your watch
  offers it, otherwise Workout). That's how the match is found on the watch's timeline.
- Score every point live in the app, as you do now.
- Optional, for exact game boundaries: pause the workout between games, or record each game as its
  own workout. Either is detected automatically.

## How rallies get matched to heart rate

The scoring app stores when a match started and ended, but not when each point was played, so the
timeline is rebuilt from the best evidence available. Each match on the dashboard says which it used:

| Evidence | When it applies | Confidence |
|---|---|---|
| Point timestamps | the scoring app records the time of each point (see below) | exact |
| One workout per game | watch start/stop marks each game | high |
| Watch pauses | you paused between games | high |
| Heart-rate dips | the rest between games shows as a sharp drop (~15-25 bpm in 30s); found near where each break should be | medium |
| Even spread | no evidence: rallies spread evenly with 90s rests | low |

Within a game, rallies are spread evenly. That's accurate for game-level questions and approximate
for rally-level ones. On simulated matches the heart-rate method found 70 of 70 breaks, with a
median error of 1 second. Real wrist data is noisier, so expect it to miss some breaks.

Matches scored after the fact (e.g. 44 rallies "in 2 minutes") are flagged and kept out of
rally-level timing; matches whose point log doesn't add up to the game scores are kept out of
rally-level stats. Both show under **How this works → Data quality**.

## Recommended change to the scoring app

In the `/api/match/point` handler, store when each point happened:

```ts
matchup.pointLog.push({ gameIndex, side, callType, at: Date.now() });
```

The companion picks up `at` automatically. Every match scored afterwards gets exact rally times and
real rally lengths, and no longer relies on heart-rate dips to find the breaks between games.

To answer "do I make more **errors** when my heart rate is high", the app would also need to record
how each rally ended (e.g. `ending: "winner" | "error" | "forced"`). Until then the dashboard uses
rallies won and lost.

## How the analysis avoids fooling you

- **Pressure** is how much a rally swings your chance of winning the match (win minus lose, for two
  evenly matched players), scaled 0-100. 10-9 in a deciding game is 100; the first rally of a match is
  under 15.
- **"Expected" ticks.** Raw win rates mislead: you're more often 5 down against stronger players, so
  "down 5+" looks bad for everyone. Each situation is instead compared with what the *same games*
  would give if the situation made no difference. The rallies of each game are reshuffled 200 times,
  keeping each game's score and only using orders squash scoring allows. That controls for opponent,
  day form, and the classic "hot hand" bias of judging streaks inside short games. Whole-game
  situations (game 3, deciding games) are compared with your rate against the same opponent in other
  matches.
- **Heart rate** climbs through every game and pressure rises at the same moments, so each rally's HR
  is compared with your typical HR at that point of a game, learned across all your matches.
  Heart-rate findings are compared within each match, then across matches.
- **Calibration** (`npm test`): on pure-chance matches against opponents of very different strength,
  2 of 30 findings were wrongly called "clear". With simulated heart rate that ignores the score,
  2 of 39 were. When heart rate really does rise 6 bpm while trailing, it was found in 15 of 18 runs.

## Project layout

```
src/
  model.ts                     sport- and device-independent types (Session, Recording, HR, daily context)
  sources/club-squash-league.ts  score source: your Vercel app
  sources/google-health/       OAuth (PKCE), REST client, Fitbit data → model
  sports/squash.ts             PAR-11 scoring, win probabilities, pressure, legal reshuffles
  sync/                        wearable sync, rally/HR alignment, HR signal helpers
  analysis/                    per-player findings and the dataset behind the dashboard
  dashboard/                   self-contained HTML dashboard (SVG charts, no libraries)
  demo/simulate.ts             physiologically plausible HR for tests and the demo
  server/                      hosted version: sign-in, Google connect, sync, Redis storage
scripts/build-vercel.mjs       bundles the server as one Vercel function (Build Output API)
test/                          node --test suite, including calibration checks and the Vercel bundle
```

**Adding a device** (Garmin, Apple Watch): implement `WearableProvider` from `src/model.ts`
(workouts, heart rate, optional steps and daily context) and pass it to `syncWearable`.

**Adding a sport** (padel, golf): add a score source that produces `Session`s (games/sets or holes as
`segments`, points or shots as `events`), plus a module like `sports/squash.ts` for its scoring and
pressure.

## Commands

| Command | What it does |
|---|---|
| `npm run sync:scores` | Pull matches from the scoring app (`-- --file export.json` to import a Redis dump) |
| `npm run auth` | Connect your Google account (once; weekly in Testing mode) |
| `npm run sync:wearable` | Pull workouts, heart rate and daily context around your matches |
| `npm run sync` | Both syncs |
| `npm run whoami` | Which player you are, from your watch workouts |
| `npm run build` | Write `dashboard/index.html` |
| `npm run demo` | Write `dashboard/demo.html` with simulated heart rate (`-- --me Name`) |
| `npm run status` | What's synced |
| `npm run serve` | The hosted web app on your machine (http://localhost:8787) |
| `npm test` / `npm run typecheck` | Tests and type-check |
