import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
// @ts-expect-error plain JS build script
import { buildVercel } from "../scripts/build-vercel.mjs";

const SCORES = readFileSync(resolve(import.meta.dirname, "..", "scores.txt"), "utf8");
const out = mkdtempSync(join(tmpdir(), "pj-vercel-"));
after(() => rmSync(out, { recursive: true, force: true }));

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  return new Promise((done) => {
    const server = createServer(handler).listen(0, "127.0.0.1", () => {
      done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
    after(() => server.close());
  });
}

test("the Vercel build serves the app from one bundled function", async () => {
  await buildVercel(out);
  const fn = join(out, "functions", "index.func");
  for (const f of ["index.mjs", "app.css", "client/01-core.js", ".vc-config.json"]) assert.ok(existsSync(join(fn, f)), f);
  const config = JSON.parse(readFileSync(join(out, "config.json"), "utf8"));
  assert.equal(config.version, 3);

  // A stand-in for Upstash's REST API (commands as JSON arrays) plus the league's /api/state.
  const store = new Map<string, string>();
  const commands: string[] = [];
  const backend = await listen(async (req, res) => {
    if (req.url === "/scores") return void res.end(SCORES);
    let body = "";
    for await (const chunk of req) body += chunk;
    const [cmd, ...args] = JSON.parse(body) as string[];
    commands.push(cmd);
    let result: unknown = "OK";
    if (cmd === "GET") result = store.get(args[0]) ?? null;
    if (cmd === "MGET") result = args.map((k) => store.get(k) ?? null);
    if (cmd === "MSET") for (let i = 0; i < args.length; i += 2) store.set(args[i], args[i + 1]);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result }));
  });

  Object.assign(process.env, {
    KV_REST_API_URL: backend,
    KV_REST_API_TOKEN: "token",
    APP_PASSWORD: "pw",
    SCORES_URL: `${backend}/scores`,
  });
  const { default: handler } = await import(pathToFileURL(join(fn, "index.mjs")).href);

  // Mimic Vercel's routing: every path is rewritten to /index?__path=<path>, query kept.
  const site = await listen((req, res) => {
    const u = new URL(req.url!, "http://x");
    const original = u.pathname;
    u.searchParams.set("__path", original);
    req.url = `/index?${u.searchParams}`;
    handler(req, res);
  });

  const login = await fetch(`${site}/login`);
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Sign in/);

  const home = await fetch(`${site}/`, { redirect: "manual" });
  assert.equal(home.status, 303);
  assert.equal(home.headers.get("location"), "/login");

  const signIn = await fetch(`${site}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=pw",
  });
  assert.equal(signIn.status, 303);
  const cookie = signIn.headers.getSetCookie()[0].split(";")[0];

  const page = await fetch(`${site}/?flash=Hello%20there`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Hello there/, "query string survives the rewrite");
  assert.match(html, /--md-primary/, "bundled stylesheet loaded");
  assert.match(html, /function render\(\)/, "bundled scripts loaded");
  assert.ok(commands.includes("MSET") && store.has("pj:dataset"), "dataset saved to Redis");

  const callback = await fetch(`${site}/oauth/callback?state=x&code=y`, { headers: { cookie } });
  assert.equal(callback.status, 400, "callback routed, and refused without our sign-in state");
});
