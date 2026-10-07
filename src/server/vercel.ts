// Vercel Function entry point. scripts/build-vercel.mjs routes every path here as
// /index?__path=<original path>, so the original path is put back before routing.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "./app.ts";
import { kvFromEnv } from "./kv.ts";
import { toNodeHandler } from "./node-adapter.ts";

const handle = toNodeHandler(createApp({ kv: kvFromEnv(process.env), env: process.env, log: (m) => console.log(m) }));

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal");
  const original = url.searchParams.get("__path");
  if (original !== null) {
    url.searchParams.delete("__path");
    req.url = `${original.startsWith("/") ? original : `/${original}`}${url.search}`;
  }
  return handle(req, res);
}
