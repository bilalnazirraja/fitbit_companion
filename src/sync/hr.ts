// Heart-rate series helpers. Samples are sorted by time and may be irregular (1-15s apart) with gaps.
import type { HrSample } from "../model.ts";

/** Index of the first sample with t >= time. */
export function lowerBound(samples: HrSample[], time: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].t < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function slice(samples: HrSample[], from: number, to: number): HrSample[] {
  return samples.slice(lowerBound(samples, from), lowerBound(samples, to));
}

export function summarize(samples: HrSample[]): { mean: number; max: number; min: number } | null {
  if (samples.length === 0) return null;
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const s of samples) {
    sum += s.bpm;
    if (s.bpm > max) max = s.bpm;
    if (s.bpm < min) min = s.bpm;
  }
  return { mean: sum / samples.length, max, min };
}

/**
 * Resample to one value per second over [from, to), interpolating linearly across gaps up to
 * maxGapSec. Longer gaps become NaN.
 */
export function resample1Hz(samples: HrSample[], from: number, to: number, maxGapSec = 30): Float64Array {
  const n = Math.max(0, Math.floor((to - from) / 1000));
  const out = new Float64Array(n).fill(NaN);
  let j = Math.max(0, lowerBound(samples, from) - 1);
  for (let i = 0; i < n; i++) {
    const t = from + i * 1000;
    while (j + 1 < samples.length && samples[j + 1].t <= t) j++;
    const a = samples[j];
    const b = samples[j + 1];
    if (!a) continue;
    if (a.t === t) out[i] = a.bpm;
    else if (b && a.t < t && t < b.t && b.t - a.t <= maxGapSec * 1000) {
      out[i] = a.bpm + ((b.bpm - a.bpm) * (t - a.t)) / (b.t - a.t);
    }
  }
  return out;
}

/** Centered moving average that skips NaN; a window with no values stays NaN. */
export function smooth(series: Float64Array, windowSec: number): Float64Array {
  const half = Math.floor(windowSec / 2);
  const out = new Float64Array(series.length).fill(NaN);
  let sum = 0;
  let count = 0;
  // Sliding window [i - half, i + half]
  for (let k = 0; k <= Math.min(half, series.length - 1); k++) {
    if (!Number.isNaN(series[k])) {
      sum += series[k];
      count++;
    }
  }
  for (let i = 0; i < series.length; i++) {
    if (count > 0) out[i] = sum / count;
    const leaving = i - half;
    const entering = i + half + 1;
    if (leaving >= 0 && !Number.isNaN(series[leaving])) {
      sum -= series[leaving];
      count--;
    }
    if (entering < series.length && !Number.isNaN(series[entering])) {
      sum += series[entering];
      count++;
    }
  }
  return out;
}

/** Mean of series[from..to] (inclusive, clamped), ignoring NaN. */
export function meanRange(series: Float64Array, from: number, to: number): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, from); i <= Math.min(series.length - 1, to); i++) {
    if (!Number.isNaN(series[i])) {
      sum += series[i];
      count++;
    }
  }
  return count > 0 ? sum / count : NaN;
}

/** Share of seconds in [from, to) that have heart-rate data. */
export function coverage(samples: HrSample[], from: number, to: number, maxGapSec = 30): number {
  const series = resample1Hz(samples, from, to, maxGapSec);
  if (series.length === 0) return 0;
  let have = 0;
  for (const v of series) if (!Number.isNaN(v)) have++;
  return have / series.length;
}

/** Average into fixed buckets for charts: [[t, bpm], ...]. */
export function downsample(samples: HrSample[], from: number, to: number, stepSec = 5): [number, number][] {
  const out: [number, number][] = [];
  const step = stepSec * 1000;
  let i = lowerBound(samples, from);
  for (let t = from; t < to; t += step) {
    let sum = 0;
    let count = 0;
    while (i < samples.length && samples[i].t < t + step) {
      sum += samples[i].bpm;
      count++;
      i++;
    }
    if (count > 0) out.push([t + step / 2, Math.round((sum / count) * 10) / 10]);
  }
  return out;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}
