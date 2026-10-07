// The hosted app on your own machine: `npm run serve`, then http://localhost:8787
// Uses the same Google OAuth client and redirect address as `npm run auth`.
import { createServer } from "node:http";
import { join } from "node:path";
import { config } from "../config.ts"; // also loads .env
import { createApp } from "./app.ts";
import { fileKv, kvFromEnv } from "./kv.ts";
import { toNodeHandler } from "./node-adapter.ts";

const port = Number(process.env.PORT) || config.google.port;
const kv = kvFromEnv(process.env) ?? fileKv(join(config.dataDir, "kv"));
const app = createApp({ kv, env: process.env, log: (m) => console.log(m) });

createServer(toNodeHandler(app)).listen(port, () => {
  console.log(`Performance Journal: http://localhost:${port}`);
  if (!process.env.APP_PASSWORD) console.log("Set APP_PASSWORD in .env to sign in.");
});
