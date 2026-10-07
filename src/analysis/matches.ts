// Effort and efficiency for every match you played, any sport, from the heart rate your watch
// recorded, plus the averages each match is compared with.
import type { DailyContext, HrSample, Recording, Session, Side, StrokeScore } from "../model.ts";
import type { Alignment } from "../sync/align.ts";
import { downsample, percentile, resample1Hz, slice } from "../sync/hr.ts";
import { mean } from "./stats.ts";

const MIN = 60_000;

/** Lower edge of each heart-rate zone as a share of max HR: Z1 50%, Z2 60%, Z3 70%, Z4 80%, Z5 90%. */
export const ZONE_FLOORS = [0.5, 0.6, 0.7, 0.8, 0.9];
/** Used for "heartbeats above resting" when the watch has no resting heart rate at all. */
export const ASSUMED_RESTING_HR = 60;

export interface HrStats {
  avg: number;
  max: number;
  /** Share of the match with heart-rate readings. */
  coverage: number;
  /** Seconds in Z1..Z5 (below Z1 isn't counted). */
  zones: number[];
  /** Zone-weighted minutes (Edwards' TRIMP): each minute in Z1 counts 1, in Z5 counts 5. */
  load: number | null;
  /** Heartbeats above your resting rate over the match. */
  extraBeats: number | null;
}

export interface Efficiency {
  unit: "point" | "game" | "hole";
  /** Heartbeats above resting per point/game you won, or per hole in golf. Lower is more economical. */
  beatsPerUnit: number | null;
}

export interface MatchView {
  id: string;
  source: "league" | "journal";
  sport: string;
  startedAt: number;
  endedAt: number | null;
  minutes: number | null;
  opponents: string[];
  partner: string | null;
  result: "win" | "loss" | "draw" | null;
  /** Games (squash) or sets (padel), your score first. */
  score: [number, number][];
  strokes: StrokeScore | null;
  /** Points (squash rallies) or games (padel) won and lost over the whole match. */
  tally: { unit: "point" | "game"; won: number; lost: number } | null;
  hr: HrStats | null;
  calories: number | null;
  efficiency: Efficiency | null;
  restingHr: { bpm: number; source: "day" | "typical" | "assumed" } | null;
  daily: DailyContext | null;
  /**
   * For the chart, relative to `start` (the match start): heart rate as [seconds, bpm] including
   * two minutes either side, and games/sets and rests as [from, to] seconds.
   */
  chart: {
    start: number;
    end: number;
    hr: [number, number][];
    segments: [number, number][];
    rests: [number, number][];
  } | null;
  /** How the games were placed on the clock (squash), see sync/align.ts. */
  timing: { basis: string; confidence: number } | null;
  /** A complete point-by-point log, so the rally timeline covers this match. */
  rallies: boolean;
}

export interface MatchContext {
  side: Side;
  alignment: Alignment | null;
  heartRate: HrSample[];
  recordings: Recording[];
  hrMax: number | null;
  daily: DailyContext | null;
  /** Your usual resting heart rate across synced days, for days the watch has none. */
  typicalRestingHr: number | null;
}

export function matchView(s: Session, ctx: MatchContext): MatchView {
  const { side, alignment: a } = ctx;
  const timed = s.endedAt !== null && s.quality.timing !== "untimed";
  const window = a ? a.window : timed ? { start: s.startedAt, end: s.endedAt! } : null;

  const restingHr: MatchView["restingHr"] = ctx.daily?.restingHr
    ? { bpm: ctx.daily.restingHr, source: "day" }
    : ctx.typicalRestingHr
      ? { bpm: ctx.typicalRestingHr, source: "typical" }
      : { bpm: ASSUMED_RESTING_HR, source: "assumed" };
  const hr = window ? hrStats(ctx.heartRate, window.start, window.end, ctx.hrMax, restingHr.bpm) : null;
  const minutes = window ? (window.end - window.start) / MIN : null;

  const mine = (seg: Session["segments"][number]) => (side === "a" ? seg.scoreA : seg.scoreB);
  const theirs = (seg: Session["segments"][number]) => (side === "a" ? seg.scoreB : seg.scoreA);
  const racket = s.sport === "squash" || s.sport === "padel";
  const tally =
    racket && s.segments.length > 0
      ? {
          unit: (s.sport === "squash" ? "point" : "game") as "point" | "game",
          won: s.segments.reduce((n, g) => n + mine(g), 0),
          lost: s.segments.reduce((n, g) => n + theirs(g), 0),
        }
      : null;

  let result: MatchView["result"] = null;
  if (s.winner) result = s.winner === side ? "win" : "loss";
  else if (racket && s.segments.length > 0) result = "draw";

  const chart = window && hr ? chartData(s, ctx, window) : null;
  const calories = ctx.recordings
    .filter((r) => window && r.start >= window.start - 5 * MIN && r.end <= window.end + 5 * MIN && r.summary.calories)
    .reduce<number | null>((sum, r) => (sum ?? 0) + r.summary.calories!, null);

  return {
    id: s.id,
    source: s.source === "journal" ? "journal" : "league",
    sport: s.sport,
    startedAt: window?.start ?? s.startedAt,
    endedAt: window?.end ?? s.endedAt,
    minutes: minutes === null ? null : round1(minutes),
    opponents: s.participants.filter((p) => p.side !== side).map((p) => p.name),
    partner: s.participants.filter((p) => p.side === side).slice(1)[0]?.name ?? null,
    result,
    score: s.segments.map((g) => [mine(g), theirs(g)] as [number, number]),
    strokes: s.strokes ?? null,
    tally,
    hr,
    calories: calories === null ? null : Math.round(calories),
    efficiency: efficiency(s, tally, hr),
    restingHr: hr ? restingHr : null,
    daily: ctx.daily,
    chart,
    timing: a ? { basis: a.basis, confidence: a.confidence } : null,
    rallies: s.quality.logComplete && s.events.length > 0,
  };
}

export function hrStats(hr: HrSample[], from: number, to: number, hrMax: number | null, restingHr: number | null): HrStats | null {
  const series = resample1Hz(hr, from, to);
  let n = 0;
  let sum = 0;
  let max = -Infinity;
  let above = 0;
  const zones = [0, 0, 0, 0, 0];
  for (const v of series) {
    if (Number.isNaN(v)) continue;
    n++;
    sum += v;
    if (v > max) max = v;
    if (restingHr) above += Math.max(0, v - restingHr);
    if (!hrMax) continue;
    for (let k = ZONE_FLOORS.length - 1; k >= 0; k--) {
      if (v >= ZONE_FLOORS[k] * hrMax) {
        zones[k]++;
        break;
      }
    }
  }
  if (n < 60) return null;
  // Gaps in the readings would make long matches with patchy data look easier: scale up to the
  // whole match, assuming the missing stretches were like the rest.
  const coverage = n / series.length;
  const scale = 1 / coverage;
  return {
    avg: round1(sum / n),
    max: Math.round(max),
    coverage: round2(coverage),
    zones,
    load: hrMax ? Math.round((scale * zones.reduce((acc, sec, k) => acc + sec * (k + 1), 0)) / 60) : null,
    extraBeats: restingHr ? Math.round((scale * above) / 60) : null,
  };
}

function efficiency(s: Session, tally: MatchView["tally"], hr: HrStats | null): Efficiency | null {
  const beats = hr?.extraBeats ?? null;
  if (beats === null) return null;
  if (s.sport === "golf" && s.strokes) return { unit: "hole", beatsPerUnit: round1(beats / s.strokes.holes) };
  if (tally && tally.won > 0) return { unit: tally.unit, beatsPerUnit: round1(beats / tally.won) };
  return null;
}

function chartData(
  s: Session,
  ctx: MatchContext,
  window: { start: number; end: number },
): NonNullable<MatchView["chart"]> {
  const from = window.start - 2 * MIN;
  const to = window.end + 2 * MIN;
  // About 400 points whatever the length: 5s buckets for squash, coarser for a round of golf.
  const stepSec = Math.max(5, Math.ceil((to - from) / 1000 / 400 / 5) * 5);
  const sec = (t: number) => Math.round((t - window.start) / 1000);
  const hr = downsample(ctx.heartRate, from, to, stepSec).map(([t, v]) => [sec(t), Math.round(v)] as [number, number]);
  let segments: [number, number][] = [];
  let rests: [number, number][] = [];
  if (ctx.alignment) {
    segments = ctx.alignment.games.map((g) => [sec(g.start), sec(g.end)]);
    rests = ctx.alignment.breaks.map((b) => [sec(b.start), sec(b.end)]);
  } else if (s.sport === "padel" && s.segments.length > 1) {
    // Sets in proportion to the games in each: changeovers make the breaks hard to see in HR.
    const games = s.segments.map((g) => g.scoreA + g.scoreB);
    const total = games.reduce((a, g) => a + g, 0);
    let t = 0;
    const span = (window.end - window.start) / 1000;
    segments = games.map((g) => {
      const seg: [number, number] = [Math.round(t), Math.round(t + (span * g) / total)];
      t += (span * g) / total;
      return seg;
    });
  }
  return { start: window.start, end: window.end, hr, segments, rests };
}

export interface SportSummary {
  matches: number;
  wins: number;
  losses: number;
  /** Most recent first, up to 10. */
  form: ("W" | "L" | "D")[];
  minutes: number;
  load: number;
  withHr: number;
  avg: {
    minutes: number | null;
    hr: number | null;
    maxHr: number | null;
    load: number | null;
    beatsPerUnit: number | null;
    /** Share of points (squash) or games (padel) won. */
    unitShare: number | null;
    strokes: number | null;
    overPar: number | null;
  };
  opponents: { name: string; played: number; won: number; lost: number; avgHr: number | null }[];
}

export type Summaries = Record<string, SportSummary>;

/** One summary per sport, plus "all" (whose averages mix sports, so only its totals are shown). */
export function summarize(matches: MatchView[]): Summaries {
  const out: Summaries = { all: summary(matches) };
  for (const sport of new Set(matches.map((m) => m.sport))) out[sport] = summary(matches.filter((m) => m.sport === sport));
  return out;
}

function summary(matches: MatchView[]): SportSummary {
  const newest = [...matches].sort((a, b) => b.startedAt - a.startedAt);
  const avg = (pick: (m: MatchView) => number | null | undefined, digits = 1) => {
    const vals = matches.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (vals.length === 0) return null;
    const f = 10 ** digits;
    return Math.round(mean(vals) * f) / f;
  };
  const won = matches.reduce((n, m) => n + (m.tally?.won ?? 0), 0);
  const played = matches.reduce((n, m) => n + (m.tally ? m.tally.won + m.tally.lost : 0), 0);
  const opponents = new Map<string, { played: number; won: number; lost: number; hr: number[] }>();
  for (const m of matches) {
    if (!m.result) continue;
    for (const name of m.opponents) {
      const o = opponents.get(name) ?? { played: 0, won: 0, lost: 0, hr: [] };
      o.played++;
      if (m.result === "win") o.won++;
      if (m.result === "loss") o.lost++;
      if (m.hr) o.hr.push(m.hr.avg);
      opponents.set(name, o);
    }
  }
  return {
    matches: matches.length,
    wins: matches.filter((m) => m.result === "win").length,
    losses: matches.filter((m) => m.result === "loss").length,
    form: newest
      .filter((m) => m.result)
      .slice(0, 10)
      .map((m) => (m.result === "win" ? "W" : m.result === "loss" ? "L" : "D")),
    minutes: Math.round(matches.reduce((n, m) => n + (m.minutes ?? 0), 0)),
    load: matches.reduce((n, m) => n + (m.hr?.load ?? 0), 0),
    withHr: matches.filter((m) => m.hr).length,
    avg: {
      minutes: avg((m) => m.minutes, 0),
      hr: avg((m) => m.hr?.avg, 0),
      maxHr: avg((m) => m.hr?.max, 0),
      load: avg((m) => m.hr?.load, 0),
      beatsPerUnit: avg((m) => m.efficiency?.beatsPerUnit),
      unitShare: played > 0 ? Math.round((won / played) * 1000) / 1000 : null,
      strokes: avg((m) => m.strokes?.strokes),
      overPar: avg((m) => (m.strokes ? m.strokes.strokes - m.strokes.par : null)),
    },
    opponents: [...opponents]
      .map(([name, o]) => ({ name, played: o.played, won: o.won, lost: o.lost, avgHr: o.hr.length ? Math.round(mean(o.hr)) : null }))
      .sort((a, b) => b.played - a.played || a.name.localeCompare(b.name)),
  };
}

/** Max heart rate seen across your matches (99.5th percentile, so one glitchy reading can't set it). */
export function observedHrMax(hr: HrSample[], windows: { start: number; end: number }[]): number | null {
  const bpm: number[] = [];
  for (const w of windows) for (const s of slice(hr, w.start, w.end)) bpm.push(s.bpm);
  return bpm.length > 0 ? Math.round(percentile(bpm, 0.995)) : null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
