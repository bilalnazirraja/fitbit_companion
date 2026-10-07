# Performance Journal

A personal sports journal for **squash, padel and golf**. Log each match with its score and how it
felt; your Fitbit (through the Google Health API) adds the heart rate and steps, and the app turns
them into effort, movement and efficiency you can compare across matches. An optional AI coach
(OpenAI) gives a short read on a match or on your recent form.

> score → effort (heart rate) → movement (steps) → how it felt

It answers questions like: how hard was that match compared with my usual? Am I winning points more
cheaply than a month ago? Which opponent makes me work hardest? Does a bad night's sleep show in my
results? For squash matches imported from the Club Squash League app, which logged every rally, it
also shows how the score and pressure affect your heart rate and rally wins.

The interface follows Material Design 3 (colour roles, type scale, navigation bar/rail, cards,
chips, FAB), is built mobile-first, and can be added to a phone's home screen. Light and dark
themes follow the phone, or pick one in Settings.

## What's on each screen

- **Home**: last match, your record and form, the AI coach, effort per match, the last 30 days.
- **Matches**: every match, by month; tap one for the score, a heart-rate and steps timeline,
  heart-rate zones, efficiency, how it felt, the AI read, and sleep/resting HR that day.
- **Insights**: trends (effort, efficiency, movement), opponents, sleep vs results, and the squash
  rally analysis from the league history, each folded to a headline until you open it.
- **Settings**: your name and max heart rate, the Fitbit connection, the AI model, monthly AI
  budget and usage, theme, sign out.
- **Log match** (the + button): sport, your Fitbit workout for that day (or type the time), who you
  played, the score (games, sets, or strokes with optional hole-by-hole), and how it felt (1-10 and a
  comment).

## The numbers

| Metric | What it is |
|---|---|
| Heart-rate zones | Time at 50/60/70/80/90%+ of your max heart rate (the highest seen in your matches, or set it in Settings) |
| Load | Zone-weighted minutes: a minute in zone 1 counts 1, in zone 5 counts 5 (Edwards' TRIMP) |
| Effort | Heartbeats above your resting rate (from your Fitbit that day, else your usual) |
| Effort per point/game won | Effort ÷ points won (squash) or games won (padel): how much each win cost. Lower is more efficient |
| Steps per rally/game/hole | How much you moved for each point played (squash), game (padel) or hole (golf) |
| Effort per step | What each step cost your heart. Falling over the weeks means fitter, more economical movement |
| How hard it felt | Your own 1-10 rating, next to the heart rate's verdict |

Each match is compared with your usual for that sport. Wrist step counts in racket sports miss some
lunges and count some swings, so compare matches with each other rather than reading steps as exact.

## Your match routine

1. **Start a workout on the Fitbit when you start playing, stop it when you finish.**
2. After the match, let the Fitbit sync to its phone app, then press **+** in the journal.
3. Pick the sport; your workouts that day are listed (one is picked for you if it's the only one).
   Its exact start and stop are used, so heart rate and steps line up with the match.
4. Enter who you played, the score and how it felt, and save. The app fetches the heart rate and
   steps straight away.

## Run it on Vercel

The hosted version is a private, password-protected site. Your data lives in a free Upstash Redis
database attached to the project.

1. **Create the project**: push this folder to a **private** GitHub repo and import it in Vercel
   (or `npm i -g vercel`, `vercel link`, then `vercel --prod`). `vercel.json` already sets the build.
2. **Add storage.** In the Vercel dashboard, open the project → **Storage → Create Database →
   Upstash for Redis** (free plan) → connect it to the project. This adds `KV_REST_API_URL` and
   `KV_REST_API_TOKEN`.
3. **Environment variables** (project → **Settings → Environment Variables**):

   | Name | Value |
   |---|---|
   | `APP_PASSWORD` | the password you'll sign in with |
   | `SESSION_SECRET` | any long random string, e.g. from `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from your Google Cloud OAuth client ([below](#connect-your-fitbit-google-health-api)) |
   | `PUBLIC_URL` | your production address, e.g. `https://performance-journal.vercel.app` |
   | `OPENAI_API_KEY` | optional: turns on the AI coach ([below](#ai-coach)) |
   | `CRON_SECRET` | optional: any random string turns on a nightly sync (02:00 UTC) |

4. **Google Cloud:** in your OAuth client, add the authorized redirect URI
   `https://<your-project>.vercel.app/oauth/callback`.
5. Open your site, sign in, and connect Google Health in **Settings** (tick all three permissions).

Good to know:

- While the Google consent screen is in Testing mode, the connection expires after 7 days. Press
  **Reconnect** when a sync says so (or publish the app: **Audience → Publish app**).
- A sync stops starting new downloads after about 45 seconds and carries on by itself, so the first
  big sync may take a couple of rounds.
- `.env`, `data/` and the generated pages are never uploaded (`.vercelignore`, `.gitignore`).
- To try it on your machine: add `APP_PASSWORD=...` to `.env`, run `npm run serve`, and open
  <http://localhost:8787>.

## AI coach

1. Create an API key at [platform.openai.com](https://platform.openai.com) → API keys, and add a few
   dollars of credit.
2. Add it in Vercel as `OPENAI_API_KEY`, then redeploy.
3. In **Settings**, pick the model and a monthly budget (default $2).

It's built to spend as little as possible:

- An answer is only requested when you tap **Get insight**; nothing runs in the background.
- It sees a few hundred tokens of summary numbers and your notes, never raw heart-rate samples, and
  answers in under 90 words.
- Answers are saved. Asking again about unchanged data reuses the saved answer for free.
- Requests stop for the month once the budget is reached; the usage bar in Settings (and under each
  AI card) shows what's been spent. Responses aren't stored at OpenAI (`store: false`).

| Model | Price per million tokens (in / out) | About per answer |
|---|---|---|
| GPT-5.6 Luna (default) | $0.20 / $1.20 | $0.0007 |
| GPT-5.6 Terra | $2 / $12 | $0.007 |
| GPT-5.6 Sol | $4 / $20 (promotional) | $0.01 |

Prices are from [OpenAI's model pages](https://developers.openai.com/api/docs/models) as of
October 2026; update `src/ai/openai.ts` if they change. To offer another model, set `OPENAI_MODEL`;
it's costed like the dearest model above so the budget still protects you.

## Connect your Fitbit (Google Health API)

**Why not the Fitbit Web API:** Google shuts it down on **30 October 2026** and closed new
registrations. Its replacement is the [Google Health API](https://developers.google.com/health),
which serves the same Fitbit data through your Google account.

One-time setup (about 10 minutes, all in [Google Cloud console](https://console.cloud.google.com)):

1. Create a project (or reuse one).
2. **APIs & Services → Library →** enable **Google Health API**.
3. **Google Auth Platform → Branding / Audience:** user type *External*; add your own Google
   account (the one your Fitbit is linked to) under **Test users**.
4. **Data Access → Add scopes:**
   - `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly` (workouts, steps)
   - `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` (heart rate, resting HR, HRV)
   - `https://www.googleapis.com/auth/googlehealth.sleep.readonly` (sleep)
5. **Clients → Create client → Web application.** Authorized redirect URIs:
   `https://<your-project>.vercel.app/oauth/callback` and, for local use,
   `http://localhost:8787/oauth/callback`.
6. Put the client ID and secret in Vercel (and in `.env` for local use).

## The squash league history

Matches from the Club Squash League app were imported once (the first time the app ran) and are
kept; the scoring app isn't contacted again. Pick which player you are (Home asks once, or
Settings), and only your matches are kept in view. Those matches have point-by-point logs, so the
**Squash rally analysis** in Insights covers them: win rates by score situation, pressure, momentum,
game number, and heart rate by situation, each judged against what the same games would give by
chance (rallies reshuffled within each game, 200 times). Matches you log here have final scores
only, so they don't change that part.

## Command line (optional)

Needs Node 23.6+ (runs the TypeScript directly). Runtime has no dependencies.

| Command | What it does |
|---|---|
| `npm run serve` | The web app on your machine (http://localhost:8787) |
| `npm run sync:scores` | Pull matches from the scoring app (`-- --file export.json` to import a Redis dump) |
| `npm run auth` | Connect your Google account (once; weekly in Testing mode) |
| `npm run sync` | Scores, then workouts, heart rate, steps and daily context around them |
| `npm run whoami` | Which league player you are, from your watch workouts |
| `npm run build` | Write a read-only `dashboard/index.html` of your matches (needs `ME=` in `.env`) |
| `npm run demo` | The same with simulated heart rate and steps → `dashboard/demo.html` |
| `npm test` / `npm run typecheck` | Tests and type-check |

## Project layout

```
src/
  model.ts                       sport- and device-independent types (Session, Recording, HR, steps)
  journal/entries.ts             matches you log: validation, sessions, watch-workout matching, notes
  sources/club-squash-league.ts  the league history import
  sources/google-health/         OAuth (PKCE), REST client, Fitbit data → model
  sports/squash.ts               PAR-11 scoring, win probabilities, pressure, legal reshuffles
  sync/                          wearable sync, rally/HR alignment, HR signal helpers
  analysis/matches.ts            per-match zones, load, steps, efficiency; per-sport summaries
  analysis/dataset.ts            everything the app shows, including the squash rally analysis
  ai/                            OpenAI Responses API, prices, and the compact prompts
  dashboard/                     the app: render.ts, app.css (Material 3 tokens), client/*.js
  server/                        hosted version: sign-in, API, Google connect, sync, Redis storage
scripts/build-vercel.mjs         bundles the server as one Vercel function (Build Output API)
test/                            node --test suite, including calibration checks and the Vercel bundle
```

**Adding a device** (Garmin, Apple Watch): implement `WearableProvider` from `src/model.ts`
(workouts, heart rate, steps, daily context) and pass it to `syncWearable`.

**Adding a sport**: add it to `SPORTS` in `src/journal/entries.ts` with its scoring rules, and to
`SPORT` in `src/dashboard/client/01-core.js` for its label and icon.
