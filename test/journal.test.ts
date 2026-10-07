import assert from "node:assert/strict";
import { test } from "node:test";
import { hrStats, matchView, stepsIn, summarize } from "../src/analysis/matches.ts";
import { costUsd, modelInfo } from "../src/ai/openai.ts";
import { matchPrompt, overviewPrompt } from "../src/ai/prompts.ts";
import { entryToSession, InputError, matchWindow, parseEntry, parseNote, type JournalEntry } from "../src/journal/entries.ts";
import type { HrSample, Recording } from "../src/model.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 7, 12, 0);
const T = Date.UTC(2026, 9, 6, 13, 0);
const me = { id: "me", name: "Bilal" };

const squash = (extra: Record<string, unknown> = {}) =>
  parseEntry({ sport: "squash", startedAt: T, endedAt: T + 40 * MIN, opponents: ["Usama"], scores: [[11, 7], [9, 11], [11, 8], [11, 6]], ...extra }, NOW);

const recording = (id: string, start: number, end: number): Recording => ({
  id,
  provider: "test",
  type: "SQUASH",
  name: "Squash",
  start,
  end,
  utcOffsetMinutes: 300,
  events: [],
  summary: { calories: 400 },
});

test("a logged match is checked before it's saved", () => {
  const bad = (body: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => parseEntry({ sport: "squash", startedAt: T, endedAt: T + 40 * MIN, opponents: ["Usama"], scores: [[11, 7]], ...body }, NOW), (e: Error) => e instanceof InputError && pattern.test(e.message));
  bad({ sport: "tennis" }, /sport/);
  bad({ opponents: [] }, /Who did you play/);
  bad({ scores: [[11, 11]] }, /can't be a draw/);
  bad({ scores: [[11, ""]] }, /both scores/);
  bad({ scores: [] }, /at least one game/);
  bad({ endedAt: T + 2 * MIN }, /at least 5 minutes/);
  bad({ startedAt: NOW + 3 * 3600_000, endedAt: NOW + 4 * 3600_000 }, /future/);

  const e = squash({ scores: [[11, 7], ["", ""], [9, 11]], opponents: ["  Usama   Khan "] });
  assert.deepEqual(e.scores, [[11, 7], [9, 11]], "empty rows are dropped");
  assert.deepEqual(e.opponents, ["Usama Khan"]);
  assert.match(e.id, /^j_[0-9a-f]{12}$/);

  const edited = parseEntry({ ...e, scores: [[11, 2]] }, NOW + 1000, e);
  assert.equal(edited.id, e.id, "editing keeps the id");
  assert.equal(edited.createdAt, e.createdAt);
});

test("golf adds up hole by hole and defaults the par", () => {
  const base = { sport: "golf", startedAt: T, endedAt: T + 240 * MIN };
  const total = parseEntry({ ...base, golf: { holes: 18, strokes: 88 } }, NOW);
  assert.deepEqual(total.golf, { course: null, holes: 18, strokes: 88, par: 72, perHole: null });
  const holes = parseEntry({ ...base, golf: { holes: 9, perHole: [4, 5, 3, 6, 4, 4, 5, 3, 5] } }, NOW);
  assert.equal(holes.golf!.strokes, 39);
  assert.equal(holes.golf!.par, 36);
  assert.throws(() => parseEntry({ ...base, golf: { holes: 9, perHole: [4, 5] } }, NOW), /total strokes/);
  assert.throws(() => parseEntry({ ...base, golf: { holes: 9, strokes: 40, perHole: [4, 50] } }, NOW), /Hole 2/);
});

test("a logged match becomes a session from your side", () => {
  const s = entryToSession(squash(), me);
  assert.equal(s.source, "journal");
  assert.equal(s.winner, "a");
  assert.equal(s.format, "bo5");
  assert.deepEqual(
    s.participants.map((p) => [p.name, p.side]),
    [
      ["Bilal", "a"],
      ["Usama", "b"],
    ],
  );
  const padel = entryToSession(
    parseEntry({ sport: "padel", startedAt: T, endedAt: T + 80 * MIN, partner: "Ali", opponents: ["Hamza", "Saad"], scores: [[3, 6], [4, 6]] }, NOW),
    me,
  );
  assert.equal(padel.winner, "b");
  assert.deepEqual(
    padel.participants.map((p) => p.side),
    ["a", "a", "b", "b"],
  );
});

test("the watch workout's times replace typed times only when it's clearly this match", () => {
  const e: JournalEntry = squash();
  const close = recording("close", T + 3 * MIN, T + 44 * MIN);
  assert.deepEqual(matchWindow(e, [close]), { start: close.start, end: close.end });
  const allEvening = recording("long", T - 30 * MIN, T + 150 * MIN);
  assert.deepEqual(matchWindow(e, [allEvening]), { start: T, end: T + 40 * MIN }, "a long workout covering several matches isn't used");
  assert.deepEqual(matchWindow({ ...e, workoutId: "long" }, [allEvening]), { start: allEvening.start, end: allEvening.end }, "unless you picked it");
  assert.deepEqual(matchWindow(e, [recording("other", T + 60 * MIN, T + 100 * MIN)]), { start: T, end: T + 40 * MIN });
});

test("heart-rate zones, load and effort", () => {
  // 10 minutes at 150 bpm then 10 at 180, with max HR 200: zone 3 (70-80%) then zone 5 (90%+).
  const hr: HrSample[] = [];
  for (let t = T; t < T + 20 * MIN; t += 1000) hr.push({ t, bpm: t < T + 10 * MIN ? 150 : 180 });
  const st = hrStats(hr, T, T + 20 * MIN, 200, 60)!;
  assert.deepEqual(
    st.zones.map((s) => Math.round(s / 60)),
    [0, 0, 10, 0, 10],
  );
  assert.equal(st.load, 10 * 3 + 10 * 5);
  assert.equal(st.extraBeats, 10 * 90 + 10 * 120);
  assert.equal(st.avg, 165);

  // Half the readings missing: totals are scaled up to the whole match.
  const patchy = hr.filter((s) => Math.floor((s.t - T) / 60_000) % 2 === 0);
  const est = hrStats(patchy, T, T + 20 * MIN, 200, 60)!;
  assert.ok(Math.abs(est.load! - 80) <= 6, `load ${est.load}`);
});

test("steps are spread over their interval and clipped to the match", () => {
  const steps = [
    { start: T - MIN, end: T + MIN, count: 100 }, // half before the match
    { start: T + MIN, end: T + 2 * MIN, count: 80 },
  ];
  const s = stepsIn(steps, T, T + 3 * MIN)!;
  assert.equal(s.total, 130);
  assert.deepEqual(s.perMinute, [
    [0, 50],
    [1, 80],
    [2, 0],
  ]);
  assert.equal(stepsIn(steps, T + 10 * MIN, T + 20 * MIN), null);
});

test("efficiency per point won, per rally and per step", () => {
  const e = squash();
  const s = entryToSession(e, me);
  const hr: HrSample[] = [];
  for (let t = s.startedAt; t < s.endedAt!; t += 1000) hr.push({ t, bpm: 150 });
  const steps = Array.from({ length: 40 }, (_, k) => ({ start: T + k * MIN, end: T + (k + 1) * MIN, count: 60 }));
  const m = matchView(s, { side: "a", alignment: null, heartRate: hr, steps, recordings: [], hrMax: 200, daily: { date: "2026-10-06", restingHr: 60 }, typicalRestingHr: null });
  assert.deepEqual(m.tally, { unit: "point", won: 42, lost: 32 });
  assert.equal(m.hr!.extraBeats, 40 * 90);
  assert.equal(m.steps!.total, 2400);
  assert.deepEqual(m.efficiency, { unit: "point", beatsPerUnit: Math.round((3600 / 42) * 10) / 10, stepsPerUnit: Math.round((2400 / 74) * 10) / 10, beatsPerStep: 1.5 });
  assert.equal(m.restingHr!.source, "day");
  const sum = summarize([m]);
  assert.equal(sum.squash.wins, 1);
  assert.equal(sum.squash.avg.unitShare, Math.round((42 / 74) * 1000) / 1000);
});

test("AI prompts stay compact and costs follow OpenAI's prices", () => {
  const s = entryToSession(squash(), me);
  const m = matchView(s, { side: "a", alignment: null, heartRate: [], steps: [], recordings: [], hrMax: null, daily: null, typicalRestingHr: null });
  const prompt = matchPrompt(m, { name: "Bilal", usual: summarize([m]).squash, note: parseNote({ text: "Felt sharp", rpe: 7 }, NOW), hrMax: 195, headToHead: { won: 2, lost: 1 } });
  assert.ok(prompt.length < 800, `${prompt.length} chars`);
  assert.match(prompt, /squash 2026-10-06 vs Usama, WIN 3-1 \(11-7 9-11 11-8 11-6\)/);
  assert.match(prompt, /effort 7\/10, "Felt sharp"/);
  assert.match(prompt, /2W 1L/);
  const overview = overviewPrompt([m, m, m], { name: "Bilal", sport: "squash", summaries: summarize([m]), notes: {} });
  assert.ok(overview.split("\n").length <= 6);

  assert.equal(costUsd("gpt-5.6-luna", { input: 1_000_000, cached: 0, output: 1_000_000, reasoning: 0 }), 1.4);
  assert.equal(costUsd("gpt-5.6-terra", { input: 1_000_000, cached: 500_000, output: 0, reasoning: 0 }), 1.1);
  assert.equal(modelInfo("some-new-model").output, 20, "unknown models are priced like the dearest known one");
});
