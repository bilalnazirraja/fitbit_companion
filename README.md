# Performance Journal

A sports journal for **squash, padel and golf**. Log each match (or score squash live, point by
point), and your Fitbit adds the heart rate through the Google Health API. Anyone can view the
journal; logging, notes, syncing and the optional AI coach need your password.

## Run your own

1. **Fork** this repo (keep it private) and import it in [Vercel](https://vercel.com).
2. **Storage:** in the Vercel project, Storage → Create Database → **Upstash for Redis** (free) →
   connect it.
3. **Google Cloud** ([console](https://console.cloud.google.com)): create a project, enable the
   **Google Health API**, add yourself as a test user, add the three `googlehealth.*.readonly`
   scopes (activity_and_fitness, health_metrics_and_measurements, sleep), and create a **Web
   application** OAuth client with redirect URI `https://<your-project>.vercel.app/oauth/callback`.
4. **Environment variables** in Vercel:

   | Name | Value |
   |---|---|
   | `APP_PASSWORD` | the password for logging matches |
   | `SESSION_SECRET` | any long random string |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from step 3 |
   | `PUBLIC_URL` | `https://<your-project>.vercel.app` |
   | `OPENAI_API_KEY` | optional, turns on the AI coach |

5. Deploy, sign in, and connect Google Health in **Settings**. While the Google app is in Testing
   mode the connection lasts 7 days; press Reconnect when asked.

Local: `npm install`, put the same variables in `.env`, `npm run serve` → http://localhost:8787.
`npm test` runs the tests.

## How the key metrics work

- **Heart-rate zones:** time at 50/60/70/80/90%+ of your max heart rate (the highest seen in your
  matches, or set it in Settings).
- **Load:** zone-weighted minutes. A minute in zone 1 counts 1, in zone 5 counts 5.
- **Effort per point (squash) / game (padel) won:** heartbeats above your resting rate ÷ points or
  games won. Lower means you won more cheaply. Golf uses effort per hole.
- **Training load:** the last 7 days' load ÷ your usual week (last 28 days ÷ 4). 0.8–1.3 is the
  sweet spot; above 1.5 is a spike, when overuse injuries are most likely.
- **Felt vs heart rate:** how hard it felt (1–10) × minutes, compared with the heart-rate load.
  Feeling much harder than usual for the same load often means tiredness, poor sleep or illness.
- **Rally analysis** (squash scored point by point): win rate by score, pressure and momentum, each
  compared with what the same games would give by chance (rallies reshuffled within each game, 200
  times), so a strong opponent or an off day isn't mistaken for a pattern.
- **AI coach:** sends only summary numbers and your notes, answers under 90 words, saves answers so
  unchanged data is never paid for twice, and stops at the monthly budget set in Settings.

---

Powered by [Rapteck](https://rapteck.com/)
