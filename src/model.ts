// Core data model, independent of sport and of wearable vendor.
//
// Score sources (the squash league app today; golf/padel later) produce Sessions.
// Wearable providers (Google Health/Fitbit today; Garmin/Apple later) produce
// Recordings, heart-rate samples and daily context. The sync layer joins them.
// All timestamps are epoch milliseconds (UTC).

export type Side = "a" | "b";

export interface Participant {
  id: string;
  name: string;
  side: Side;
}

/** A game in squash/padel, a hole in golf. */
export interface Segment {
  index: number; // 1-based
  scoreA: number;
  scoreB: number;
  winner: Side | null;
}

/** One rally/point, in the order it was played. */
export interface ScoreEvent {
  seq: number; // 0-based position within the session
  segment: number; // 1-based game index
  kind: "point" | "stroke" | "let";
  wonBy: Side | null; // null for lets
  /** When the point was recorded, if the score source captured it. */
  at?: number;
}

/**
 * live     – scored point-by-point during play; start/end times are trustworthy
 * suspect  – plausible but unusual pace (e.g. scored partly after the fact)
 * untimed  – entered after the match; times say nothing about when rallies happened
 */
export type TimingQuality = "live" | "suspect" | "untimed";

/** Stroke play (golf): total strokes against par, optionally hole by hole. */
export interface StrokeScore {
  course: string | null;
  holes: number;
  strokes: number;
  par: number;
  /** Strokes on each hole when entered hole by hole; null where left blank. */
  perHole: (number | null)[] | null;
}

export interface Session {
  id: string;
  source: string;
  sport: string;
  format: string;
  startedAt: number;
  endedAt: number | null;
  participants: Participant[];
  segments: Segment[];
  events: ScoreEvent[];
  winner: Side | null;
  quality: {
    /** Point log reproduces every game score, so rally-level analysis is valid. */
    logComplete: boolean;
    timing: TimingQuality;
    notes: string[];
  };
  /** Golf. */
  strokes?: StrokeScore;
  /** The player's UTC offset when the match was played, if the source knows it. */
  utcOffsetMinutes?: number;
}

export interface HrSample {
  t: number;
  bpm: number;
}

/** An exercise the wearable recorded (the watch's start/stop). */
export interface Recording {
  id: string;
  provider: string;
  type: string;
  name: string;
  start: number;
  end: number;
  utcOffsetMinutes: number;
  /** START / STOP / PAUSE / RESUME / AUTO_PAUSE / AUTO_RESUME */
  events: { t: number; type: string }[];
  summary: {
    avgHr?: number;
    calories?: number;
    activeMs?: number;
    zonesMs?: Record<string, number>;
  };
}

/** Pre-match state: how recovered/rested you were that day. */
export interface DailyContext {
  date: string; // local calendar date, YYYY-MM-DD
  restingHr?: number;
  hrvMs?: number; // nightly average RMSSD
  sleepMinutes?: number; // main sleep ending on this date
  sleepAwakeMinutes?: number;
}

export interface WearableData {
  provider: string;
  syncedAt: number;
  recordings: Recording[];
  heartRate: HrSample[]; // sorted by t, deduplicated
  daily: DailyContext[];
  /** Workouts/matches whose heart rate is already in, so the next sync can skip them. */
  fetched?: string[];
}

export interface TimeRange {
  from: number;
  to: number;
}

/** What every wearable integration must provide. Add Garmin/Apple by implementing this. */
export interface WearableProvider {
  readonly id: string;
  recordings(range: TimeRange): Promise<Recording[]>;
  heartRate(range: TimeRange): Promise<HrSample[]>;
  /** Inclusive local dates, YYYY-MM-DD. */
  daily?(fromDate: string, toDate: string): Promise<DailyContext[]>;
}
