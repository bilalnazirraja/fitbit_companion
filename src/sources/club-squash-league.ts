// Score source: the Club Squash League app (GET /api/state on Vercel).
import type { ScoreEvent, Segment, Session, Side, TimingQuality } from "../model.ts";

export const SOURCE_ID = "club-squash-league";

export interface LeaguePlayer {
  id: string;
  name: string;
  createdAt: number;
}

export interface LeagueGame {
  a: number;
  b: number;
  winner: Side | null;
}

export interface LeaguePoint {
  gameIndex: number;
  side: Side | null;
  callType: "point" | "stroke" | "let";
  /** Not recorded by the app yet. If the app starts saving Date.now() here, alignment becomes exact. */
  at?: number;
}

export interface LeagueMatchup {
  id: string;
  playerAId: string;
  playerBId: string;
  matchIndex: number;
  format: string;
  status: string;
  games: LeagueGame[];
  pointLog?: LeaguePoint[];
  winnerId?: string | null;
  startedAt: number;
  completedAt?: number | null;
}

export interface LeagueState {
  players: LeaguePlayer[];
  matchups: LeagueMatchup[];
  updatedAt: number;
}

export async function fetchLeagueState(url: string, doFetch: typeof fetch = fetch): Promise<LeagueState> {
  const res = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Fetching scores failed: ${res.status} ${res.statusText} (${url})`);
  return parseLeagueState(await res.json());
}

export function parseLeagueState(body: unknown): LeagueState {
  const state = body as Partial<LeagueState>;
  if (!Array.isArray(state.players) || !Array.isArray(state.matchups)) {
    throw new Error("Unexpected scores payload: expected { players: [], matchups: [] }");
  }
  return { players: state.players, matchups: state.matchups, updatedAt: state.updatedAt ?? Date.now() };
}

// Seconds per rally, including the gaps between rallies and games. Live club squash runs ~15-30s.
const UNTIMED_BELOW_S = 6;
const SUSPECT_BELOW_S = 11;
const SUSPECT_ABOVE_S = 45;

export function toSessions(state: LeagueState): Session[] {
  const names = new Map(state.players.map((p) => [p.id, p.name]));
  return state.matchups
    .filter((m) => m.status === "completed")
    .map((m) => toSession(m, names))
    .sort((x, y) => x.startedAt - y.startedAt);
}

function toSession(m: LeagueMatchup, names: Map<string, string>): Session {
  const events: ScoreEvent[] = (m.pointLog ?? []).map((p, seq) => ({
    seq,
    segment: p.gameIndex,
    kind: p.callType,
    wonBy: p.callType === "let" ? null : p.side,
    ...(typeof p.at === "number" ? { at: p.at } : {}),
  }));
  const segments: Segment[] = m.games.map((g, i) => ({
    index: i + 1,
    scoreA: g.a,
    scoreB: g.b,
    winner: g.winner ?? null,
  }));

  const notes: string[] = [];
  let logComplete = events.length > 0;
  if (events.length === 0) notes.push("No point-by-point log (score entered as game totals)");
  for (const s of segments) {
    if (events.length === 0) break;
    const a = events.filter((e) => e.segment === s.index && e.wonBy === "a").length;
    const b = events.filter((e) => e.segment === s.index && e.wonBy === "b").length;
    if (a !== s.scoreA || b !== s.scoreB) {
      logComplete = false;
      notes.push(`Game ${s.index} is ${s.scoreA}-${s.scoreB} but the point log has ${a}-${b}`);
    }
  }
  if (events.some((e) => e.segment > segments.length)) {
    logComplete = false;
    notes.push("Point log references a game that has no score");
  }

  const endedAt = m.completedAt ?? null;
  // Use the real rally count even when the log is partial, so the pace check isn't skewed.
  const scoredRallies = segments.reduce((n, s) => n + s.scoreA + s.scoreB, 0);
  const rallies = Math.max(events.length, scoredRallies + events.filter((e) => e.kind === "let").length);
  let timing: TimingQuality = "live";
  if (events.length > 0 && events.every((e) => e.at !== undefined)) {
    timing = "live";
  } else if (endedAt === null || rallies === 0) {
    timing = "untimed";
    notes.push("No end time");
  } else {
    const secPerRally = (endedAt - m.startedAt) / 1000 / rallies;
    if (secPerRally < UNTIMED_BELOW_S) {
      timing = "untimed";
      notes.push(`${secPerRally.toFixed(1)}s per rally: scored after the match, so times can't be used`);
    } else if (secPerRally < SUSPECT_BELOW_S || secPerRally > SUSPECT_ABOVE_S) {
      timing = "suspect";
      notes.push(`${secPerRally.toFixed(1)}s per rally: unusual pace, timing may be off`);
    }
  }

  const winner: Side | null =
    m.winnerId === m.playerAId ? "a" : m.winnerId === m.playerBId ? "b" : null;

  return {
    id: `csl:${m.id}`,
    source: SOURCE_ID,
    sport: "squash",
    format: m.format,
    startedAt: m.startedAt,
    endedAt,
    participants: [
      { id: m.playerAId, name: names.get(m.playerAId) ?? "?", side: "a" },
      { id: m.playerBId, name: names.get(m.playerBId) ?? "?", side: "b" },
    ],
    segments,
    events,
    winner,
    quality: { logComplete, timing, notes },
  };
}
