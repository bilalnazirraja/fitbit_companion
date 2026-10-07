// Matches you log in the app yourself (squash, padel or golf) with the final score. They join the
// analysis as Sessions, next to the squash league matches imported earlier.
import { randomBytes } from "node:crypto";
import type { Participant, Recording, Session, Side, StrokeScore } from "../model.ts";

export const SPORTS = ["squash", "padel", "golf"] as const;
export type Sport = (typeof SPORTS)[number];
export const JOURNAL_SOURCE = "journal";

export interface LivePoint {
  g: number;
  w: Side;
  at: number;
}

export interface JournalEntry {
  id: string;
  sport: Sport;
  startedAt: number;
  endedAt: number;
  /** Your clock's offset from UTC when you played, so the match lands on the right local date. */
  utcOffsetMinutes: number;
  /** Squash: your opponent. Padel: the opponents. Golf: who you played with, if anyone. */
  opponents: string[];
  /** Padel partner. */
  partner: string | null;
  /** Squash games or padel sets, your score first. Empty for golf. */
  scores: [number, number][];
  golf: StrokeScore | null;
  /** Squash scored live, point by point: game, who won it ("a" = you), and when. */
  points?: LivePoint[];
  /** The watch workout the times came from, if you picked one. */
  workoutId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Something wrong with what was entered. The message is shown to the user as it is. */
export class InputError extends Error {}

const MIN = 60_000;
const NAME_MAX = 40;

const RULES: Record<Sport, { opponents: [number, number]; rows: string }> = {
  squash: { opponents: [1, 1], rows: "Game" },
  padel: { opponents: [1, 2], rows: "Set" },
  golf: { opponents: [0, 3], rows: "Hole" },
};

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
}

function int(value: unknown, lo: number, hi: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : NaN;
}

/** Checks and normalises a match sent from the log form. `existing` is the entry being edited. */
export function parseEntry(body: unknown, now: number, existing?: JournalEntry): JournalEntry {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sport = b.sport as Sport;
  if (!SPORTS.includes(sport)) throw new InputError("Pick a sport.");

  const startedAt = Number(b.startedAt);
  const endedAt = Number(b.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) throw new InputError("Enter when you played.");
  if (endedAt - startedAt < 5 * MIN) throw new InputError("The match should last at least 5 minutes. Check the start time and length.");
  if (endedAt - startedAt > 8 * 60 * MIN) throw new InputError("That's more than 8 hours. Check the start time and length.");
  if (startedAt > now + 60 * MIN) throw new InputError("That start time is in the future.");
  if (startedAt < Date.UTC(2015, 0, 1)) throw new InputError("Check the date.");
  const offset = Number(b.utcOffsetMinutes ?? 0);
  const utcOffsetMinutes = Number.isFinite(offset) && Math.abs(offset) <= 14 * 60 ? Math.round(offset) : 0;

  const rules = RULES[sport];
  const opponents = (Array.isArray(b.opponents) ? b.opponents : []).map(cleanName).filter(Boolean);
  const [minOpp, maxOpp] = rules.opponents;
  if (opponents.length < minOpp) throw new InputError(sport === "squash" ? "Who did you play?" : "Who did you play against?");
  if (opponents.length > maxOpp) throw new InputError(`At most ${maxOpp} ${maxOpp === 1 ? "opponent" : "players"} for ${sport}.`);
  const partner = sport === "padel" ? cleanName(b.partner) || null : null;

  let scores: [number, number][] = [];
  let golf: StrokeScore | null = null;
  let points: LivePoint[] | undefined;
  if (sport === "golf") {
    golf = parseGolf(b.golf);
  } else if (sport === "squash" && Array.isArray(b.points) && b.points.length > 0) {
    // Live scoring: the game scores follow from the points.
    points = parsePoints(b.points);
    scores = [];
    for (const p of points) {
      while (scores.length < p.g) scores.push([0, 0]);
      scores[p.g - 1][p.w === "a" ? 0 : 1]++;
    }
    scores = scores.filter(([x, y]) => x !== y);
    if (scores.length === 0) throw new InputError("Finish at least one game before saving.");
  } else {
    const rows = Array.isArray(b.scores) ? b.scores : [];
    for (const [i, row] of rows.entries()) {
      const pair = Array.isArray(row) ? row : [];
      const mine = int(pair[0], 0, 99);
      const theirs = int(pair[1], 0, 99);
      if (mine === null && theirs === null) continue;
      const label = `${rules.rows} ${i + 1}`;
      if (mine === null || theirs === null || Number.isNaN(mine) || Number.isNaN(theirs)) {
        throw new InputError(`${label}: enter both scores (whole numbers).`);
      }
      if (mine === theirs) throw new InputError(`${label} can't be a draw.`);
      scores.push([mine, theirs]);
    }
    if (scores.length === 0) throw new InputError(`Enter the score of at least one ${rules.rows.toLowerCase()}.`);
    if (scores.length > 5) throw new InputError(`At most 5 ${rules.rows.toLowerCase()}s.`);
  }

  const workoutId = typeof b.workoutId === "string" && b.workoutId.length <= 200 ? b.workoutId : null;
  return {
    id: existing?.id ?? `j_${randomBytes(6).toString("hex")}`,
    sport,
    startedAt: Math.round(startedAt),
    endedAt: Math.round(endedAt),
    utcOffsetMinutes,
    opponents,
    partner,
    scores,
    golf,
    ...(points ? { points } : {}),
    workoutId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function parsePoints(list: unknown[]): LivePoint[] {
  if (list.length > 600) throw new InputError("That's more points than a match can have.");
  let last = 0;
  return list.map((raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const g = Number(p.g);
    const at = Number(p.at);
    if (!Number.isInteger(g) || g < 1 || g > 5 || (p.w !== "a" && p.w !== "b") || !Number.isFinite(at) || at < last) {
      throw new InputError("The live score couldn't be read. Try finishing the match again.");
    }
    last = at;
    return { g, w: p.w, at: Math.round(at) };
  });
}

function parseGolf(value: unknown): StrokeScore {
  const g = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const holes = Number(g.holes) === 9 ? 9 : 18;
  let perHole: (number | null)[] | null = null;
  const cells = Array.isArray(g.perHole) ? (g.perHole as unknown[]) : [];
  if (cells.some((v) => v !== null && v !== "")) {
    perHole = Array.from({ length: holes }, (_, i) => {
      const v = int(cells[i], 1, 20);
      if (Number.isNaN(v)) throw new InputError(`Hole ${i + 1}: enter strokes as a whole number from 1 to 20.`);
      return v;
    });
  }
  const filled = perHole?.filter((v): v is number => v !== null) ?? [];
  let strokes = int(g.strokes, holes, 300);
  if (perHole && filled.length === holes) strokes = filled.reduce((a, v) => a + v, 0);
  if (strokes === null || Number.isNaN(strokes)) throw new InputError("Enter your total strokes.");
  const par = int(g.par, holes * 2, holes * 6);
  if (par !== null && Number.isNaN(par)) throw new InputError("Check the course par.");
  return {
    course: cleanName(g.course) || null,
    holes,
    strokes,
    par: par ?? (holes === 9 ? 36 : 72),
    perHole,
  };
}

const personId = (name: string) => `n:${name.toLowerCase()}`;

/**
 * The entry as a Session. When a watch workout covers the match, its start and stop replace the
 * typed times: the watch knows exactly when you played.
 */
export function entryToSession(e: JournalEntry, me: { id: string; name: string }, recordings: Recording[] = []): Session {
  const { start, end } = matchWindow(e, recordings);
  const participants: Participant[] = [{ id: me.id, name: me.name, side: "a" }];
  if (e.partner) participants.push({ id: personId(e.partner), name: e.partner, side: "a" });
  for (const o of e.opponents) participants.push({ id: personId(o), name: o, side: "b" });

  const segments = e.scores.map(([a, b], i) => ({ index: i + 1, scoreA: a, scoreB: b, winner: (a > b ? "a" : "b") as Side }));
  const won = segments.filter((s) => s.winner === "a").length;
  const lost = segments.length - won;
  const need = Math.max(won, lost);
  return {
    id: e.id,
    source: JOURNAL_SOURCE,
    sport: e.sport,
    format: e.sport === "golf" ? `${e.golf?.holes ?? 18} holes` : `bo${Math.max(1, need * 2 - 1)}`,
    startedAt: start,
    endedAt: end,
    participants,
    segments,
    events: (e.points ?? []).map((p, seq) => ({ seq, segment: p.g, kind: "point" as const, wonBy: p.w, at: p.at })),
    winner: e.sport === "golf" || won === lost ? null : won > lost ? "a" : "b",
    // Live-scored points reproduce the game scores, so the rally analysis can use them.
    quality: { logComplete: Boolean(e.points?.length), timing: "live", notes: [] },
    ...(e.golf ? { strokes: e.golf } : {}),
    utcOffsetMinutes: e.utcOffsetMinutes,
  };
}

/** The workout picked in the form, or one that clearly is this match; otherwise the typed times. */
export function matchWindow(e: JournalEntry, recordings: Recording[]): { start: number; end: number } {
  const picked = e.workoutId ? recordings.find((r) => r.id === e.workoutId) : undefined;
  if (picked) return { start: picked.start, end: picked.end };
  const typed = e.endedAt - e.startedAt;
  const best = recordings
    .map((r) => ({ r, overlap: Math.min(r.end, e.endedAt) - Math.max(r.start, e.startedAt) }))
    // Most of the match, and not a long workout that also covers other matches.
    .filter(({ r, overlap }) => overlap >= 0.5 * typed && r.end - r.start <= 1.5 * typed + 10 * MIN)
    .sort((a, b) => b.overlap - a.overlap)[0];
  return best ? { start: best.r.start, end: best.r.end } : { start: e.startedAt, end: e.endedAt };
}

export interface Note {
  text: string;
  /** How hard it felt, 1 (very easy) to 10 (all-out). */
  rpe: number | null;
  updatedAt: number;
}

export function parseNote(body: unknown, now: number): Note {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = typeof b.text === "string" ? b.text.trim().slice(0, 2000) : "";
  const rpe = int(b.rpe, 1, 10);
  if (Number.isNaN(rpe)) throw new InputError("Effort should be a whole number from 1 to 10.");
  return { text, rpe, updatedAt: now };
}
