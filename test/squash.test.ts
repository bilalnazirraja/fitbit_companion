import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gameWinProb,
  isGameWon,
  matchWinProb,
  maxImportance,
  rallyContexts,
  rallyImportance,
} from "../src/sports/squash.ts";
import { leagueSessions, syntheticMatch } from "./fixtures.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("game ends at 11 with a two-point lead", () => {
  assert.equal(isGameWon(11, 9), true);
  assert.equal(isGameWon(11, 10), false);
  assert.equal(isGameWon(14, 12), true);
});

test("win probabilities for evenly matched players", () => {
  close(gameWinProb(0, 0), 0.5);
  close(gameWinProb(10, 10), 0.5);
  close(gameWinProb(11, 10), 0.75);
  close(gameWinProb(10, 11), 0.25);
  close(matchWinProb(0, 0, 0, 0, 2), 0.5);
  close(matchWinProb(1, 0, 0, 0, 2), 0.75);
});

test("rally importance is symmetric and peaks on deciding-game points", () => {
  close(rallyImportance(1, 0, 7, 4, 2), rallyImportance(0, 1, 4, 7, 2));
  close(maxImportance(2), 0.5);
  close(rallyImportance(1, 1, 10, 9, 2), 0.5);
  assert.ok(rallyImportance(0, 0, 0, 0, 2) < 0.15, "first rally of the match matters little");
});

test("rally contexts rebuild the score and flag game balls", () => {
  const m = syntheticMatch();
  const ctx = rallyContexts(m, "a");
  assert.equal(ctx.length, m.events.length);
  const lastOfGame1 = ctx.filter((c) => c.game === 1).at(-1)!;
  assert.deepEqual([lastOfGame1.my, lastOfGame1.opp], [10, 9]);
  assert.equal(lastOfGame1.gameBallFor, true);
  const game3 = ctx.filter((c) => c.game === 3);
  assert.equal(game3[0].deciding, true);
  assert.deepEqual([game3[0].gamesMy, game3[0].gamesOpp], [1, 1]);
  assert.ok(game3.some((c) => c.tiebreak));
  // From B's side everything mirrors.
  const b = rallyContexts(m, "b");
  assert.equal(b[5].diff, -ctx[5].diff);
  close(b[5].pressure, ctx[5].pressure);
});

test("every complete league log replays to its official game scores", () => {
  for (const s of leagueSessions().filter((x) => x.quality.logComplete)) {
    const ctx = rallyContexts(s, "a");
    for (const seg of s.segments) {
      const inGame = ctx.filter((c) => c.game === seg.index && c.won !== null);
      const last = inGame.at(-1)!;
      const final = last.won ? [last.my + 1, last.opp] : [last.my, last.opp + 1];
      assert.deepEqual(final, [seg.scoreA, seg.scoreB], `${s.id} game ${seg.index}`);
    }
  }
});
