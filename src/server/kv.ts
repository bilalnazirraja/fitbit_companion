// Key-value storage for the hosted version: Upstash Redis (added from Vercel's Storage tab) in
// production, plain files under data/kv for `npm run serve`, and memory for tests.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Kv {
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<(string | null)[]>;
  set(entries: Record<string, string>): Promise<void>;
  del(key: string): Promise<void>;
}

/** Upstash's REST API: each command is POSTed as a JSON array, e.g. ["GET", "key"]. */
export function upstashKv(url: string, token: string, doFetch: typeof fetch = fetch): Kv {
  async function call(command: string[]): Promise<unknown> {
    const res = await doFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`Redis ${command[0]} failed: ${body.error ?? `HTTP ${res.status}`}`);
    return body.result ?? null;
  }
  return {
    async get(key) {
      return (await call(["GET", key])) as string | null;
    },
    async mget(keys) {
      return keys.length === 0 ? [] : ((await call(["MGET", ...keys])) as (string | null)[]);
    },
    async set(entries) {
      const flat = Object.entries(entries).flat();
      if (flat.length > 0) await call(["MSET", ...flat]);
    },
    async del(key) {
      await call(["DEL", key]);
    },
  };
}

export function fileKv(dir: string): Kv {
  const path = (key: string) => join(dir, `${encodeURIComponent(key)}.json`);
  const read = (key: string) => (existsSync(path(key)) ? readFileSync(path(key), "utf8") : null);
  return {
    async get(key) {
      return read(key);
    },
    async mget(keys) {
      return keys.map(read);
    },
    async set(entries) {
      mkdirSync(dir, { recursive: true });
      for (const [k, v] of Object.entries(entries)) writeFileSync(path(k), v);
    },
    async del(key) {
      rmSync(path(key), { force: true });
    },
  };
}

export function memoryKv(): Kv & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async mget(keys) {
      return keys.map((k) => data.get(k) ?? null);
    },
    async set(entries) {
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
    },
    async del(key) {
      data.delete(key);
    },
  };
}

/** Upstash if its variables are set (either naming Vercel uses), otherwise null. */
export function kvFromEnv(env: Record<string, string | undefined>, doFetch?: typeof fetch): Kv | null {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? upstashKv(url, token, doFetch) : null;
}
