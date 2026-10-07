// What the hosted app keeps in storage. Heart rate is split into one value per day, so nothing
// grows without bound as the season goes on.
import type { Dataset } from "../analysis/dataset.ts";
import type { HrSample, WearableData } from "../model.ts";
import type { LeagueState } from "../sources/club-squash-league.ts";
import type { StoredToken } from "../sources/google-health/oauth.ts";
import type { Kv } from "./kv.ts";

const KEY = {
  token: "pj:token",
  scores: "pj:scores",
  wearable: "pj:wearable",
  dataset: "pj:dataset",
  me: "pj:me",
  sync: "pj:sync",
  hr: (day: string) => `pj:hr:${day}`,
};

export interface SyncStatus {
  at: number;
  ok: boolean;
  message: string;
  /** Workouts still waiting to download; the next sync carries on. */
  pending: number;
  /** Which player the watch workouts point to, when you haven't said yet. */
  guess?: string | null;
}

type WearableMeta = Omit<WearableData, "heartRate"> & { hrDays: string[] };

export function repo(kv: Kv) {
  const read = async <T>(key: string): Promise<T | null> => {
    const v = await kv.get(key);
    return v === null ? null : (JSON.parse(v) as T);
  };
  const write = (key: string, value: unknown) => kv.set({ [key]: JSON.stringify(value) });

  return {
    token: () => read<StoredToken>(KEY.token),
    saveToken: (t: StoredToken) => write(KEY.token, t),
    scores: () => read<LeagueState>(KEY.scores),
    saveScores: (s: LeagueState) => write(KEY.scores, s),
    dataset: () => read<Dataset>(KEY.dataset),
    saveDataset: (d: Dataset) => write(KEY.dataset, d),
    me: async () => (await kv.get(KEY.me)) || null,
    saveMe: (name: string) => kv.set({ [KEY.me]: name }),
    syncStatus: () => read<SyncStatus>(KEY.sync),
    saveSyncStatus: (s: SyncStatus) => write(KEY.sync, s),

    async wearable(): Promise<WearableData | null> {
      const meta = await read<WearableMeta>(KEY.wearable);
      if (!meta) return null;
      const heartRate: HrSample[] = [];
      for (const day of await kv.mget(meta.hrDays.map(KEY.hr))) {
        if (day) for (const [t, bpm] of JSON.parse(day) as [number, number][]) heartRate.push({ t, bpm });
      }
      heartRate.sort((a, b) => a.t - b.t);
      const { hrDays: _days, ...rest } = meta;
      return { ...rest, heartRate };
    },

    /** Saves wearable data; of the heart rate, only `changedDays` are rewritten (all if omitted). */
    async saveWearable(data: WearableData, changedDays?: string[]): Promise<void> {
      const byDay = new Map<string, [number, number][]>();
      for (const s of data.heartRate) {
        const day = new Date(s.t).toISOString().slice(0, 10);
        let list = byDay.get(day);
        if (!list) byDay.set(day, (list = []));
        list.push([s.t, s.bpm]);
      }
      const { heartRate: _hr, ...rest } = data;
      const entries: Record<string, string> = {
        [KEY.wearable]: JSON.stringify({ ...rest, hrDays: [...byDay.keys()].sort() }),
      };
      for (const day of changedDays ?? [...byDay.keys()]) {
        const samples = byDay.get(day);
        if (samples) entries[KEY.hr(day)] = JSON.stringify(samples);
      }
      await kv.set(entries);
    },
  };
}

export type Repo = ReturnType<typeof repo>;
