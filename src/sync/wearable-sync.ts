// Pulls wearable data around your matches and merges it into what was synced before.
// Only matches not synced yet are downloaded, so repeat syncs are quick.
import type { HrSample, Recording, Session, TimeRange, WearableData, WearableProvider } from "../model.ts";
import { coverage } from "./hr.ts";
import { mergeDaily, mergeSamples } from "./merge.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const NEARBY_MS = 10 * MIN;

export interface SyncOptions {
  me?: string;
  /** Which matches are yours (default: the ones `me` played); their heart rate is fetched even without a workout. */
  mine?: (s: Session) => boolean;
  from?: number;
  to?: number;
  log?: (msg: string) => void;
  /** Download heart rate for every match again, not just new ones. */
  full?: boolean;
  /** Don't start new downloads after this time (epoch ms); the rest waits for the next sync. */
  deadline?: number;
}

export interface SyncResult {
  data: WearableData;
  /** Workouts still waiting for their heart rate because the deadline was reached. */
  pending: number;
  /** UTC days (YYYY-MM-DD) whose heart rate changed, for storage split by day. */
  changedDays: string[];
}

interface Job {
  key: string;
  range: TimeRange;
  recording?: Recording;
}

export function overlapsSession(s: Session, r: Recording): boolean {
  const end = s.endedAt ?? s.startedAt;
  return r.start < end + NEARBY_MS && r.end > s.startedAt - NEARBY_MS;
}

export function plays(s: Session, name: string): boolean {
  return s.participants.some((p) => p.name.toLowerCase() === name.toLowerCase());
}

export async function syncWearable(
  provider: WearableProvider,
  sessions: Session[],
  previous: WearableData | undefined,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const outOfTime = () => opts.deadline !== undefined && Date.now() > opts.deadline;
  const timed = sessions.filter((s) => s.endedAt !== null);
  if (timed.length === 0) throw new Error("No matches to sync against. Sync the scores first.");
  const from = opts.from ?? Math.min(...timed.map((s) => s.startedAt)) - DAY;
  const to = opts.to ?? Math.max(...timed.map((s) => s.endedAt!)) + DAY;

  log(`Looking for watch workouts from ${day(from)} to ${day(to)}...`);
  const found = await provider.recordings({ from, to });
  const recordings = found.filter((r) => sessions.some((s) => overlapsSession(s, r)));
  log(`Found ${found.length} workouts, ${recordings.length} during a match.`);

  const jobs: Job[] = recordings.map((r) => ({ key: `rec:${r.id}`, range: { from: r.start - 5 * MIN, to: r.end + 10 * MIN }, recording: r }));
  const mine = opts.mine ?? (opts.me ? (s: Session) => plays(s, opts.me!) : null);
  if (mine) {
    // Matches you played without starting the watch: all-day HR may still cover them.
    for (const s of timed) {
      if (mine(s) && s.quality.timing !== "untimed" && !recordings.some((r) => overlapsSession(s, r))) {
        // The times are part of the key, so a match whose times are corrected gets downloaded again.
        jobs.push({ key: `match:${s.id}@${s.startedAt}-${s.endedAt}`, range: { from: s.startedAt - 10 * MIN, to: s.endedAt! + 10 * MIN } });
      }
    }
  }
  const done = new Set(opts.full ? [] : (previous?.fetched ?? []));
  const groups = groupOverlapping(jobs.filter((j) => !done.has(j.key)));
  log(`${groups.length === 0 ? "Heart rate is up to date." : `Downloading heart rate for ${groups.length} new window(s).`}`);

  let heartRate = previous?.heartRate ?? [];
  let steps = previous?.steps ?? [];
  const changedDays = new Set<string>();
  let pending = 0;
  for (const [i, g] of groups.entries()) {
    if (outOfTime()) {
      pending = groups.slice(i).reduce((n, rest) => n + rest.jobs.length, 0);
      log(`Out of time: ${pending} workout(s) left for the next sync.`);
      break;
    }
    log(`Heart rate ${i + 1}/${groups.length}: ${stamp(g.range.from)} to ${stamp(g.range.to)}`);
    const samples = await provider.heartRate(g.range);
    heartRate = mergeSamples(heartRate, samples);
    for (let t = g.range.from; t <= g.range.to; t += DAY) changedDays.add(day(t));
    changedDays.add(day(g.range.to));
    for (const job of g.jobs) {
      // A workout whose heart rate hasn't reached the cloud yet gets retried next time.
      if (!job.recording || covered(samples, job.recording) >= 0.3) done.add(job.key);
    }
  }

  let daily = previous?.daily ?? [];
  if (provider.daily && jobs.length > 0 && !outOfTime()) {
    const first = day(Math.min(...jobs.map((j) => j.range.from)) - DAY);
    const last = day(Math.max(...jobs.map((j) => j.range.to)));
    log(`Daily context (resting HR, HRV, sleep) ${first} to ${last}`);
    daily = mergeDaily(daily, await provider.daily(first, last));
  }

  const byId = new Map((previous?.recordings ?? []).map((r) => [r.id, r]));
  for (const r of recordings) byId.set(r.id, r);

  return {
    data: {
      provider: provider.id,
      syncedAt: Date.now(),
      recordings: [...byId.values()].sort((a, b) => a.start - b.start),
      heartRate,
      steps,
      daily,
      fetched: [...done],
    },
    pending,
    changedDays: [...changedDays],
  };
}

function covered(samples: HrSample[], r: Recording): number {
  return coverage(samples, r.start, r.end);
}

/** Overlapping download windows (back-to-back matches) are fetched once. */
function groupOverlapping(jobs: Job[]): { range: TimeRange; jobs: Job[] }[] {
  const out: { range: TimeRange; jobs: Job[] }[] = [];
  for (const j of [...jobs].sort((a, b) => a.range.from - b.range.from)) {
    const last = out[out.length - 1];
    if (last && j.range.from <= last.range.to) {
      last.range.to = Math.max(last.range.to, j.range.to);
      last.jobs.push(j);
    } else {
      out.push({ range: { ...j.range }, jobs: [j] });
    }
  }
  return out;
}

/** Which player the watch belongs to: the one whose matches line up with the recorded workouts. */
export function guessMe(sessions: Session[], recordings: Recording[]): { name: string; matched: number; played: number }[] {
  const tally = new Map<string, { matched: number; played: number }>();
  for (const s of sessions) {
    if (s.quality.timing === "untimed") continue;
    const hit = recordings.some((r) => overlapsSession(s, r));
    for (const p of s.participants) {
      const t = tally.get(p.name) ?? { matched: 0, played: 0 };
      t.played++;
      if (hit) t.matched++;
      tally.set(p.name, t);
    }
  }
  return [...tally]
    .map(([name, t]) => ({ name, ...t }))
    .sort((a, b) => b.matched / Math.max(1, b.played) - a.matched / Math.max(1, a.played) || b.matched - a.matched);
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
