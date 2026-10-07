import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDataset } from "../src/analysis/dataset.ts";
import { mulberry32 } from "../src/analysis/stats.ts";
import { simulateWearable } from "../src/demo/simulate.ts";
import type { Session } from "../src/model.ts";
import { isGameWon, shuffleGame } from "../src/sports/squash.ts";
import { leagueSessions } from "./fixtures.ts";

const PLAYERS = ["Ahmed", "Usama", "Bilal", "Haider", "Hamad", "Wali"];

test("heart-rate findings don't invent patterns when HR ignores the score", () => {
  // Simulated HR depends only on effort and time, so any "clear" HR-vs-score finding is a false
  // positive. Pressure and leads build late in games, exactly when HR drifts up, so this guards
  // against that confound sneaking back in.
  const sessions = leagueSessions();
  let findings = 0;
  let clear = 0;
  for (const me of PLAYERS) {
    for (let seed = 1; seed <= 5; seed++) {
      const { wearable } = simulateWearable(sessions, me, { seed });
      const ds = buildDataset(sessions, wearable, { me, breakSec: 90, players: [me] });
      for (const h of ds.insights[ds.me!.id].headlines) {
        if (!h.title.startsWith("Heart rate")) continue;
        findings++;
        if (h.evidence === "clear") clear++;
      }
    }
  }
  console.log(`  heart-rate findings: ${clear} of ${findings} called clear on null data`);
  assert.ok(findings >= 20, `only ${findings} findings produced`);
  assert.ok(clear / findings <= 0.1, `${clear}/${findings} false positives`);
});

test("a real heart-rate response to the score does get picked up", () => {
  // Inject +6 bpm whenever the simulated player trails by 2+, then check the finding appears and
  // points the right way: once with rally times estimated (today), once with the per-point
  // timestamps the scoring app could record.
  const sessions = leagueSessions();
  const tally = { estimated: { clear: 0, seen: 0 }, timestamped: { clear: 0, seen: 0 } };
  let runs = 0;
  let wrongWay = 0;
  for (const me of PLAYERS) {
    for (let seed = 1; seed <= 3; seed++) {
      const { wearable, truths } = simulateWearable(sessions, me, { seed, behindBoostBpm: 6 });
      const timesById = new Map(truths.map((t) => [t.sessionId, t.pointTimes]));
      const timestamped = sessions.map((s) => {
        const times = timesById.get(s.id);
        if (!times || !s.quality.logComplete) return s;
        return { ...s, events: s.events.map((e, i) => ({ ...e, at: times[i] })) };
      });
      runs++;
      for (const [mode, data] of [["estimated", sessions], ["timestamped", timestamped]] as const) {
        const ds = buildDataset(data, wearable, { me, breakSec: 90, players: [me] });
        const h = ds.insights[ds.me!.id].headlines.find((x) => x.title === "Heart rate when behind");
        if (!h) continue;
        if (h.evidence === "clear" || h.evidence === "possible") tally[mode].seen++;
        if (h.evidence === "clear") tally[mode].clear++;
        if (h.evidence === "clear" && !h.detail.includes("higher")) wrongWay++;
      }
    }
  }
  const fmt = (t: { clear: number; seen: number }) => `clear in ${t.clear}/${runs}, at least possible in ${t.seen}/${runs}`;
  console.log(`  injected +6 bpm when behind. Estimated timing: ${fmt(tally.estimated)}. Timestamped: ${fmt(tally.timestamped)}`);
  assert.equal(wrongWay, 0, "a detected effect must point the right way");
  // Being behind lasts several rallies, so even evenly spread rally times catch it.
  assert.ok(tally.estimated.clear / runs >= 0.7, "estimated timing should usually find it");
  assert.ok(tally.timestamped.clear / runs >= 0.7, "timestamped data should usually find it");
});

/** A best-of-3 where Alice wins each rally with probability p, independently: no clutch, no momentum. */
function randomMatch(id: string, start: number, opponent: string, p: number, rand: () => number): Session {
  const events: Session["events"] = [];
  const segments: Session["segments"] = [];
  let games = [0, 0];
  for (let g = 1; games[0] < 2 && games[1] < 2; g++) {
    let [a, b] = [0, 0];
    while (!isGameWon(a, b) && !isGameWon(b, a)) {
      const side = rand() < p ? "a" : "b";
      if (side === "a") a++;
      else b++;
      events.push({ seq: events.length, segment: g, kind: "point", wonBy: side });
    }
    segments.push({ index: g, scoreA: a, scoreB: b, winner: a > b ? "a" : "b" });
    games = a > b ? [games[0] + 1, games[1]] : [games[0], games[1] + 1];
  }
  return {
    id,
    source: "test",
    sport: "squash",
    format: "bo3",
    startedAt: start,
    endedAt: start + 20 * 60_000,
    participants: [
      { id: "alice", name: "Alice", side: "a" },
      { id: opponent, name: opponent, side: "b" },
    ],
    segments,
    events,
    winner: games[0] > games[1] ? "a" : "b",
    quality: { logComplete: true, timing: "live", notes: [] },
  };
}

test("score findings stay quiet when rallies are pure chance", () => {
  // Opponents of very different strength are exactly what fools a naive analysis: against the
  // strong one you're often behind AND lose more rallies, which looks like "folding when behind".
  const opponents: [string, number][] = [
    ["Strong", 0.35],
    ["Even", 0.5],
    ["Weak", 0.65],
  ];
  let findings = 0;
  let clear = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const rand = mulberry32(seed);
    const sessions: Session[] = [];
    for (let i = 0; i < 24; i++) {
      const [name, p] = opponents[i % 3];
      sessions.push(randomMatch(`m${seed}-${i}`, Date.UTC(2026, 7, 1) + i * 86_400_000, name, p, rand));
    }
    for (const h of buildDataset(sessions, null, { breakSec: 90 }).insights.alice.headlines) {
      if (h.evidence === null) continue;
      findings++;
      if (h.evidence === "clear") clear++;
    }
  }
  console.log(`  score findings on pure-chance matches: ${clear} of ${findings} called clear`);
  assert.ok(findings >= 30);
  assert.ok(clear / findings <= 0.1, `${clear}/${findings} false positives`);
});

test("reshuffled games are legal squash and keep their score", () => {
  const rand = mulberry32(3);
  for (const [a, b] of [[11, 4], [9, 11], [12, 10], [14, 16], [11, 0]] as const) {
    const outcomes = [...Array(a).fill("a"), ...Array(b).fill("b")] as ("a" | "b")[];
    for (let k = 0; k < 50; k++) {
      const order = shuffleGame(outcomes, rand);
      let [x, y] = [0, 0];
      order.forEach((o, i) => {
        if (o === "a") x++;
        else y++;
        const over = isGameWon(x, y) || isGameWon(y, x);
        assert.equal(over, i === order.length - 1, `${a}-${b}: game over early at ${x}-${y}`);
      });
      assert.deepEqual([x, y], [a, b]);
    }
  }
});

test("'your usual' for whole-game situations comes from other matches vs the same opponent", () => {
  const rand = mulberry32(5);
  const t = Date.UTC(2026, 8, 1);
  // Alice always beats Bob, always loses to Cara. Game 1 against each is judged against her other
  // matches with the same opponent, so expected tracks the opponent: ~100% vs Bob, ~0% vs Cara.
  const sessions = [
    randomMatch("b1", t, "Bob", 1, rand),
    randomMatch("b2", t + 1, "Bob", 1, rand),
    randomMatch("c1", t + 2, "Cara", 0, rand),
    randomMatch("c2", t + 3, "Cara", 0, rand),
  ];
  const g1 = buildDataset(sessions, null, { breakSec: 90 }).insights.alice.byGame.find((b) => b.key === "g1")!;
  assert.equal(g1.baseline, "opponents");
  assert.equal(g1.pct, 0.5);
  assert.equal(g1.exp, 0.5);
  assert.equal(g1.z, 0, "matches the opponent mix exactly, so no finding");
});
