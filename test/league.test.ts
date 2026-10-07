import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLeagueState, toSessions } from "../src/sources/club-squash-league.ts";
import { leagueSessions } from "./fixtures.ts";

test("imports every completed match from the league export", () => {
  const sessions = leagueSessions();
  assert.equal(sessions.length, 51);
  assert.ok(sessions.every((s) => s.sport === "squash" && s.participants.length === 2));
  assert.ok(sessions.every((s, i) => i === 0 || sessions[i - 1].startedAt <= s.startedAt), "sorted by start");
});

test("flags partial point logs and after-the-fact scoring", () => {
  const sessions = leagueSessions();
  assert.equal(sessions.filter((s) => !s.quality.logComplete).length, 3);
  const untimed = sessions.filter((s) => s.quality.timing === "untimed");
  assert.equal(untimed.length, 1, "Bilal v Usama on 14 Sep: 44 rallies in 2 minutes");
  assert.ok(untimed[0].quality.notes[0].includes("after the match"));
  // Under ~11s per rally (including breaks) is too fast for live scoring of every point.
  const suspect = sessions.filter((s) => s.quality.timing === "suspect");
  assert.deepEqual(
    suspect.map((s) => new Date(s.startedAt).toISOString().slice(0, 10)),
    ["2026-08-27", "2026-09-09", "2026-09-15", "2026-09-15"],
  );
});

test("uses per-point timestamps when the app provides them", () => {
  const t0 = Date.UTC(2026, 9, 1, 14);
  const state = parseLeagueState({
    players: [
      { id: "x", name: "X", createdAt: 0 },
      { id: "y", name: "Y", createdAt: 0 },
    ],
    matchups: [
      {
        id: "m1",
        playerAId: "x",
        playerBId: "y",
        matchIndex: 1,
        format: "bo3",
        status: "completed",
        games: [{ a: 2, b: 0, winner: "a" }],
        pointLog: [
          { gameIndex: 1, side: "a", callType: "point", at: t0 + 20_000 },
          { gameIndex: 1, side: "a", callType: "point", at: t0 + 45_000 },
        ],
        winnerId: "x",
        startedAt: t0,
        completedAt: t0 + 45_000,
      },
    ],
  });
  const [s] = toSessions(state);
  assert.equal(s.events[1].at, t0 + 45_000);
  assert.equal(s.quality.timing, "live");
});
