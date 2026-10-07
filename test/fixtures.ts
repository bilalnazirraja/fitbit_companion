import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Session } from "../src/model.ts";
import { parseLeagueState, toSessions } from "../src/sources/club-squash-league.ts";

/** The Redis export of the real league (scores.txt in the project root). */
export function leagueSessions(): Session[] {
  const raw = readFileSync(resolve(import.meta.dirname, "..", "scores.txt"), "utf8");
  return toSessions(parseLeagueState(JSON.parse(raw)));
}

/** A hand-built best-of-3 match: A wins 11-9, B wins 11-5, A wins 12-10. */
export function syntheticMatch(start = Date.UTC(2026, 7, 20, 14, 0, 0), minutes = 30): Session {
  const games: [number, number][] = [
    [11, 9],
    [5, 11],
    [12, 10],
  ];
  const events: Session["events"] = [];
  games.forEach(([a, b], g) => {
    // Alternate points (game winner serves first) until the loser runs out; the winner then
    // takes the remaining points, so the game ends exactly on its final score.
    let ra = a;
    let rb = b;
    let turnA = a > b;
    while (ra + rb > 0) {
      const side = (turnA && ra > 0) || rb === 0 ? "a" : "b";
      if (side === "a") ra--;
      else rb--;
      events.push({ seq: events.length, segment: g + 1, kind: "point", wonBy: side });
      turnA = !turnA;
    }
  });
  return {
    id: "test:1",
    source: "test",
    sport: "squash",
    format: "bo3",
    startedAt: start,
    endedAt: start + minutes * 60_000,
    participants: [
      { id: "pa", name: "Alice", side: "a" },
      { id: "pb", name: "Bob", side: "b" },
    ],
    segments: games.map(([a, b], i) => ({ index: i + 1, scoreA: a, scoreB: b, winner: a > b ? "a" : "b" })),
    events,
    winner: "a",
    quality: { logComplete: true, timing: "live", notes: [] },
  };
}
