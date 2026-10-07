// Squash rules (PAR scoring to 11, win by 2) and per-rally game situation.
import type { Session, Side } from "../model.ts";

export const POINTS_TO_WIN = 11;

export function gamesToWin(format: string): number {
  const m = /^bo(\d+)$/i.exec(format);
  return m ? Math.ceil(Number(m[1]) / 2) : 2;
}

export function isGameWon(my: number, opp: number): boolean {
  return my >= POINTS_TO_WIN && my - opp >= 2;
}

const gameMemo = new Map<string, number>();

/** P(win the game) from in-game score my-opp, if each rally is won with probability p. */
export function gameWinProb(my: number, opp: number, p = 0.5): number {
  if (isGameWon(my, opp)) return 1;
  if (isGameWon(opp, my)) return 0;
  const q = 1 - p;
  if (my >= POINTS_TO_WIN - 1 && opp >= POINTS_TO_WIN - 1) {
    const deuce = (p * p) / (p * p + q * q);
    if (my === opp) return deuce;
    return my > opp ? p + q * deuce : p * deuce;
  }
  const key = `${my},${opp},${p}`;
  let v = gameMemo.get(key);
  if (v === undefined) {
    v = p * gameWinProb(my + 1, opp, p) + q * gameWinProb(my, opp + 1, p);
    gameMemo.set(key, v);
  }
  return v;
}

const matchMemo = new Map<string, number>();

/** P(win the match) from games won so far plus the current in-game score. */
export function matchWinProb(gMy: number, gOpp: number, my: number, opp: number, need: number, p = 0.5): number {
  if (gMy >= need) return 1;
  if (gOpp >= need) return 0;
  const key = `${gMy},${gOpp},${my},${opp},${need},${p}`;
  let v = matchMemo.get(key);
  if (v === undefined) {
    const pg = gameWinProb(my, opp, p);
    v = pg * matchWinProb(gMy + 1, gOpp, 0, 0, need, p) + (1 - pg) * matchWinProb(gMy, gOpp + 1, 0, 0, need, p);
    matchMemo.set(key, v);
  }
  return v;
}

function stateAfter(gMy: number, gOpp: number, my: number, opp: number, iWin: boolean): [number, number, number, number] {
  const nMy = iWin ? my + 1 : my;
  const nOpp = iWin ? opp : opp + 1;
  if (isGameWon(nMy, nOpp)) return [gMy + 1, gOpp, 0, 0];
  if (isGameWon(nOpp, nMy)) return [gMy, gOpp + 1, 0, 0];
  return [gMy, gOpp, nMy, nOpp];
}

/**
 * How much this rally matters: P(win match | win rally) − P(win match | lose rally).
 * It's symmetric between the two players at p = 0.5. Peaks on deciding-game points like 10-9 or 10-10.
 */
export function rallyImportance(gMy: number, gOpp: number, my: number, opp: number, need: number, p = 0.5): number {
  const w = stateAfter(gMy, gOpp, my, opp, true);
  const l = stateAfter(gMy, gOpp, my, opp, false);
  return matchWinProb(w[0], w[1], w[2], w[3], need, p) - matchWinProb(l[0], l[1], l[2], l[3], need, p);
}

const pressureMemo = new Map<number, number>();

/** rallyImportance scaled to 0..1 for the format, cached (it's called for every shuffled rally). */
export function pressureOf(gMy: number, gOpp: number, my: number, opp: number, need: number): number {
  let m = my;
  let o = opp;
  if (my >= POINTS_TO_WIN - 1 && opp >= POINTS_TO_WIN - 1) {
    // Past 10-10 only the difference matters: 13-12 plays like 11-10.
    m = POINTS_TO_WIN - 1 + Math.max(0, my - opp);
    o = POINTS_TO_WIN - 1 + Math.max(0, opp - my);
  }
  const key = (((need * 8 + gMy) * 8 + gOpp) * 32 + m) * 32 + o;
  let v = pressureMemo.get(key);
  if (v === undefined) {
    v = rallyImportance(gMy, gOpp, my, opp, need) / maxImportance(need);
    pressureMemo.set(key, v);
  }
  return v;
}

const maxImportanceMemo = new Map<number, number>();

/** Largest importance any rally can have in this format; used to scale importance to 0..1. */
export function maxImportance(need: number): number {
  let max = maxImportanceMemo.get(need);
  if (max !== undefined) return max;
  max = 0;
  for (let gMy = 0; gMy < need; gMy++)
    for (let gOpp = 0; gOpp < need; gOpp++)
      for (let my = 0; my <= POINTS_TO_WIN + 1; my++)
        for (let opp = 0; opp <= POINTS_TO_WIN + 1; opp++) {
          if (isGameWon(my, opp) || isGameWon(opp, my)) continue;
          max = Math.max(max, rallyImportance(gMy, gOpp, my, opp, need));
        }
  maxImportanceMemo.set(need, max);
  return max;
}

/**
 * A random order of one game's rallies that ends on the same score and could really have
 * happened: nobody reaches 11 early, and past 10-10 the points trade until someone goes two
 * clear. `outcomes` is the winner side of each decided rally, in play order.
 */
export function shuffleGame<T extends Side>(outcomes: T[], rand: () => number): T[] {
  const a = outcomes.filter((o) => o === "a").length;
  const b = outcomes.length - a;
  const [winner, loser] = (a > b ? ["a", "b"] : ["b", "a"]) as [T, T];
  const w = Math.max(a, b);
  const l = Math.min(a, b);
  const shuffle = (xs: T[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  };
  const fill = (wins: number, losses: number) => [...Array(wins).fill(winner), ...Array(losses).fill(loser)] as T[];
  if (!isGameWon(w, l)) return shuffle([...outcomes]); // not a finished game: no scoring rule to respect
  if (l <= POINTS_TO_WIN - 2) return [...shuffle(fill(w - 1, l)), winner];
  const deuce = POINTS_TO_WIN - 1;
  const pairs = Array.from({ length: l - deuce }, () => (rand() < 0.5 ? [winner, loser] : [loser, winner])).flat() as T[];
  return [...shuffle(fill(deuce, deuce)), ...pairs, winner, winner];
}

export type GamePhase = "early" | "middle" | "late";

/** One rally seen from one player's side of the court. Scores are before the rally is played. */
export interface RallyContext {
  seq: number;
  game: number;
  rallyInGame: number;
  my: number;
  opp: number;
  diff: number;
  gamesMy: number;
  gamesOpp: number;
  kind: "point" | "stroke" | "let";
  /** null for lets */
  won: boolean | null;
  gameBallFor: boolean;
  gameBallAgainst: boolean;
  matchBallFor: boolean;
  matchBallAgainst: boolean;
  /** Both players on 10 or more. */
  tiebreak: boolean;
  /** Games are level and the next game decides the match. */
  deciding: boolean;
  phase: GamePhase;
  /** 0..1, where 1 is the most important rally possible in this format. */
  pressure: number;
  /** Rallies won (+) or lost (−) in a row before this one, across the match. Lets don't count. */
  streak: number;
}

export function phaseOf(my: number, opp: number): GamePhase {
  const lead = Math.max(my, opp);
  return lead <= 4 ? "early" : lead <= 7 ? "middle" : "late";
}

export function rallyContexts(session: Session, side: Side): RallyContext[] {
  const need = gamesToWin(session.format);
  const out: RallyContext[] = [];
  let game = 0;
  let my = 0;
  let opp = 0;
  let gamesMy = 0;
  let gamesOpp = 0;
  let rallyInGame = 0;
  let streak = 0;

  for (const e of session.events) {
    if (e.segment !== game) {
      // Count games won from the official game results, so a partial log can't drift.
      gamesMy = session.segments.filter((s) => s.index < e.segment && s.winner === side).length;
      gamesOpp = session.segments.filter((s) => s.index < e.segment && s.winner !== null && s.winner !== side).length;
      game = e.segment;
      my = 0;
      opp = 0;
      rallyInGame = 0;
    }
    const gameBallFor = isGameWon(my + 1, opp);
    const gameBallAgainst = isGameWon(opp + 1, my);
    const won = e.wonBy === null ? null : e.wonBy === side;
    out.push({
      seq: e.seq,
      game,
      rallyInGame,
      my,
      opp,
      diff: my - opp,
      gamesMy,
      gamesOpp,
      kind: e.kind,
      won,
      gameBallFor,
      gameBallAgainst,
      matchBallFor: gameBallFor && gamesMy === need - 1,
      matchBallAgainst: gameBallAgainst && gamesOpp === need - 1,
      tiebreak: my >= POINTS_TO_WIN - 1 && opp >= POINTS_TO_WIN - 1,
      deciding: gamesMy === need - 1 && gamesOpp === need - 1,
      phase: phaseOf(my, opp),
      pressure: pressureOf(gamesMy, gamesOpp, my, opp, need),
      streak,
    });
    rallyInGame++;
    if (won === true) {
      my++;
      streak = streak > 0 ? streak + 1 : 1;
    } else if (won === false) {
      opp++;
      streak = streak < 0 ? streak - 1 : -1;
    }
  }
  return out;
}
