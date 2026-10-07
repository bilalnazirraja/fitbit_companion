// What the hosted app keeps in storage. Heart rate is split into one value per day, so nothing
// grows without bound as the season goes on.
import type { Dataset } from "../analysis/dataset.ts";
import { DEFAULT_MODEL, type TokenCounts } from "../ai/openai.ts";
import { InputError, type JournalEntry, type Note } from "../journal/entries.ts";
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
  journal: "pj:journal",
  notes: "pj:notes",
  settings: "pj:settings",
  aiUsage: "pj:ai:usage",
  aiInsights: "pj:ai:insights",
};

export interface Settings {
  /** Your name as the app shows it. */
  name: string | null;
  /** Overrides the highest heart rate seen in your matches. */
  hrMax: number | null;
  aiModel: string;
  /** AI requests stop for the month once this much has been spent (US dollars). */
  aiBudgetUsd: number;
}

export const DEFAULT_SETTINGS: Settings = { name: null, hrMax: null, aiModel: DEFAULT_MODEL, aiBudgetUsd: 2 };

/** Applies the fields present in `body` to `current`; throws InputError on bad values. */
export function parseSettings(body: unknown, current: Settings, models: string[]): Settings {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const next = { ...current };
  if ("name" in b) {
    next.name = typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim().slice(0, 40) || null : null;
  }
  if ("hrMax" in b) {
    if (b.hrMax === null || b.hrMax === "") next.hrMax = null;
    else {
      const v = Number(b.hrMax);
      if (!Number.isInteger(v) || v < 120 || v > 230) throw new InputError("Max heart rate should be a whole number from 120 to 230.");
      next.hrMax = v;
    }
  }
  if ("aiModel" in b) {
    if (typeof b.aiModel !== "string" || !models.includes(b.aiModel)) throw new InputError("Pick one of the listed AI models.");
    next.aiModel = b.aiModel;
  }
  if ("aiBudgetUsd" in b) {
    const v = Number(b.aiBudgetUsd);
    if (!Number.isFinite(v) || v < 0 || v > 500) throw new InputError("The monthly AI budget should be between $0 and $500.");
    next.aiBudgetUsd = Math.round(v * 100) / 100;
  }
  return next;
}

/** AI spending in one calendar month (UTC). */
export interface AiUsage extends TokenCounts {
  requests: number;
  costUsd: number;
}

export interface SavedInsight {
  text: string;
  at: number;
  model: string;
  /** Of the model and the data sent: the same hash means asking again would give nothing new. */
  hash: string;
  costUsd: number;
  complete: boolean;
}

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
    journal: async () => (await read<JournalEntry[]>(KEY.journal)) ?? [],
    saveJournal: (list: JournalEntry[]) => write(KEY.journal, list),
    notes: async () => (await read<Record<string, Note>>(KEY.notes)) ?? {},
    saveNotes: (notes: Record<string, Note>) => write(KEY.notes, notes),
    settings: async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...(await read<Partial<Settings>>(KEY.settings)) }),
    saveSettings: (s: Settings) => write(KEY.settings, s),
    /** Keyed by month, e.g. "2026-10". */
    aiUsage: async () => (await read<Record<string, AiUsage>>(KEY.aiUsage)) ?? {},
    saveAiUsage: (u: Record<string, AiUsage>) => write(KEY.aiUsage, u),
    /** Keyed by what was asked about, e.g. "match:<id>" or "overview:squash". */
    aiInsights: async () => (await read<Record<string, SavedInsight>>(KEY.aiInsights)) ?? {},
    saveAiInsights: (i: Record<string, SavedInsight>) => write(KEY.aiInsights, i),

    async wearable(): Promise<WearableData | null> {
      const meta = await read<WearableMeta>(KEY.wearable);
      if (!meta) return null;
      const heartRate: HrSample[] = [];
      for (const day of await kv.mget(meta.hrDays.map(KEY.hr))) {
        if (day) for (const [t, bpm] of JSON.parse(day) as [number, number][]) heartRate.push({ t, bpm });
      }
      heartRate.sort((a, b) => a.t - b.t);
      // Steps from older versions are dropped, so the next save removes them from storage.
      const { hrDays: _days, steps: _steps, ...rest } = meta as WearableMeta & { steps?: unknown };
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
