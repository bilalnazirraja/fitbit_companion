import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.ts";

const d = config.dataDir;

export const paths = {
  scoresLatest: join(d, "raw", "scores", "latest.json"),
  scoresSnapshot: (stamp: string) => join(d, "raw", "scores", `state-${stamp}.json`),
  googleRaw: (kind: string, key: string) => join(d, "raw", "google-health", kind, `${key}.json`),
  token: join(d, "secrets", "google-token.json"),
  wearable: join(d, "wearable.json"),
  demoWearable: join(d, "demo", "wearable.json"),
  dataset: join(d, "dataset.json"),
};

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown, pretty = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, pretty ? 2 : undefined));
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
