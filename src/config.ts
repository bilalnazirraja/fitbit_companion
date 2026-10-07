import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envFile = resolve(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function optionalNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

export const config = {
  root,
  dataDir: resolve(root, "data"),
  dashboardDir: resolve(root, "dashboard"),
  me: process.env.ME?.trim() || undefined,
  scoresUrl: process.env.SCORES_URL?.trim() || "https://club-squash-league.vercel.app/api/state",
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || "",
    port: optionalNumber("OAUTH_PORT") ?? 8787,
  },
  hrMax: optionalNumber("HR_MAX"),
  gameBreakSeconds: optionalNumber("GAME_BREAK_SECONDS") ?? 90,
};
