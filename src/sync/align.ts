// Places a match's rallies on the wearable's clock.
//
// The scoring app records when a match started and ended but not when each rally happened, so we
// reconstruct the timeline using the best evidence available, in this order:
//   1. measured            – the score source stored a timestamp per point (exact)
//   2. per-game-recordings – one watch recording per game (watch start/stop = game start/end)
//   3. watch-pauses        – the watch was paused between games
//   4. heart-rate          – between-game rests show up as a sharp HR drop; we look for one near
//                            where each break should be
//   5. proportional        – spread rallies evenly, with a fixed rest between games
// Rallies are then spread evenly within each game, which is fine for game-level questions and
// approximate for rally-level ones (see `confidence`).
import type { HrSample, Recording, Session } from "../model.ts";
import { coverage, downsample, meanRange, resample1Hz, slice, smooth, summarize } from "./hr.ts";

export type TimingBasis =
  | "measured"
  | "per-game-recordings"
  | "watch-pauses"
  | "heart-rate"
  | "proportional"
  | "recording-window";

export interface TimeSpan {
  start: number;
  end: number;
}

export interface GameSpan extends TimeSpan {
  index: number;
}

export interface BreakSpan extends TimeSpan {
  afterGame: number;
  /** Located from evidence (HR drop, watch pause, timestamps) rather than assumed. */
  located: boolean;
}

export interface BreakRecovery extends BreakSpan {
  /** Highest HR around the end of the game. */
  hrPeak: number | null;
  hr30: number | null;
  hr60: number | null;
  /** HR when play resumed. */
  hrResume: number | null;
  /** Beats per minute shed in the first 60s of rest. Higher means faster recovery. */
  drop60: number | null;
}

export interface AlignedRally extends TimeSpan {
  seq: number;
  hrMean: number | null;
  hrMax: number | null;
}

export interface Alignment {
  sessionId: string;
  recordingIds: string[];
  window: TimeSpan;
  basis: TimingBasis;
  /** Rough 0..1 trust in rally-level timing. */
  confidence: number;
  games: GameSpan[];
  breaks: BreakRecovery[];
  /** Empty when the point log is incomplete. */
  rallies: AlignedRally[];
  hr: { mean: number; max: number; min: number; coverage: number } | null;
  /** 5s-averaged HR from 3 min before to 3 min after the match, for charts. */
  series: [number, number][];
  /** Watch recording start minus scoring-app start, in seconds. */
  recordingOffsetSec: number | null;
}

export interface AlignOptions {
  breakSec: number;
}

const MIN = 60_000;
const NEARBY_MS = 15 * MIN;
const MIN_SEC_PER_RALLY = 6;
const MIN_BREAK_SEC = 40;
const MAX_BREAK_SEC = 240;
const MIN_DROP30_BPM = 6;
const MIN_DROP_TOTAL_BPM = 10;
const DEVIATION_PENALTY_BPM = 4;

interface GameCount {
  index: number;
  n: number;
}

interface Timeline {
  games: GameSpan[];
  breaks: BreakSpan[];
}

export function alignSession(
  session: Session,
  recordings: Recording[],
  hr: HrSample[],
  opts: AlignOptions,
): Alignment | null {
  const appEnd = session.endedAt ?? session.startedAt;
  const near = recordings
    .filter((r) => r.end > session.startedAt - NEARBY_MS && r.start < appEnd + NEARBY_MS)
    .sort((a, b) => a.start - b.start);

  let window: TimeSpan;
  let fromRecording = false;
  if (session.quality.timing !== "untimed") {
    window = { start: session.startedAt, end: appEnd };
  } else if (near.length > 0) {
    window = { start: near[0].start, end: Math.max(...near.map((r) => r.end)) };
    fromRecording = true;
  } else {
    return null; // nothing tells us when this match was played
  }

  const counts = gameCounts(session);
  const measured = session.events.length > 0 && session.events.every((e) => e.at !== undefined);

  let timeline: Timeline;
  let basis: TimingBasis;
  let confidence: number;
  let rallyTimes: TimeSpan[] | null = null;

  if (measured) {
    const m = measuredTimeline(session);
    timeline = m.timeline;
    rallyTimes = m.rallies;
    window = { start: Math.min(window.start, m.rallies[0].start), end: Math.max(window.end, appEnd) };
    basis = "measured";
    confidence = 0.95;
  } else {
    const prop = proportionalTimeline(window, counts, opts.breakSec * 1000);
    const perGame = fromRecording ? null : perGameRecordings(near, counts, window);
    const pauses = fromRecording ? null : watchPauses(near, counts, window);
    const fromHr = fromRecording || perGame || pauses ? null : locateBreaksFromHr(hr, window, prop, counts, opts);
    if (perGame) {
      timeline = perGame;
      basis = "per-game-recordings";
      confidence = 0.85;
    } else if (pauses) {
      timeline = pauses;
      basis = "watch-pauses";
      confidence = 0.8;
    } else if (fromHr) {
      timeline = fromHr.timeline;
      basis = "heart-rate";
      confidence = fromHr.allLocated ? 0.6 : 0.5;
    } else {
      timeline = prop;
      basis = fromRecording ? "recording-window" : "proportional";
      confidence = fromRecording ? 0.2 : session.quality.timing === "suspect" ? 0.3 : 0.4;
    }
  }

  if (!rallyTimes && session.quality.logComplete) rallyTimes = spreadRallies(session, timeline.games);

  const rallies: AlignedRally[] = (rallyTimes ?? []).map((span, i) => {
    const stats = summarize(slice(hr, span.start, span.end));
    return {
      seq: session.events[i].seq,
      start: span.start,
      end: span.end,
      hrMean: stats ? round1(stats.mean) : null,
      hrMax: stats ? stats.max : null,
    };
  });

  const inWindow = summarize(slice(hr, window.start, window.end));
  return {
    sessionId: session.id,
    recordingIds: near.map((r) => r.id),
    window,
    basis,
    confidence,
    games: timeline.games,
    breaks: timeline.breaks.map((b) => recovery(hr, b)),
    rallies,
    hr: inWindow
      ? {
          mean: round1(inWindow.mean),
          max: inWindow.max,
          min: inWindow.min,
          coverage: round1(coverage(hr, window.start, window.end) * 100) / 100,
        }
      : null,
    series: downsample(hr, window.start - 3 * MIN, window.end + 3 * MIN, 5),
    recordingOffsetSec: near.length > 0 ? Math.round((near[0].start - session.startedAt) / 1000) : null,
  };
}

/** Rallies per game, in play order. Falls back to game scores when the log is incomplete. */
function gameCounts(session: Session): GameCount[] {
  return session.segments.map((s) => {
    const logged = session.events.filter((e) => e.segment === s.index).length;
    return { index: s.index, n: session.quality.logComplete ? logged : Math.max(logged, s.scoreA + s.scoreB) };
  }).filter((c) => c.n > 0);
}

export function proportionalTimeline(window: TimeSpan, counts: GameCount[], breakMs: number): Timeline {
  const total = counts.reduce((n, c) => n + c.n, 0);
  const span = window.end - window.start;
  let rest = breakMs;
  let active = span - (counts.length - 1) * rest;
  if (active < total * MIN_SEC_PER_RALLY * 1000) {
    rest = 0; // too short to have taken full breaks
    active = span;
  }
  const perRally = active / Math.max(1, total);
  const games: GameSpan[] = [];
  const breaks: BreakSpan[] = [];
  let t = window.start;
  counts.forEach((c, k) => {
    const end = t + c.n * perRally;
    games.push({ index: c.index, start: t, end });
    t = end;
    if (k < counts.length - 1) {
      breaks.push({ afterGame: c.index, start: t, end: t + rest, located: false });
      t += rest;
    }
  });
  return { games, breaks };
}

/** One recording per game: the watch's start/stop marks each game. */
function perGameRecordings(near: Recording[], counts: GameCount[], window: TimeSpan): Timeline | null {
  const inside = near.filter((r) => r.end > window.start - MIN && r.start < window.end + MIN);
  if (counts.length < 2 || inside.length !== counts.length) return null;
  for (let k = 1; k < inside.length; k++) if (inside[k].start < inside[k - 1].end) return null;
  return {
    games: inside.map((r, k) => ({ index: counts[k].index, start: r.start, end: r.end })),
    breaks: inside.slice(0, -1).map((r, k) => ({
      afterGame: counts[k].index,
      start: r.end,
      end: inside[k + 1].start,
      located: true,
    })),
  };
}

/** The watch was paused once between each pair of games. */
function watchPauses(near: Recording[], counts: GameCount[], window: TimeSpan): Timeline | null {
  if (counts.length < 2) return null;
  const pauses: TimeSpan[] = [];
  for (const r of near) {
    let pausedAt: number | null = null;
    for (const e of [...r.events].sort((a, b) => a.t - b.t)) {
      if (e.type.includes("PAUSE")) pausedAt = e.t;
      else if (e.type.includes("RESUME") && pausedAt !== null) {
        if (e.t - pausedAt >= 20_000 && pausedAt > window.start && e.t < window.end) {
          pauses.push({ start: pausedAt, end: e.t });
        }
        pausedAt = null;
      }
    }
  }
  if (pauses.length !== counts.length - 1) return null;
  const breaks = pauses.map((p, k) => ({ afterGame: counts[k].index, ...p, located: true }));
  return { games: gamesBetween(window, counts, breaks), breaks };
}

function gamesBetween(window: TimeSpan, counts: GameCount[], breaks: BreakSpan[]): GameSpan[] {
  return counts.map((c, k) => ({
    index: c.index,
    start: k === 0 ? window.start : breaks[k - 1].end,
    end: k === counts.length - 1 ? window.end : breaks[k].start,
  }));
}

/**
 * Between games HR falls fast (often 15-25 bpm in 30s), unlike the short pauses between rallies.
 * Near each expected break, find where the 30s drop is largest, then follow it to the trough
 * where play resumed.
 */
export function locateBreaksFromHr(
  hr: HrSample[],
  window: TimeSpan,
  expected: Timeline,
  counts: GameCount[],
  opts: AlignOptions,
): { timeline: Timeline; allLocated: boolean } | null {
  if (counts.length < 2) return null;
  const series = smooth(resample1Hz(hr, window.start, window.end), 15);
  const T = series.length;
  if (T < 120) return null;
  let have = 0;
  for (const v of series) if (!Number.isNaN(v)) have++;
  if (have / T < 0.6) return null;

  const sec = (t: number) => Math.round((t - window.start) / 1000);
  const breaks: BreakSpan[] = [];
  let allLocated = true;
  let gameStart = 0;

  for (let k = 0; k < counts.length - 1; k++) {
    const expStart = sec(expected.breaks[k].start);
    const expGame = (expected.games[k].end - expected.games[k].start) / 1000;
    const expNext = (expected.games[k + 1].end - expected.games[k + 1].start) / 1000;
    const W = Math.min(240, Math.max(60, 0.35 * Math.min(expGame, expNext)));
    const restAfter = counts.slice(k + 1).reduce((n, c) => n + c.n, 0) * MIN_SEC_PER_RALLY;
    const lo = Math.max(gameStart + counts[k].n * MIN_SEC_PER_RALLY, expStart - W);
    const hi = Math.min(expStart + W, T - restAfter - MIN_BREAK_SEC);

    let best: { s: number; d: number; score: number; drop30: number; dropTotal: number } | null = null;
    for (let s = Math.ceil(lo); s <= hi; s += 2) {
      const before = meanRange(series, s - 5, s);
      const after30 = meanRange(series, s + 25, s + 35);
      if (Number.isNaN(before) || Number.isNaN(after30)) continue;
      const drop30 = before - after30;
      const score = drop30 - (DEVIATION_PENALTY_BPM * Math.abs(s - expStart)) / W;
      if (best && score <= best.score) continue;
      let trough = Infinity;
      let troughAt = -1;
      for (let d = MIN_BREAK_SEC; d <= MAX_BREAK_SEC && s + d < T; d += 2) {
        const v = meanRange(series, s + d - 3, s + d + 3);
        if (v < trough) {
          trough = v;
          troughAt = d;
        }
      }
      if (troughAt < 0) continue;
      best = { s, d: troughAt, score, drop30, dropTotal: before - trough };
    }

    if (best && best.drop30 >= MIN_DROP30_BPM && best.dropTotal >= MIN_DROP_TOTAL_BPM) {
      breaks.push({
        afterGame: counts[k].index,
        start: window.start + best.s * 1000,
        end: window.start + (best.s + best.d) * 1000,
        located: true,
      });
      gameStart = best.s + best.d;
    } else {
      const s = Math.max(expStart, gameStart + counts[k].n * MIN_SEC_PER_RALLY);
      breaks.push({
        afterGame: counts[k].index,
        start: window.start + s * 1000,
        end: window.start + (s + opts.breakSec) * 1000,
        located: false,
      });
      gameStart = s + opts.breakSec;
      allLocated = false;
    }
  }

  const games = gamesBetween(window, counts, breaks);
  const tooShort = games.some((g, k) => (g.end - g.start) / 1000 < counts[k].n * MIN_SEC_PER_RALLY);
  if (tooShort || breaks.every((b) => !b.located)) return null;
  return { timeline: { games, breaks }, allLocated };
}

function measuredTimeline(session: Session): { timeline: Timeline; rallies: TimeSpan[] } {
  const ev = session.events;
  const gaps: number[] = [];
  for (let i = 1; i < ev.length; i++) {
    if (ev[i].segment === ev[i - 1].segment) gaps.push(ev[i].at! - ev[i - 1].at!);
  }
  gaps.sort((a, b) => a - b);
  const typical = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 20_000;
  const rallies = ev.map((e, i) => ({
    start: i > 0 && ev[i - 1].segment === e.segment ? ev[i - 1].at! : e.at! - typical,
    end: e.at!,
  }));
  const games: GameSpan[] = [];
  for (const s of session.segments) {
    const idx = ev.map((e, i) => (e.segment === s.index ? i : -1)).filter((i) => i >= 0);
    if (idx.length > 0) games.push({ index: s.index, start: rallies[idx[0]].start, end: rallies[idx[idx.length - 1]].end });
  }
  const breaks = games.slice(0, -1).map((g, k) => ({
    afterGame: g.index,
    start: g.end,
    end: games[k + 1].start,
    located: true,
  }));
  return { timeline: { games, breaks }, rallies };
}

function spreadRallies(session: Session, games: GameSpan[]): TimeSpan[] {
  const out: TimeSpan[] = [];
  for (const g of games) {
    const inGame = session.events.filter((e) => e.segment === g.index);
    const step = (g.end - g.start) / Math.max(1, inGame.length);
    inGame.forEach((_, j) => out.push({ start: g.start + j * step, end: g.start + (j + 1) * step }));
  }
  return out;
}

function recovery(hr: HrSample[], b: BreakSpan): BreakRecovery {
  const from = b.start - 30_000;
  const series = smooth(resample1Hz(hr, from, b.end + 30_000), 5);
  const at = (t: number) => Math.round((t - from) / 1000);
  const s = at(b.start);
  let peak = -Infinity;
  for (let i = Math.max(0, s - 15); i <= Math.min(series.length - 1, s + 5); i++) {
    if (!Number.isNaN(series[i]) && series[i] > peak) peak = series[i];
  }
  const hrPeak = Number.isFinite(peak) ? peak : NaN;
  const hr30 = b.end - b.start >= 30_000 ? meanRange(series, s + 28, s + 32) : NaN;
  const hr60 = b.end - b.start >= 60_000 ? meanRange(series, s + 58, s + 62) : NaN;
  const hrResume = meanRange(series, at(b.end) - 3, at(b.end) + 3);
  const num = (v: number) => (Number.isNaN(v) ? null : round1(v));
  return {
    ...b,
    hrPeak: num(hrPeak),
    hr30: num(hr30),
    hr60: num(hr60),
    hrResume: num(hrResume),
    drop60: Number.isNaN(hrPeak) || Number.isNaN(hr60) ? null : round1(hrPeak - hr60),
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
