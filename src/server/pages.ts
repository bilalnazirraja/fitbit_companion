// Server-rendered pieces of the hosted app: sign-in, setup help, and the bar above the dashboard.
import { dashboardCss } from "../dashboard/render.ts";
import type { SyncStatus } from "./repo.ts";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${dashboardCss}</style>
</head>
<body><main class="wrap narrow">${body}</main></body>
</html>`;
}

export function loginPage(error?: string): string {
  return page(
    "Sign in · Performance Journal",
    `<div class="card">
  <h1>Performance Journal</h1>
  <p class="subtitle">Sign in to see your matches and heart-rate data.</p>
  <form method="post" action="/login" class="stack">
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
    ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""}
    <button class="btn" type="submit">Sign in</button>
  </form>
</div>`,
  );
}

export function messagePage(title: string, message: string, link = { href: "/", label: "Back to the dashboard" }): string {
  return page(
    `${title} · Performance Journal`,
    `<div class="card"><h1>${esc(title)}</h1><p class="subtitle">${esc(message)}</p><p style="margin-top:12px"><a class="btn" href="${esc(link.href)}">${esc(link.label)}</a></p></div>`,
  );
}

/** Shown instead of any data until the deployment is configured, so nothing is ever public. */
export function setupPage(missing: string[]): string {
  return page(
    "Setup needed · Performance Journal",
    `<div class="card">
  <h1>Almost there</h1>
  <p class="subtitle">This deployment still needs:</p>
  <ul>${missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
  <p class="note">Add them in your Vercel project (Settings → Environment Variables, or the Storage tab for Redis), then redeploy. See the README section "Run it on Vercel".</p>
</div>`,
  );
}

export interface ControlsState {
  googleConfigured: boolean;
  connected: boolean;
  status: SyncStatus | null;
  me: string | null;
  /** ME comes from the environment, so it can't be changed here. */
  meLocked: boolean;
  players: string[];
  flash: string | null;
}

export function controlsHtml(s: ControlsState): string {
  const last = s.status
    ? `Last sync <time data-ts="${s.status.at}"></time>: ${esc(s.status.message)}`
    : "Not synced yet. Press Sync now to pull your matches.";
  const connect = !s.googleConfigured
    ? `<span class="note">Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect your watch.</span>`
    : `<a class="btn btn-secondary" href="/connect">${s.connected ? "Reconnect Google Health" : "Connect Google Health"}</a>`;
  const guess = !s.me && s.status?.guess ? s.status.guess : null;
  const chosen = s.me ?? guess ?? "";
  const meForm = s.meLocked
    ? ""
    : `<form method="post" action="/me" class="controls-row">
    <label>Which player are you?
      <select name="me"><option value="">Not set</option>${s.players
        .map((p) => `<option${p === chosen ? " selected" : ""}>${esc(p)}</option>`)
        .join("")}</select>
    </label>
    <button class="btn btn-secondary" type="submit">Save</button>
    ${guess ? `<span class="note">Your watch workouts line up with ${esc(guess)}'s matches.</span>` : ""}
  </form>`;
  return `<div class="wrap controls-wrap">
<div class="controls" role="region" aria-label="Sync and account">
  <div class="controls-row">
    <span class="chip"><span class="dot" style="background:${s.connected ? "var(--series-2)" : "var(--text-muted)"}"></span>Google Health: ${s.connected ? "connected" : "not connected"}</span>
    <span class="controls-status" id="sync-status" role="status">${last}</span>
  </div>
  <div class="controls-row">
    <button class="btn" type="button" id="sync-btn">Sync now</button>
    ${connect}
    <a class="linkish" href="/logout">Sign out</a>
  </div>
  ${meForm}
  ${s.flash ? `<p class="controls-flash" role="status">${esc(s.flash)}</p>` : ""}
</div>
</div>
<script>
(() => {
  for (const el of document.querySelectorAll("time[data-ts]")) {
    el.textContent = new Date(Number(el.dataset.ts)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  const btn = document.getElementById("sync-btn");
  const status = document.getElementById("sync-status");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    // A sync stops starting downloads after ~45s; keep going until nothing is pending.
    for (let part = 1; part <= 10; part++) {
      status.textContent = part === 1 ? "Syncing... this can take a minute." : "Still syncing (part " + part + ")...";
      let body;
      try {
        const res = await fetch("/sync", { method: "POST", headers: { accept: "application/json" } });
        body = await res.json();
      } catch {
        body = { ok: false, message: "Couldn't reach the server. Try again." };
      }
      if (!body.ok) {
        status.textContent = body.message || "Sync failed.";
        btn.disabled = false;
        return;
      }
      if (!body.pending) break;
    }
    location.href = "/";
  });
})();
</script>`;
}
