// Merging freshly synced data into what was synced before, without duplicates.
import type { DailyContext, HrSample, StepInterval } from "../model.ts";

/** Sorted, one value per timestamp (later lists win). */
export function mergeSamples(...lists: HrSample[][]): HrSample[] {
  const byT = new Map<number, number>();
  for (const list of lists) for (const s of list) byT.set(s.t, s.bpm);
  return [...byT].map(([t, bpm]) => ({ t, bpm })).sort((a, b) => a.t - b.t);
}

export function mergeSteps(...lists: StepInterval[][]): StepInterval[] {
  const byStart = new Map<number, StepInterval>();
  for (const list of lists) for (const s of list) byStart.set(s.start, s);
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/** One entry per date, combining fields from every list. */
export function mergeDaily(...lists: DailyContext[][]): DailyContext[] {
  const byDate = new Map<string, DailyContext>();
  for (const list of lists) for (const d of list) byDate.set(d.date, { ...byDate.get(d.date), ...d });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
