import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "../src/analysis/stats.ts";
import { simulateSession, simulateWearable } from "../src/demo/simulate.ts";
import type { Recording } from "../src/model.ts";
import { alignSession } from "../src/sync/align.ts";
import { leagueSessions, syntheticMatch } from "./fixtures.ts";

const opts = { breakSec: 90 };

test("finds between-game rests from the heart-rate dip", () => {
  const match = syntheticMatch();
  const sim = simulateSession(match, mulberry32(1))!;
  const a = alignSession(match, [sim.recording], sim.samples, opts)!;
  assert.equal(a.basis, "heart-rate");
  assert.equal(a.breaks.length, 2);
  a.breaks.forEach((b, k) => {
    const err = Math.abs(b.start - sim.truth.breaks[k].start) / 1000;
    assert.ok(err < 30, `break ${k + 1} off by ${err.toFixed(0)}s`);
    assert.ok(b.drop60 !== null && b.drop60 > 15, `recovery measured: ${b.drop60}`);
  });
  assert.equal(a.rallies.length, match.events.length);
  assert.ok(a.rallies.every((r) => r.hrMean !== null));
  assert.ok(a.hr && a.hr.coverage > 0.9);
});

test("break detection across the real league's match structures", () => {
  const sessions = leagueSessions();
  const errors: number[] = [];
  let located = 0;
  let total = 0;
  for (const name of ["Bilal", "Usama", "Ahmed"]) {
    const { wearable, truths } = simulateWearable(sessions, name, { seed: name.length });
    for (const truth of truths) {
      const s = sessions.find((x) => x.id === truth.sessionId)!;
      if (!s.quality.logComplete || s.quality.timing !== "live") continue;
      const a = alignSession(s, wearable.recordings, wearable.heartRate, opts)!;
      a.breaks.forEach((b, k) => {
        total++;
        if (!b.located) return;
        located++;
        errors.push(Math.abs(b.start - truth.breaks[k].start) / 1000);
      });
    }
  }
  errors.sort((x, y) => x - y);
  const median = errors[Math.floor(errors.length / 2)];
  const within30 = errors.filter((e) => e <= 30).length / errors.length;
  console.log(`  breaks located ${located}/${total}, median error ${median.toFixed(0)}s, within 30s: ${(within30 * 100).toFixed(0)}%`);
  assert.ok(located / total > 0.85, `located ${located}/${total}`);
  assert.ok(median < 20, `median error ${median}s`);
  assert.ok(within30 > 0.8, `within 30s: ${within30}`);
});

test("falls back to even spacing without heart rate", () => {
  const match = syntheticMatch();
  const rec: Recording = {
    id: "r",
    provider: "test",
    type: "SQUASH",
    name: "Squash",
    start: match.startedAt - 120_000,
    end: match.endedAt! + 60_000,
    utcOffsetMinutes: 0,
    events: [],
    summary: {},
  };
  const a = alignSession(match, [rec], [], opts)!;
  assert.equal(a.basis, "proportional");
  assert.equal(a.hr, null);
  assert.equal(a.games.length, 3);
  assert.equal(a.breaks[0].end - a.breaks[0].start, 90_000);
  assert.equal(a.games[0].start, match.startedAt);
  assert.equal(a.games[2].end, match.endedAt);
});

test("uses watch pauses between games when present", () => {
  const match = syntheticMatch();
  const t = match.startedAt;
  const rec: Recording = {
    id: "r",
    provider: "test",
    type: "SQUASH",
    name: "Squash",
    start: t - 60_000,
    end: match.endedAt!,
    utcOffsetMinutes: 0,
    events: [
      { t: t + 9 * 60_000, type: "PAUSE" },
      { t: t + 10.5 * 60_000, type: "RESUME" },
      { t: t + 17 * 60_000, type: "PAUSE" },
      { t: t + 18.5 * 60_000, type: "RESUME" },
    ],
    summary: {},
  };
  const a = alignSession(match, [rec], [], opts)!;
  assert.equal(a.basis, "watch-pauses");
  assert.deepEqual(
    a.breaks.map((b) => (b.start - t) / 60_000),
    [9, 17],
  );
});

test("exact timing when points carry timestamps", () => {
  const match = syntheticMatch();
  match.events.forEach((e, i) => (e.at = match.startedAt + (i + 1) * 25_000 + (e.segment - 1) * 90_000));
  const a = alignSession(match, [], [], opts)!;
  assert.equal(a.basis, "measured");
  assert.equal(a.rallies[3].end, match.events[3].at);
  assert.equal(a.rallies[3].start, match.events[2].at);
  assert.equal(a.breaks.length, 2);
});
