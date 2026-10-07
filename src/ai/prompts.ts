// What an AI insight gets to see: terse lines of summary numbers, a few hundred tokens at most,
// never raw heart-rate samples.
import type { MatchView, SportSummary, Summaries } from "../analysis/matches.ts";
import type { Note } from "../journal/entries.ts";

export const INSTRUCTIONS =
  "You are a concise sports performance coach for one amateur player (squash, padel, golf). " +
  "Data comes from a wrist heart-rate tracker. 'usual' is the player's own average. " +
  "load = zone-weighted minutes (a minute in Z1 counts 1 ... Z5 counts 5). effort = heartbeats above resting. " +
  "Reply in plain text: up to 3 bullets starting '- ' on what stands out against usual, then one line starting 'Try:' with one specific tip. " +
  "Under 90 words. Use only the numbers given, never invent data, no preamble.";

const UNIT_WON = { point: "point won", game: "game won", hole: "hole" } as const;
const UNIT_PLAYED = { point: "rally", game: "game", hole: "hole" } as const;

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const r0 = (v: number | null | undefined) => (v === null || v === undefined ? "?" : String(Math.round(v)));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "?" : `${Math.round(v * 100)}%`);

function line(label: string, parts: (string | null | undefined | false)[]): string | null {
  const kept = parts.filter((p): p is string => typeof p === "string" && p.length > 0);
  return kept.length > 0 ? `${label}: ${kept.join(", ")}` : null;
}

function who(m: MatchView): string {
  if (m.partner) return `with ${m.partner} vs ${m.opponents.join(" & ")}`;
  return m.opponents.length > 0 ? `${m.sport === "golf" ? "with" : "vs"} ${m.opponents.join(" & ")}` : "";
}

function score(m: MatchView): string {
  if (m.strokes) {
    const over = m.strokes.strokes - m.strokes.par;
    return `${m.strokes.strokes} strokes (${over >= 0 ? "+" : ""}${over}, ${m.strokes.holes} holes)`;
  }
  const won = m.score.filter(([a, b]) => a > b).length;
  return `${won}-${m.score.length - won} (${m.score.map(([a, b]) => `${a}-${b}`).join(" ")})`;
}

function usualLine(sport: string, u: SportSummary, unit: "point" | "game" | "hole" | undefined): string | null {
  const a = u.avg;
  return line(`usual ${sport} (${u.matches} matches)`, [
    sport !== "golf" && `record ${u.wins}-${u.losses}`,
    a.minutes !== null && `${a.minutes} min`,
    a.hr !== null && `hr ${a.hr}`,
    a.load !== null && `load ${a.load}`,
    unit && a.beatsPerUnit !== null && `effort ${a.beatsPerUnit}/${UNIT_WON[unit]}`,
    a.unitShare !== null && unit && unit !== "hole" && `won ${pct(a.unitShare)} of ${unit}s`,
    a.strokes !== null && `${a.strokes} strokes`,
  ]);
}

export interface MatchPromptContext {
  name: string | null;
  usual: SportSummary | undefined;
  note: Note | undefined;
  hrMax: number | null;
  /** Earlier results against the same opponent(s). */
  headToHead: { won: number; lost: number } | null;
}

/** One match, next to the player's usual numbers for that sport. */
export function matchPrompt(m: MatchView, o: MatchPromptContext): string {
  const e = m.efficiency;
  const lines = [
    o.name ? `player: ${o.name}` : null,
    `match: ${m.sport} ${day(m.startedAt)} ${who(m)}, ${m.result ? `${m.result.toUpperCase()} ` : ""}${score(m)}, ${r0(m.minutes)} min`,
    m.hr &&
      line("hr", [
        `avg ${r0(m.hr.avg)}`,
        `max ${m.hr.max}`,
        o.hrMax ? `(their max HR ${o.hrMax})` : null,
        `minutes in Z1-Z5 ${m.hr.zones.map((s) => Math.round(s / 60)).join("/")}`,
        m.hr.load !== null && `load ${m.hr.load}`,
      ]),
    e &&
      line("efficiency", [
        e.beatsPerUnit !== null && `effort ${e.beatsPerUnit}/${UNIT_WON[e.unit]}`,
      ]),
    m.tally && line("points", [`won ${m.tally.won} of ${m.tally.won + m.tally.lost} ${m.tally.unit}s`]),
    o.note &&
      line("felt", [o.note.rpe !== null && `effort ${o.note.rpe}/10`, o.note.text && JSON.stringify(o.note.text.slice(0, 300))]),
    m.daily &&
      line("that day", [
        m.daily.sleepMinutes ? `slept ${Math.floor(m.daily.sleepMinutes / 60)}h${String(Math.round(m.daily.sleepMinutes % 60)).padStart(2, "0")}` : null,
        m.daily.restingHr ? `resting HR ${m.daily.restingHr}` : null,
        m.daily.hrvMs ? `HRV ${Math.round(m.daily.hrvMs)}ms` : null,
      ]),
    o.usual && usualLine(m.sport, o.usual, e?.unit ?? m.tally?.unit),
    o.headToHead && `before this, vs ${m.opponents.join(" & ")}: ${o.headToHead.won}W ${o.headToHead.lost}L`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Recent form: one compact row per match, newest first. */
export function overviewPrompt(
  matches: MatchView[],
  o: { name: string | null; sport: string; summaries: Summaries; notes: Record<string, Note> },
): string {
  const recent = matches.slice(0, 10);
  const rows = recent.map((m) => {
    const note = o.notes[m.id];
    const e = m.efficiency;
    return [
      day(m.startedAt).slice(5),
      o.sport === "all" ? m.sport : null,
      m.opponents.join("&") || "-",
      m.result ? m.result[0].toUpperCase() : "-",
      score(m).split(" (")[0],
      r0(m.minutes),
      m.hr ? r0(m.hr.avg) : "-",
      m.hr?.load ?? "-",
      e?.beatsPerUnit ?? "-",
      note?.rpe ?? "-",
      note?.text ? JSON.stringify(note.text.slice(0, 70)) : "",
    ]
      .filter((v) => v !== null)
      .join("|");
  });
  const header = ["date", o.sport === "all" ? "sport" : null, "opp", "res", "score", "min", "hr", "load", "effort/won", "rpe", "note"]
    .filter(Boolean)
    .join("|");
  const sports = o.sport === "all" ? Object.keys(o.summaries).filter((k) => k !== "all") : [o.sport];
  const usual = sports.map((s) => {
    const u = o.summaries[s];
    const unit = s === "golf" ? "hole" : s === "padel" ? "game" : "point";
    return u ? usualLine(s, u, unit) : null;
  });
  return [
    `${o.name ? `player: ${o.name}. ` : ""}last ${recent.length} ${o.sport === "all" ? "" : `${o.sport} `}matches, newest first. Summarise form and trends.`,
    header,
    ...rows,
    ...usual,
  ]
    .filter(Boolean)
    .join("\n");
}
