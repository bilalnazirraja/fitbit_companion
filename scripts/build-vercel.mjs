// Builds the hosted app in Vercel's Build Output API format (.vercel/output), so Vercel deploys
// it as one Node.js function with every path routed to it. Vercel runs this via `vercel-build`.
// https://vercel.com/docs/build-output-api
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildVercel(outDir = join(root, ".vercel", "output")) {
  rmSync(outDir, { recursive: true, force: true });
  const fn = join(outDir, "functions", "index.func");
  mkdirSync(fn, { recursive: true });

  await build({
    entryPoints: [join(root, "src", "server", "vercel.ts")],
    outfile: join(fn, "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    logLevel: "warning",
  });
  // The dashboard reads its stylesheet and script from next to its own module at startup.
  for (const asset of ["app.css", "app.js"]) copyFileSync(join(root, "src", "dashboard", asset), join(fn, asset));

  writeFileSync(
    join(fn, ".vc-config.json"),
    JSON.stringify(
      {
        runtime: "nodejs22.x",
        handler: "index.mjs",
        launcherType: "Nodejs",
        shouldAddHelpers: false,
        shouldAddSourcemapSupport: true,
        maxDuration: 60,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(outDir, "config.json"),
    JSON.stringify(
      {
        version: 3,
        routes: [{ handle: "filesystem" }, { src: "^/(.*)$", dest: "/index?__path=/$1" }],
        // Runs only once CRON_SECRET is set in the project; 02:00 UTC daily.
        crons: [{ path: "/cron/sync", schedule: "0 2 * * *" }],
      },
      null,
      2,
    ),
  );
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await buildVercel();
  console.log(`Built ${out}`);
}
