// Wearable provider backed by the Google Health API: Fitbit (and Pixel Watch) data.
// Data types: https://developers.google.com/health/data-types
import type {
  DailyContext,
  HrSample,
  Recording,
  StepInterval,
  TimeRange,
  WearableProvider,
} from "../../model.ts";
import { mergeDaily, mergeSamples } from "../../sync/merge.ts";
import type { DataPoint, GoogleHealthClient } from "./client.ts";

const DAY = 86_400_000;
export const PROVIDER_ID = "google-health";

/** RFC 3339 UTC with seconds, as the filter grammar expects. */
export const isoTime = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
export const isoDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Protobuf JSON duration ("3600s", "-18000s", "1.5s") to milliseconds. */
export function parseDuration(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(value.trim());
  return m ? Math.round(Number(m[1]) * 1000) : NaN;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

type Obj = Record<string, any>;

export function parseHeartRate(dp: DataPoint): HrSample | null {
  const hr = dp.heartRate as Obj | undefined;
  const t = Date.parse(hr?.sampleTime?.physicalTime ?? "");
  const bpm = num(hr?.beatsPerMinute);
  return Number.isFinite(t) && bpm !== undefined && bpm > 0 ? { t, bpm } : null;
}

export function parseExercise(dp: DataPoint): Recording | null {
  const ex = dp.exercise as Obj | undefined;
  const start = Date.parse(ex?.interval?.startTime ?? "");
  const end = Date.parse(ex?.interval?.endTime ?? "");
  if (!ex || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const m: Obj = ex.metricsSummary ?? {};
  const zones: Obj | undefined = m.heartRateZoneDurations;
  const offset = parseDuration(ex.interval.startUtcOffset);
  return {
    id: String(dp.name ?? start).split("/").pop()!,
    provider: PROVIDER_ID,
    type: String(ex.exerciseType ?? "EXERCISE_TYPE_UNSPECIFIED"),
    name: String(ex.displayName ?? ex.exerciseType ?? "Exercise"),
    start,
    end,
    utcOffsetMinutes: Number.isFinite(offset) ? offset / 60_000 : 0,
    events: ((ex.exerciseEvents ?? []) as Obj[])
      .map((e) => ({ t: Date.parse(e.eventTime ?? ""), type: String(e.exerciseEventType ?? "") }))
      .filter((e) => Number.isFinite(e.t)),
    summary: {
      avgHr: num(m.averageHeartRateBeatsPerMinute),
      calories: num(m.caloriesKcal),
      steps: num(m.steps),
      activeMs: ex.activeDuration ? parseDuration(ex.activeDuration) : undefined,
      zonesMs: zones
        ? {
            light: parseDuration(zones.lightTime) || 0,
            moderate: parseDuration(zones.moderateTime) || 0,
            vigorous: parseDuration(zones.vigorousTime) || 0,
            peak: parseDuration(zones.peakTime) || 0,
          }
        : undefined,
    },
  };
}

export function parseSteps(dp: DataPoint): StepInterval | null {
  const s = dp.steps as Obj | undefined;
  const start = Date.parse(s?.interval?.startTime ?? "");
  const end = Date.parse(s?.interval?.endTime ?? "");
  const count = num(s?.count);
  return Number.isFinite(start) && Number.isFinite(end) && count !== undefined ? { start, end, count } : null;
}

function civilDate(d: Obj | undefined): string | null {
  if (!d?.year || !d?.month || !d?.day) return null;
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export function parseRestingHr(dp: DataPoint): DailyContext | null {
  const r = dp.dailyRestingHeartRate as Obj | undefined;
  const date = civilDate(r?.date);
  const bpm = num(r?.beatsPerMinute);
  return date && bpm ? { date, restingHr: bpm } : null;
}

export function parseDailyHrv(dp: DataPoint): DailyContext | null {
  const h = dp.dailyHeartRateVariability as Obj | undefined;
  const date = civilDate(h?.date);
  const ms = num(h?.averageHeartRateVariabilityMilliseconds);
  return date && ms ? { date, hrvMs: ms } : null;
}

/** Main sleep, keyed by the local date you woke up (the night before that day's matches). */
export function parseSleep(dp: DataPoint): DailyContext | null {
  const s = dp.sleep as Obj | undefined;
  const end = Date.parse(s?.interval?.endTime ?? "");
  if (!s || !Number.isFinite(end) || s.metadata?.mainSleep === false) return null;
  const offset = parseDuration(s.interval.endUtcOffset);
  const date = isoDate(end + (Number.isFinite(offset) ? offset : 0));
  return {
    date,
    sleepMinutes: num(s.summary?.minutesAsleep),
    sleepAwakeMinutes: num(s.summary?.minutesAwake),
  };
}

function nonNull<T>(v: T | null): v is T {
  return v !== null;
}

export function googleHealthProvider(client: GoogleHealthClient, log: (msg: string) => void = () => {}): WearableProvider {
  /** Daily data is optional context, so a missing permission shouldn't stop the sync. */
  async function optional<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
    try {
      return await run();
    } catch (err) {
      log(`Skipping ${label}: ${(err as Error).message.split("\n")[0]}`);
      return [];
    }
  }

  return {
    id: PROVIDER_ID,

    async recordings(range: TimeRange) {
      // Exercise sessions are filtered on local (civil) dates; pad a day each side, then trim by real time.
      const filter =
        `exercise.interval.civil_start_time >= "${isoDate(range.from - DAY)}" AND ` +
        `exercise.interval.civil_start_time < "${isoDate(range.to + DAY)}"`;
      const points = await client.listAll("exercise", filter, 25);
      return points
        .map(parseExercise)
        .filter(nonNull)
        .filter((r) => r.end > range.from && r.start < range.to)
        .sort((a, b) => a.start - b.start);
    },

    async heartRate(range: TimeRange) {
      const filter =
        `heart_rate.sample_time.physical_time >= "${isoTime(range.from)}" AND ` +
        `heart_rate.sample_time.physical_time < "${isoTime(range.to)}"`;
      const points = await client.listAll("heart-rate", filter, 10_000);
      return mergeSamples(points.map(parseHeartRate).filter(nonNull));
    },

    async steps(range: TimeRange) {
      const filter =
        `steps.interval.start_time >= "${isoTime(range.from)}" AND ` +
        `steps.interval.start_time < "${isoTime(range.to)}"`;
      const points = await client.listAll("steps", filter, 10_000);
      return points.map(parseSteps).filter(nonNull).sort((a, b) => a.start - b.start);
    },

    async daily(fromDate: string, toDate: string) {
      const until = isoDate(Date.parse(toDate) + DAY);
      const range = (field: string) => `${field} >= "${fromDate}" AND ${field} < "${until}"`;
      const resting = await optional("resting heart rate", async () =>
        (await client.listAll("daily-resting-heart-rate", range("daily_resting_heart_rate.date"), 10_000))
          .map(parseRestingHr)
          .filter(nonNull),
      );
      const hrv = await optional("heart rate variability", async () =>
        (await client.listAll("daily-heart-rate-variability", range("daily_heart_rate_variability.date"), 10_000))
          .map(parseDailyHrv)
          .filter(nonNull),
      );
      const sleep = await optional("sleep", async () =>
        (await client.listAll("sleep", range("sleep.interval.civil_end_time"), 25)).map(parseSleep).filter(nonNull),
      );
      return mergeDaily(resting, hrv, sleep);
    },
  };
}
