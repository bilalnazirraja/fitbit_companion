// Writes the dashboard as one self-contained HTML file with the dataset embedded.
import { readFileSync } from "node:fs";
import type { Dataset } from "../analysis/dataset.ts";

// Read relative to this module; the Vercel build copies both files next to the bundled function.
const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const js = readFileSync(new URL("./app.js", import.meta.url), "utf8");

/** The dashboard's stylesheet, for other pages that should look the same. */
export const dashboardCss = css;

export interface RenderOptions {
  /** Trusted, server-built HTML shown above the dashboard (the hosted version's sync controls). */
  controls?: string;
}

export function renderDashboard(data: Dataset, opts: RenderOptions = {}): string {
  // "<" escaped so player names can never close the script tag.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const title = data.demo ? "Performance Journal (demo)" : "Performance Journal";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${css}
</style>
</head>
<body>
${opts.controls ?? ""}
<main id="app" class="wrap"></main>
<script id="data" type="application/json">${json}</script>
<script>
${js}
</script>
</body>
</html>
`;
}
