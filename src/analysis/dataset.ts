// Joins matches with wearable data and computes everything the dashboard shows.
import type { DailyContext, Session, Side, WearableData } from "../model.ts";
import { rallyContexts, shuffleGame, type RallyContext } from "../sports/squash.ts";
import { alignSession, type Alignment, type BreakRecovery } from "../sync/align.ts";
import { percentile, slice } from "../sync/hr.ts";
import { matchView, observedHrMax, summarize, type MatchView, type Summaries } from "./matches.ts";
import { mean, mulberry32, sd, slope, wilson } from "./stats.ts";

export interface BuildOptions {
  me?: string;
  hrMax?: number;
  breakSec: number;
  demo?: boolean;
  /** Only work out insights for these players (default: everyone). */
  players?: string[];
  /** Drop every match `me` didn't play, so nobody else's data is kept. */
  onlyMine?: boolean;
}

export interface Bucket {
  key: string;
  label: string;
  /** Rallies played (lets excluded). */
  n: number;
  won: number;
  pct: number | null;
  /** 95% interval for pct. */
  lo: number | null;
  hi: number | null;
  /** The win rate you'd expect if the situation made no difference (see `baseline`). */
  exp: number | null;
  /** Observed minus expected wins, in standard errors (|z| >= 1.96 is a clear difference). */
  z: number | null;
  /**
   * How `exp` was worked out. "shuffled": rally order reshuffled within the same games, i.e. what
   * the situation would get by chance. "opponents": your rate against the same opponents in your
   * other matches, for situations that last a whole game (game number, deciding game).
   */
  baseline: "shuffled" | "opponents" | null;
  /** Mean rally HR in bpm (rallies once HR has settled into each game). */
  hr: number | null;
  /** Mean rally HR above/below the trend for that point in the game. */
  hrDelta: number | null;
  hrN: number;
}

export interface Headline {
  tone: "strength" | "weakness" | "neutral";
  title: string;
  detail: string;
  /** For comparisons: is the difference real? "clear" (p < .05), "possible" (p < .2), "none". Null for plain observations. */
  evidence: "clear" | "possible" | "none" | null;
}

export interface AlignView {
  basis: Alignment["basis"];
  confidence: number;
  window: [number, number];
  games: [number, number][];
  breaks: BreakRecovery[];
  /** Parallel to SessionView.rallies: [start, end, mean HR]. */
  rallies: [number, number, number | null][];
  hr: Alignment["hr"];
  recordingOffsetSec: number | null;
}

export interface SessionView {
  id: string;
  startedAt: number;
  endedAt: number | null;
  minutes: number | null;
  format: string;
  players: [{ id: string; name: string }, { id: string; name: string }];
  winner: 0 | 1 | null;
  games: [number, number][];
  quality: Session["quality"];
  /** Complete point logs only: game, score before the rally (a-b), kind, winner, pressure 0-100. */
  rallies: { g: number; a: number; b: number; k: "point" | "stroke" | "let"; w: Side | null; p: number }[];
  align: AlignView | null;
  daily: DailyContext | null;
}

export interface PlayerInsights {
  id: string;
  name: string;
  isMe: boolean;
  hasHr: boolean;
  record: {
    matches: number;
    wins: number;
    games: [number, number];
    rallies: [number, number];
    avgMinutes: number | null;
  };
  byDiff: Bucket[];
  byPressure: Bucket[];
  situations: Bucket[];
  byGame: Bucket[];
  byPhase: Bucket[];
  momentum: Bucket[];
  byHrZone: Bucket[] | null;
  recovery: { sessionId: string; startedAt: number; afterGame: number; drop60: number; hrPeak: number | null; hr60: number | null }[];
  intensity: {
    sessionId: string;
    startedAt: number;
    opponent: string;
    won: boolean;
    pointDiff: number;
    games: number;
    minutes: number | null;
    hrMean: number;
    hrMax: number;
    /** Share of match time at 90%+ of max HR. */
    highShare: number | null;
  }[];
  readiness: {
    sessionId: string;
    startedAt: number;
    won: boolean;
    rallyPct: number | null;
    restingHr: number | null;
    hrvMs: number | null;
    sleepMinutes: number | null;
  }[];
  opponents: { name: string; played: number; won: number; rallyPct: number | null }[];
  headlines: Headline[];
}

/** Bumped when the shape changes, so stored analysis from an older version gets rebuilt. */
export const DATASET_VERSION = 2;

export interface Dataset {
  version: number;
  generatedAt: number;
  demo: boolean;
  me: { id: string; name: string } | null;
  hrMax: number | null;
  hrMaxSource: "config" | "observed" | null;
  wearable: { provider: string; syncedAt: number; recordings: number; samples: number } | null;
  players: { id: string; name: string }[];
  /** Squash matches, for the rally-by-rally analysis. */
  sessions: SessionView[];
  insights: Record<string, PlayerInsights>;
  /** Every match `me` played, any sport, newest first, with heart rate, steps and efficiency. */
  matches: MatchView[];
  summaries: Summaries;
  quality: { matches: number; completeLogs: number; live: number; suspect: number; untimed: number; withHr: number };
}

interface Row extends RallyContext {
  sessionId: string;
  hr: number | null;
  /** HR above (+) or below (−) your typical HR at that point of a game; null while HR is still climbing after a rest. */
  hrDelta: number | null;
  hrPct: number | null;
  /** Your usual rally win rate: against the same opponent in your other matches. */
  expected: number | null;
  /** How many rallies `expected` was estimated from. */
  expectedN: number;
}

/** Rallies at the start of each game, while HR is still climbing back after the rest. */
const SETTLE_RALLIES = 3;
/** Fewer rallies than this against an opponent elsewhere, and "usual" falls back to all your other matches. */
const MIN_USUAL_RALLIES = 20;

/**
 * Your usual rally win rate for each match, from your OTHER matches against the same opponent
 * (or all other matches if you've rarely played them). Using other matches matters: within a
 * match, the rallies that built a lead would inflate the baseline you're compared against.
 */
function usualRates(
  sessions: Session[],
  contexts: Map<string, RallyContext[]>,
  opponentOf: (s: Session) => string,
): Map<string, { rate: number; n: number }> {
  const tally = (s: Session) => {
    const decided = contexts.get(s.id)!.filter((c) => c.won !== null);
    return { won: decided.filter((c) => c.won).length, n: decided.length };
  };
  const all = { won: 0, n: 0 };
  const byOpponent = new Map<string, { won: number; n: number }>();
  for (const s of sessions) {
    const t = tally(s);
    all.won += t.won;
    all.n += t.n;
    const o = byOpponent.get(opponentOf(s)) ?? { won: 0, n: 0 };
    o.won += t.won;
    o.n += t.n;
    byOpponent.set(opponentOf(s), o);
  }
  const out = new Map<string, { rate: number; n: number }>();
  for (const s of sessions) {
    const t = tally(s);
    const o = byOpponent.get(opponentOf(s))!;
    const vsOpponent = { won: o.won - t.won, n: o.n - t.n };
    const pool = vsOpponent.n >= MIN_USUAL_RALLIES ? vsOpponent : { won: all.won - t.won, n: all.n - t.n };
    if (pool.n > 0) out.set(s.id, { rate: pool.won / pool.n, n: pool.n });
  }
  return out;
}

/**
 * Heart rate climbs back after each rest and drifts up through a game and a match, and pressure
 * rises at the same moments, so raw HR would credit the score for what the clock did. Each rally
 * is compared instead with your typical HR at that point of a game (same game number, same stage),
 * learned across all your matches: leads and deficits fall at different points in different games,
 * so the typical shape absorbs the clock but not the score.
 */
function setHrDeltas(rows: Row[]): void {
  const settled = rows.filter((r) => r.hr !== null && r.rallyInGame >= SETTLE_RALLIES);
  const centred = new Map<Row, number>();
  const bySession = new Map<string, Row[]>();
  for (const r of settled) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  for (const rs of bySession.values()) {
    const m = mean(rs.map((r) => r.hr!));
    for (const r of rs) centred.set(r, r.hr! - m);
  }
  const stage = (r: Row) => `${r.game}:${Math.min(7, Math.floor(r.rallyInGame / 3))}`;
  const cells = new Map<string, number[]>();
  for (const [r, v] of centred) cells.set(stage(r), [...(cells.get(stage(r)) ?? []), v]);
  const typical = new Map([...cells].map(([k, vs]) => [k, mean(vs)]));
  for (const [r, v] of centred) r.hrDelta = round1(v - (typical.get(stage(r)) ?? 0));
}

interface BucketDef {
  key: string;
  label: string;
  test: (r: Row) => boolean;
  /**
   * Fixed for a whole game (which game it is, deciding or not). Shuffling rallies within a game
   * can't test these, so they're judged against your usual vs the same opponent instead.
   */
  wholeGame?: boolean;
}

const PERMUTATIONS = 200;

/**
 * What each situation's win rate would be by chance. Rally order is reshuffled within every game
 * (same final score, only orders that squash scoring allows) and the situations are recomputed.
 * Because each game keeps its own score, this controls for the opponent and for how your day was
 * going, and it handles the subtle bias of judging streaks inside short sequences.
 */
function shuffledRates(
  complete: Session[],
  sideOf: (s: Session) => Side,
  rowsBySession: Map<string, Row[]>,
  defs: BucketDef[],
): Map<BucketDef, number[]> {
  const rand = mulberry32(7);
  const active = defs.filter((d) => !d.wholeGame);
  const rates = new Map<BucketDef, number[]>(active.map((d) => [d, []]));
  const won = new Float64Array(active.length);
  const seen = new Float64Array(active.length);
  const prepared = complete.map((s) => {
    const events = s.events.map((e) => ({ ...e }));
    const games = s.segments.map((g) => {
      const idx = events.flatMap((e, i) => (e.segment === g.index && e.wonBy !== null ? [i] : []));
      return { idx, outcomes: idx.map((i) => events[i].wonBy!) };
    });
    return { session: { ...s, events }, games, side: sideOf(s), original: rowsBySession.get(s.id)! };
  });
  for (let p = 0; p < PERMUTATIONS; p++) {
    won.fill(0);
    seen.fill(0);
    for (const { session, games, side, original } of prepared) {
      for (const g of games) {
        const order = shuffleGame(g.outcomes, rand);
        g.idx.forEach((i, j) => (session.events[i].wonBy = order[j]));
      }
      const shuffled = rallyContexts(session, side);
      for (let i = 0; i < shuffled.length; i++) {
        const c = shuffled[i] as Row;
        if (c.won === null) continue;
        // Heart rate stays where it was measured; only who won each rally moves.
        c.hrPct = original[i].hrPct;
        for (let k = 0; k < active.length; k++) {
          if (!active[k].test(c)) continue;
          seen[k]++;
          if (c.won) won[k]++;
        }
      }
    }
    active.forEach((d, k) => {
      if (seen[k] > 0) rates.get(d)!.push(won[k] / seen[k]);
    });
  }
  return rates;
}

// Pressure = how much the rally swings your chance of winning the match (see sports/squash.ts).
// Cut-points sit near the league's 22nd/72nd/92nd percentiles, so every band has enough rallies.
export const PRESSURE_LEVELS: BucketDef[] = [
  { key: "low", label: "Low", test: (r) => r.pressure < 0.15 },
  { key: "medium", label: "Medium", test: (r) => r.pressure >= 0.15 && r.pressure < 0.3 },
  { key: "high", label: "High", test: (r) => r.pressure >= 0.3 && r.pressure < 0.5 },
  { key: "critical", label: "Critical", test: (r) => r.pressure >= 0.5 },
];
const HIGH_PRESSURE = 0.3;

const DIFF: BucketDef[] = [
  { key: "m5", label: "Down 5+", test: (r) => r.diff <= -5 },
  { key: "m3", label: "Down 3-4", test: (r) => r.diff <= -3 && r.diff >= -4 },
  { key: "m1", label: "Down 1-2", test: (r) => r.diff <= -1 && r.diff >= -2 },
  { key: "level", label: "Level", test: (r) => r.diff === 0 },
  { key: "p1", label: "Up 1-2", test: (r) => r.diff >= 1 && r.diff <= 2 },
  { key: "p3", label: "Up 3-4", test: (r) => r.diff >= 3 && r.diff <= 4 },
  { key: "p5", label: "Up 5+", test: (r) => r.diff >= 5 },
];

const SITUATIONS: BucketDef[] = [
  { key: "first", label: "First rally of a game", test: (r) => r.my === 0 && r.opp === 0 },
  { key: "gbFor", label: "Game ball for you", test: (r) => r.gameBallFor && !r.gameBallAgainst },
  { key: "gbAgainst", label: "Game ball against you", test: (r) => r.gameBallAgainst && !r.gameBallFor },
  { key: "tiebreak", label: "Both on 10+", test: (r) => r.tiebreak },
  { key: "mbFor", label: "Match ball for you", test: (r) => r.matchBallFor && !r.matchBallAgainst },
  { key: "mbAgainst", label: "Match ball against you", test: (r) => r.matchBallAgainst && !r.matchBallFor },
  { key: "deciding", label: "Deciding game", test: (r) => r.deciding, wholeGame: true },
];

const PHASES: BucketDef[] = [
  { key: "early", label: "Early (to 4)", test: (r) => r.phase === "early" },
  { key: "middle", label: "Middle (5-7)", test: (r) => r.phase === "middle" },
  { key: "late", label: "Late (8+)", test: (r) => r.phase === "late" },
];

const MOMENTUM: BucketDef[] = [
  { key: "l3", label: "Lost 3+ in a row", test: (r) => r.streak <= -3 },
  { key: "l2", label: "Lost last 2", test: (r) => r.streak === -2 },
  { key: "l1", label: "Lost last 1", test: (r) => r.streak === -1 },
  { key: "w1", label: "Won last 1", test: (r) => r.streak === 1 },
  { key: "w2", label: "Won last 2", test: (r) => r.streak === 2 },
  { key: "w3", label: "Won 3+ in a row", test: (r) => r.streak >= 3 },
];

const HR_ZONES: BucketDef[] = [
  { key: "z0", label: "Under 80%", test: (r) => r.hrPct !== null && r.hrPct < 0.8 },
  { key: "z80", label: "80-85%", test: (r) => r.hrPct !== null && r.hrPct >= 0.8 && r.hrPct < 0.85 },
  { key: "z85", label: "85-90%", test: (r) => r.hrPct !== null && r.hrPct >= 0.85 && r.hrPct < 0.9 },
  { key: "z90", label: "90-95%", test: (r) => r.hrPct !== null && r.hrPct >= 0.9 && r.hrPct < 0.95 },
  { key: "z95", label: "95%+", test: (r) => r.hrPct !== null && r.hrPct >= 0.95 },
];

export function buildDataset(all: Session[], wearable: WearableData | null, opts: BuildOptions): Dataset {
  const players = uniquePlayers(all);
  const me = opts.me ? (players.find((p) => p.name.toLowerCase() === opts.me!.toLowerCase()) ?? null) : null;
  if (opts.me && !me) {
    throw new Error(`ME="${opts.me}" isn't a player in the scoring app. Players: ${players.map((p) => p.name).join(", ")}`);
  }
  const isMine = (s: Session) => me !== null && s.participants.some((p) => p.id === me.id);
  const sessions = opts.onlyMine && me ? all.filter(isMine) : all;
  const squash = sessions.filter((s) => s.sport === "squash");

  // Heart rate belongs to the watch owner, so only their matches are aligned. Games and rests are
  // placed on the clock for squash; other sports use the match times as they are.
  const alignments = new Map<string, Alignment>();
  if (me && wearable) {
    for (const s of squash) {
      if (!isMine(s)) continue;
      const a = alignSession(s, wearable.recordings, wearable.heartRate, { breakSec: opts.breakSec });
      if (a?.hr) alignments.set(s.id, a);
    }
  }

  let hrMax = opts.hrMax ?? null;
  let hrMaxSource: Dataset["hrMaxSource"] = hrMax ? "config" : null;
  if (!hrMax && wearable && me) {
    const windows = sessions.filter(isMine).flatMap((s) => {
      const a = alignments.get(s.id);
      if (a) return [a.window];
      return s.sport !== "squash" && s.endedAt !== null && s.quality.timing !== "untimed" ? [{ start: s.startedAt, end: s.endedAt }] : [];
    });
    hrMax = observedHrMax(wearable.heartRate, windows);
    if (hrMax) hrMaxSource = "observed";
  }

  const dailyByDate = new Map((wearable?.daily ?? []).map((d) => [d.date, d]));
  const dailyFor = (s: Session): DailyContext | null => {
    if (!wearable || !isMine(s)) return null;
    const a = alignments.get(s.id);
    const rec = a ? wearable.recordings.find((r) => a.recordingIds.includes(r.id)) : undefined;
    const offsetMin = s.utcOffsetMinutes ?? (rec ? rec.utcOffsetMinutes : -new Date(s.startedAt).getTimezoneOffset());
    return dailyByDate.get(new Date(s.startedAt + offsetMin * 60_000).toISOString().slice(0, 10)) ?? null;
  };

  const views = squash.map((s): SessionView => {
    const a = alignments.get(s.id);
    const ctx = s.quality.logComplete ? rallyContexts(s, "a") : [];
    const [pa, pb] = s.participants;
    return {
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      minutes: s.endedAt && s.quality.timing !== "untimed" ? round1((s.endedAt - s.startedAt) / 60_000) : null,
      format: s.format,
      players: [
        { id: pa.id, name: pa.name },
        { id: pb.id, name: pb.name },
      ],
      winner: s.winner === "a" ? 0 : s.winner === "b" ? 1 : null,
      games: s.segments.map((g) => [g.scoreA, g.scoreB] as [number, number]),
      quality: s.quality,
      rallies: ctx.map((c) => ({
        g: c.game,
        a: c.my,
        b: c.opp,
        k: c.kind,
        w: c.won === null ? null : c.won ? "a" : "b",
        p: Math.round(c.pressure * 100),
      })),
      align: a ? toView(a) : null,
      daily: dailyFor(s),
    };
  });

  const insights: Record<string, PlayerInsights> = {};
  const wanted = opts.players?.map((n) => n.toLowerCase());
  for (const p of uniquePlayers(squash)) {
    if (wanted && !wanted.includes(p.name.toLowerCase())) continue;
    insights[p.id] = playerInsights(p, squash, views, alignments, me?.id === p.id, hrMax, wearable);
  }

  const resting = (wearable?.daily ?? []).map((d) => d.restingHr).filter((v): v is number => typeof v === "number");
  const typicalRestingHr = resting.length > 0 ? Math.round(percentile(resting, 0.5)) : null;
  const matches = me
    ? sessions
        .filter(isMine)
        .map((s) =>
          matchView(s, {
            side: s.participants.find((p) => p.id === me.id)!.side,
            alignment: alignments.get(s.id) ?? null,
            heartRate: wearable?.heartRate ?? [],
            steps: wearable?.steps ?? [],
            recordings: wearable?.recordings ?? [],
            hrMax,
            daily: dailyFor(s),
            typicalRestingHr,
          }),
        )
        .sort((a, b) => b.startedAt - a.startedAt)
    : [];

  return {
    version: DATASET_VERSION,
    generatedAt: Date.now(),
    demo: Boolean(opts.demo),
    me,
    hrMax,
    hrMaxSource,
    wearable: wearable
      ? {
          provider: wearable.provider,
          syncedAt: wearable.syncedAt,
          recordings: wearable.recordings.length,
          samples: wearable.heartRate.length,
        }
      : null,
    players: opts.onlyMine && me ? [me] : players,
    sessions: views,
    insights,
    matches,
    summaries: summarize(matches),
    quality: {
      matches: sessions.length,
      completeLogs: sessions.filter((s) => s.quality.logComplete).length,
      live: sessions.filter((s) => s.quality.timing === "live").length,
      suspect: sessions.filter((s) => s.quality.timing === "suspect").length,
      untimed: sessions.filter((s) => s.quality.timing === "untimed").length,
      withHr: matches.filter((m) => m.hr).length,
    },
  };
}

function uniquePlayers(sessions: Session[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const s of sessions) for (const p of s.participants) byId.set(p.id, p.name);
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

function toView(a: Alignment): AlignView {
  return {
    basis: a.basis,
    confidence: a.confidence,
    window: [a.window.start, a.window.end],
    games: a.games.map((g) => [g.start, g.end]),
    breaks: a.breaks,
    rallies: a.rallies.map((r) => [Math.round(r.start), Math.round(r.end), r.hrMean]),
    hr: a.hr,
    recordingOffsetSec: a.recordingOffsetSec,
  };
}

function playerInsights(
  player: { id: string; name: string },
  sessions: Session[],
  views: SessionView[],
  alignments: Map<string, Alignment>,
  isMe: boolean,
  hrMax: number | null,
  wearable: WearableData | null,
): PlayerInsights {
  const mine = sessions.filter((s) => s.participants.some((p) => p.id === player.id));
  const sideOf = (s: Session): Side => s.participants.find((p) => p.id === player.id)!.side;
  const opponentOf = (s: Session) => s.participants.find((p) => p.id !== player.id)!.name;

  const complete = mine.filter((s) => s.quality.logComplete);
  const contexts = new Map(complete.map((s) => [s.id, rallyContexts(s, sideOf(s))]));
  const usual = usualRates(complete, contexts, opponentOf);

  const rows: Row[] = [];
  const rowsBySession = new Map<string, Row[]>();
  for (const s of complete) {
    const a = isMe ? alignments.get(s.id) : undefined;
    const base = usual.get(s.id);
    const sessionRows = contexts.get(s.id)!.map((c, i): Row => {
      const hr = a?.rallies[i]?.hrMean ?? null;
      return {
        ...c,
        sessionId: s.id,
        hr,
        hrDelta: null,
        hrPct: hr !== null && hrMax ? hr / hrMax : null,
        expected: base?.rate ?? null,
        expectedN: base?.n ?? 0,
      };
    });
    rowsBySession.set(s.id, sessionRows);
    rows.push(...sessionRows);
  }
  setHrDeltas(rows);
  const hasHr = rows.some((r) => r.hr !== null);

  let gamesWon = 0;
  let gamesLost = 0;
  for (const s of mine) {
    for (const g of s.segments) {
      if (g.winner === sideOf(s)) gamesWon++;
      else if (g.winner) gamesLost++;
    }
  }
  const played = rows.filter((r) => r.won !== null);
  const ralliesWon = played.filter((r) => r.won).length;
  const minutes = mine
    .filter((s) => s.quality.timing === "live" && s.endedAt)
    .map((s) => (s.endedAt! - s.startedAt) / 60_000);

  const recovery: PlayerInsights["recovery"] = [];
  const intensity: PlayerInsights["intensity"] = [];
  if (isMe && wearable) {
    for (const s of mine) {
      const a = alignments.get(s.id);
      if (!a?.hr) continue;
      for (const b of a.breaks) {
        if (b.located && b.drop60 !== null) {
          recovery.push({ sessionId: s.id, startedAt: s.startedAt, afterGame: b.afterGame, drop60: b.drop60, hrPeak: b.hrPeak, hr60: b.hr60 });
        }
      }
      const inMatch = slice(wearable.heartRate, a.window.start, a.window.end);
      const side = sideOf(s);
      const pointsFor = s.segments.reduce((n, g) => n + (side === "a" ? g.scoreA : g.scoreB), 0);
      const pointsAgainst = s.segments.reduce((n, g) => n + (side === "a" ? g.scoreB : g.scoreA), 0);
      intensity.push({
        sessionId: s.id,
        startedAt: s.startedAt,
        opponent: opponentOf(s),
        won: s.winner === side,
        pointDiff: pointsFor - pointsAgainst,
        games: s.segments.length,
        minutes: views.find((v) => v.id === s.id)?.minutes ?? null,
        hrMean: a.hr.mean,
        hrMax: a.hr.max,
        highShare: hrMax && inMatch.length > 0 ? round2(inMatch.filter((x) => x.bpm >= 0.9 * hrMax).length / inMatch.length) : null,
      });
    }
  }

  const readiness: PlayerInsights["readiness"] = [];
  if (isMe) {
    for (const s of mine) {
      const d = views.find((v) => v.id === s.id)?.daily;
      if (!d) continue;
      const rs = (rowsBySession.get(s.id) ?? []).filter((r) => r.won !== null);
      readiness.push({
        sessionId: s.id,
        startedAt: s.startedAt,
        won: s.winner === sideOf(s),
        rallyPct: rs.length > 0 ? round2(rs.filter((r) => r.won).length / rs.length) : null,
        restingHr: d.restingHr ?? null,
        hrvMs: d.hrvMs ?? null,
        sleepMinutes: d.sleepMinutes ?? null,
      });
    }
  }

  const opponents = new Map<string, { played: number; won: number; rk: number; rn: number }>();
  for (const s of mine) {
    const o = opponents.get(opponentOf(s)) ?? { played: 0, won: 0, rk: 0, rn: 0 };
    o.played++;
    if (s.winner === sideOf(s)) o.won++;
    for (const r of rowsBySession.get(s.id) ?? []) {
      if (r.won === null) continue;
      o.rn++;
      if (r.won) o.rk++;
    }
    opponents.set(opponentOf(s), o);
  }

  const byGame: BucketDef[] = [...new Set(rows.map((r) => r.game))]
    .sort((a, b) => a - b)
    .map((g) => ({ key: `g${g}`, label: `Game ${g}`, test: (r: Row) => r.game === g, wholeGame: true }));
  const zones = hasHr && hrMax ? HR_ZONES : [];
  const allDefs = [...DIFF, ...PRESSURE_LEVELS, ...SITUATIONS, ...PHASES, ...MOMENTUM, ...zones, ...HEADLINE_GROUPS.map((g) => g.def)];
  const shuffled = shuffledRates(complete, sideOf, rowsBySession, allDefs);
  const judge = (defs: BucketDef[]) => defs.map((d) => judgeBucket(rows, d, shuffled));

  const insights: PlayerInsights = {
    id: player.id,
    name: player.name,
    isMe,
    hasHr,
    record: {
      matches: mine.length,
      wins: mine.filter((s) => s.winner === sideOf(s)).length,
      games: [gamesWon, gamesLost],
      rallies: [ralliesWon, played.length - ralliesWon],
      avgMinutes: minutes.length > 0 ? round1(mean(minutes)) : null,
    },
    byDiff: judge(DIFF),
    byPressure: judge(PRESSURE_LEVELS),
    situations: judge(SITUATIONS),
    byGame: judge(byGame),
    byPhase: judge(PHASES),
    momentum: judge(MOMENTUM),
    byHrZone: zones.length > 0 ? judge(zones) : null,
    recovery,
    intensity,
    readiness,
    opponents: [...opponents]
      .map(([name, o]) => ({ name, played: o.played, won: o.won, rallyPct: o.rn > 0 ? round2(o.rk / o.rn) : null }))
      .sort((a, b) => b.played - a.played),
    headlines: [],
  };
  const groups = HEADLINE_GROUPS.map((g) => ({ ...g, bucket: judgeBucket(rows, g.def, shuffled) }));
  insights.headlines = headlines(rows, insights, groups);
  return insights;
}

/** Observed wins vs the wins your usual rate predicts for the same rallies. */
function versusUsual(rs: Row[]): { n: number; won: number; expected: number; z: number } {
  const scored = rs.filter((r) => r.won !== null && r.expected !== null);
  const won = scored.filter((r) => r.won).length;
  const expected = scored.reduce((acc, r) => acc + r.expected!, 0);
  // Rally-to-rally chance, plus the uncertainty in each match's usual rate.
  let variance = scored.reduce((acc, r) => acc + r.expected! * (1 - r.expected!), 0);
  const perMatch = new Map<string, { k: number; p: number; n: number }>();
  for (const r of scored) {
    const m = perMatch.get(r.sessionId) ?? { k: 0, p: r.expected!, n: r.expectedN };
    m.k++;
    perMatch.set(r.sessionId, m);
  }
  for (const m of perMatch.values()) if (m.n > 0) variance += (m.k * m.k * m.p * (1 - m.p)) / m.n;
  return { n: scored.length, won, expected, z: variance > 0 ? (won - expected) / Math.sqrt(variance) : 0 };
}

/** A situation's win rate next to what you'd expect if the situation made no difference. */
function judgeBucket(rows: Row[], d: BucketDef, shuffled: Map<BucketDef, number[]>): Bucket {
  const rs = rows.filter((r) => r.won !== null && d.test(r));
  const won = rs.filter((r) => r.won).length;
  const ci = wilson(won, rs.length);
  let exp: number | null = null;
  let z: number | null = null;
  let baseline: Bucket["baseline"] = null;
  const sims = shuffled.get(d) ?? [];
  if (!d.wholeGame && sims.length >= PERMUTATIONS / 2 && rs.length > 0) {
    exp = mean(sims);
    const spread = sd(sims);
    z = spread > 0 ? (won / rs.length - exp) / spread : 0;
    baseline = "shuffled";
  } else {
    const u = versusUsual(rs);
    if (u.n > 0) {
      exp = u.expected / u.n;
      z = u.z;
      baseline = "opponents";
    }
  }
  const hrs = rs.filter((r) => r.hrDelta !== null);
  return {
    key: d.key,
    label: d.label,
    n: rs.length,
    won,
    pct: rs.length > 0 ? round3(won / rs.length) : null,
    lo: ci ? round3(ci[0]) : null,
    hi: ci ? round3(ci[1]) : null,
    exp: exp === null ? null : round3(exp),
    z: z === null ? null : round2(z),
    baseline,
    hr: hrs.length > 0 ? round1(mean(hrs.map((r) => r.hr!))) : null,
    hrDelta: hrs.length > 0 ? round1(mean(hrs.map((r) => r.hrDelta!))) : null,
    hrN: hrs.length,
  };
}

/** Situations worth a sentence on the dashboard, each with its own test. */
const HEADLINE_GROUPS: { title: string; label: string; def: BucketDef }[] = [
  { title: "Down 3-4 points", label: "Down 3-4", def: { key: "h-down34", label: "Down 3-4", test: (r) => r.diff <= -3 && r.diff >= -4 } },
  { title: "Protecting a lead", label: "Up 3 or more", def: { key: "h-up3", label: "Up 3+", test: (r) => r.diff >= 3 } },
  { title: "Under pressure", label: "High-pressure rallies", def: { key: "h-pressure", label: "High pressure", test: (r) => r.pressure >= HIGH_PRESSURE } },
  { title: "After losing 2+ in a row", label: "After dropping 2+ rallies", def: { key: "h-lost2", label: "After losing 2+", test: (r) => r.streak <= -2 } },
  { title: "Closing out games", label: "Late in games (8+)", def: { key: "h-late", label: "Late", test: (r) => r.phase === "late" } },
  { title: "Deciding games", label: "In deciding games", def: { key: "h-deciding", label: "Deciding game", test: (r) => r.deciding, wholeGame: true } },
  {
    title: "Playing near your max HR",
    label: "At 90%+ of max HR",
    def: { key: "h-hot", label: "90%+ of max HR", test: (r) => r.hrPct !== null && r.hrPct >= 0.9 },
  },
];

const MIN_N = 15;

// Two-sided t critical values at 95% and 80%, by degrees of freedom (small samples of matches).
const T_TABLE: [number, number, number][] = [
  [1, 12.71, 3.078], [2, 4.303, 1.886], [3, 3.182, 1.638], [4, 2.776, 1.533], [5, 2.571, 1.476],
  [6, 2.447, 1.44], [7, 2.365, 1.415], [8, 2.306, 1.397], [9, 2.262, 1.383], [10, 2.228, 1.372],
  [12, 2.179, 1.356], [15, 2.131, 1.341], [20, 2.086, 1.325], [30, 2.042, 1.31], [Infinity, 1.96, 1.282],
];

function evidenceFromT(t: number, df: number): Headline["evidence"] {
  const [, clear, possible] = T_TABLE.find(([d]) => d >= df) ?? T_TABLE[T_TABLE.length - 1];
  return Math.abs(t) >= clear ? "clear" : Math.abs(t) >= possible ? "possible" : "none";
}

/** Plain-language findings, ranked by how strong the evidence is. */
export function headlines(rows: Row[], ins: PlayerInsights, groups: { title: string; label: string; bucket: Bucket }[]): Headline[] {
  const played = rows.filter((r) => r.won !== null);
  if (played.length < MIN_N * 2) return [];
  const out: (Headline & { weight: number })[] = [];
  const pct = (k: number, n: number) => `${Math.round((100 * k) / n)}%`;
  const share = (p: number) => `${Math.round(100 * p)}%`;
  const evidenceOf = (z: number) => evidenceFromT(z, Infinity);

  // Judged against what the same games would give by chance (or, for whole-game situations, your
  // usual against the same opponents), so tough opponents or an off day can't masquerade as
  // "you fold when behind".
  for (const { title, label, bucket: b } of groups) {
    if (b.n < MIN_N || b.pct === null || b.exp === null || b.z === null) continue;
    const ev = evidenceOf(b.z);
    const gap = Math.round(100 * (b.pct - b.exp));
    const relation = gap === 0 ? "level with" : `${Math.abs(gap)} point${Math.abs(gap) === 1 ? "" : "s"} ${gap > 0 ? "above" : "below"}`;
    const expected =
      b.baseline === "opponents"
        ? `your usual ${share(b.exp)} against the same opponents`
        : `the ${share(b.exp)} you'd expect by chance in the same games`;
    out.push({
      tone: ev === "none" ? "neutral" : b.z > 0 ? "strength" : "weakness",
      title,
      detail: `${label}: you win ${share(b.pct)} of rallies (${b.n} played), ${relation} ${expected}.`,
      evidence: ev,
      weight: Math.abs(b.z),
    });
  }

  const gbFor = played.filter((r) => r.gameBallFor && !r.gameBallAgainst);
  const gbAgainst = played.filter((r) => r.gameBallAgainst && !r.gameBallFor);
  if (gbFor.length >= 8 && gbAgainst.length >= 8) {
    const won = (rs: Row[]) => rs.filter((r) => r.won).length;
    out.push({
      tone: "neutral",
      title: "Game balls",
      detail: `You convert ${pct(won(gbFor), gbFor.length)} of your game balls (${gbFor.length}) and save ${pct(won(gbAgainst), gbAgainst.length)} of your opponent's (${gbAgainst.length}).`,
      evidence: null,
      weight: 0.5,
    });
  }

  // Heart rate (watch owner only). Compared within each match, then across matches, because
  // consecutive rallies' heart rates aren't independent samples.
  const pairedHr = (title: string, aTest: (r: Row) => boolean, bTest: (r: Row) => boolean, describe: (d: number, n: number) => string) => {
    const perMatch = new Map<string, { a: number[]; b: number[] }>();
    for (const r of played) {
      if (r.hrDelta === null) continue;
      const m = perMatch.get(r.sessionId) ?? { a: [], b: [] };
      if (aTest(r)) m.a.push(r.hrDelta);
      else if (bTest(r)) m.b.push(r.hrDelta);
      perMatch.set(r.sessionId, m);
    }
    const diffs = [...perMatch.values()].filter((m) => m.a.length >= 3 && m.b.length >= 3).map((m) => mean(m.a) - mean(m.b));
    if (diffs.length < 5) return;
    const d = mean(diffs);
    const t = d / (sd(diffs) / Math.sqrt(diffs.length));
    out.push({ tone: "neutral", title, detail: describe(d, diffs.length), evidence: evidenceFromT(t, diffs.length - 1), weight: Math.abs(t) });
  };
  const bpmGap = (d: number) => `${Math.abs(d).toFixed(1)} bpm ${d >= 0 ? "higher" : "lower"}`;
  pairedHr(
    "Heart rate when behind",
    (r) => r.diff <= -2,
    (r) => r.diff >= 2,
    (d, n) => `When you're 2+ points behind, your heart rate runs ${bpmGap(d)} than when you're 2+ ahead in the same match (${n} matches).`,
  );
  pairedHr(
    "Heart rate under pressure",
    (r) => r.pressure >= HIGH_PRESSURE,
    (r) => r.pressure < 0.15,
    (d, n) => `On high-pressure rallies your heart rate runs ${bpmGap(d)} than on low-pressure ones in the same match (${n} matches).`,
  );
  if (ins.recovery.length >= 3) {
    const drops = ins.recovery.map((r) => r.drop60);
    let detail = `Between games your HR falls ${mean(drops).toFixed(0)} bpm in the first minute on average (${drops.length} breaks).`;
    if (ins.recovery.length >= 6) {
      const perWeek = slope(ins.recovery.map((r) => r.startedAt / (7 * 86_400_000)), drops);
      if (Number.isFinite(perWeek)) detail += ` Trend: ${perWeek >= 0 ? "+" : ""}${perWeek.toFixed(1)} bpm per week.`;
    }
    out.push({ tone: "neutral", title: "Recovery between games", detail, evidence: null, weight: 0.4 });
  }

  return out
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map(({ weight: _w, ...h }) => h);
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
