// Synthetic wearable data for tests and for previewing the dashboard before your watch is connected.
// Heart rate here depends only on effort and time (warm-up, rallies, rests, drift), never on the
// score, so the demo cannot show patterns that aren't there. It is never mixed with real data.
import { mulberry32 } from "../analysis/stats.ts";
import type { DailyContext, HrSample, Recording, Session, WearableData } from "../model.ts";
import { mergeSamples } from "../sync/merge.ts";

export interface SimOptions {
  seed?: number;
  hrMax?: number;
  restingHr?: number;
  utcOffsetMinutes?: number;
  /** Tests only: extra bpm while trailing by 2+, to check a real effect gets detected. Never used by the demo. */
  behindBoostBpm?: number;
}

export interface SimTruth {
  sessionId: string;
  games: { start: number; end: number }[];
  breaks: { start: number; end: number }[];
  /** When each point actually ended, in point-log order. */
  pointTimes: number[];
}

function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

interface Phase {
  until: number; // epoch ms
  target: (elapsedMin: number) => number;
}

export function simulateSession(
  session: Session,
  rand: () => number,
  opts: SimOptions = {},
  side: "a" | "b" = "a",
): { recording: Recording; samples: HrSample[]; truth: SimTruth } | null {
  if (session.quality.timing === "untimed" || session.endedAt === null) return null;
  const hrMax = opts.hrMax ?? 192;
  const start = session.startedAt;
  const end = session.endedAt;
  const counts = session.segments
    .map((g) => session.events.filter((e) => e.segment === g.index).length || g.scoreA + g.scoreB)
    .filter((n) => n > 0);

  let breakSecs = counts.slice(1).map(() => 75 + rand() * 75);
  const totalRallies = counts.reduce((n, c) => n + c, 0);
  if ((end - start) / 1000 - breakSecs.reduce((s, b) => s + b, 0) < totalRallies * 10) breakSecs = breakSecs.map(() => 30);
  const activeMs = end - start - breakSecs.reduce((s, b) => s + b, 0) * 1000;

  // Rally lengths vary a lot (a few seconds to over a minute): log-normal weights.
  const weights = counts.map((n) => Array.from({ length: n }, () => Math.exp(0.6 * gauss(rand))));
  const totalWeight = weights.flat().reduce((s, w) => s + w, 0);

  const phases: Phase[] = [];
  const truth: SimTruth = { sessionId: session.id, games: [], breaks: [], pointTimes: [] };
  const base = 0.86 + rand() * 0.05; // this day's intensity
  const boost = opts.behindBoostBpm ?? 0;
  let t = start;
  weights.forEach((game, g) => {
    const gameStart = t;
    const inGame = session.events.filter((e) => e.segment === session.segments[g]?.index);
    let my = 0;
    let opp = 0;
    for (const [j, w] of game.entries()) {
      const dur = (activeMs * w) / totalWeight;
      const effort = Math.min(1, dur / 40_000);
      const extra = boost && my - opp <= -2 ? boost : 0;
      const won = inGame[j]?.wonBy;
      if (won === side) my++;
      else if (won) opp++;
      phases.push({ until: t + dur * 0.65, target: (m) => hrMax * (base + 0.04 * effort) + 0.25 * m + extra });
      phases.push({ until: t + dur, target: (m) => hrMax * (base - 0.06) + 0.25 * m });
      truth.pointTimes.push(Math.round(t + dur * 0.65));
      t += dur;
    }
    truth.games.push({ start: gameStart, end: t });
    if (g < weights.length - 1) {
      const b = breakSecs[g] * 1000;
      truth.breaks.push({ start: t, end: t + b });
      phases.push({ until: t + b, target: () => 118 + rand() * 6 });
      t += b;
    }
  });

  const warmup = (180 + rand() * 240) * 1000;
  const cooldown = (30 + rand() * 90) * 1000;
  const recStart = start - warmup;
  const recEnd = end + cooldown;
  phases.unshift({ until: start, target: () => 118 + rand() * 10 });
  phases.push({ until: recEnd + 3 * 60_000, target: () => 100 });

  const samples: HrSample[] = [];
  let hr = (opts.restingHr ?? 60) + 25;
  let p = 0;
  let gapUntil = 0;
  for (let ts = recStart - 2 * 60_000; ts < recEnd + 3 * 60_000; ts += 1000) {
    while (p < phases.length - 1 && ts >= phases[p].until) p++;
    const target = phases[p].target((ts - start) / 60_000);
    const tau = target > hr ? 18 : 45;
    hr += (target - hr) / tau;
    if (ts < gapUntil) continue;
    if (rand() < 0.01) gapUntil = ts + (3 + rand() * 12) * 1000;
    samples.push({ t: ts, bpm: Math.round(hr + 1.2 * gauss(rand)) });
  }

  const recording: Recording = {
    id: `demo-${session.id}`,
    provider: "demo",
    type: "SQUASH",
    name: "Squash (simulated)",
    start: recStart,
    end: recEnd,
    utcOffsetMinutes: opts.utcOffsetMinutes ?? 0,
    events: [],
    summary: {},
  };
  return { recording, samples, truth };
}

export function simulateWearable(
  sessions: Session[],
  me: string,
  opts: SimOptions = {},
): { wearable: WearableData; truths: SimTruth[] } {
  const rand = mulberry32(opts.seed ?? 7);
  const recordings: Recording[] = [];
  const truths: SimTruth[] = [];
  const perSession: HrSample[][] = [];
  const days = new Set<string>();
  for (const s of sessions) {
    const player = s.participants.find((p) => p.name.toLowerCase() === me.toLowerCase());
    if (!player) continue;
    const sim = simulateSession(s, rand, opts, player.side);
    if (!sim) continue;
    recordings.push(sim.recording);
    truths.push(sim.truth);
    perSession.push(sim.samples);
    days.add(new Date(s.startedAt + (opts.utcOffsetMinutes ?? 0) * 60_000).toISOString().slice(0, 10));
  }
  // Back-to-back matches overlap at the edges; the later match's warm-up wins.
  const samples = mergeSamples(...perSession);
  const daily: DailyContext[] = [...days].sort().map((date) => ({
    date,
    restingHr: Math.round((opts.restingHr ?? 60) + 3 * gauss(rand)),
    hrvMs: Math.round(52 + 8 * gauss(rand)),
    sleepMinutes: Math.round(400 + 50 * gauss(rand)),
  }));
  return {
    wearable: { provider: "demo", syncedAt: Date.now(), recordings, heartRate: samples, daily },
    truths,
  };
}

