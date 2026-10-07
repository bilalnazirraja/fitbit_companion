// Server-rendered pages of the hosted app: sign-in, setup help and messages. The app itself is
// rendered by dashboard/render.ts.
import { dashboardCss, TEXT_FONT_URL } from "../dashboard/render.ts";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const LOGO = `<svg class="logo" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#121411"/><path d="M92 272h78l40-92 56 176 44-120 28 36h82" fill="none" stroke="#c6f432" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f4f5ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121411" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${TEXT_FONT_URL}">
<style>${dashboardCss}</style>
</head>
<body><main class="solo">${body}<p class="credit body-small">Powered by <a href="https://rapteck.com/" target="_blank" rel="noopener">Rapteck</a></p></main></body>
</html>`;
}

export function loginPage(error?: string): string {
  return page(
    "Sign in · Performance Journal",
    `<div class="card solo-card">
  ${LOGO}
  <h1 class="headline-small">Performance Journal</h1>
  <p class="body-medium muted">Sign in to log matches, add notes and sync your watch.</p>
  <form method="post" action="/login" class="stack">
    <label class="field"><span class="field-label">Password</span><input name="password" type="password" autocomplete="current-password" required autofocus></label>
    ${error ? `<p class="field-error" role="alert">${esc(error)}</p>` : ""}
    <button class="btn filled" type="submit">Sign in</button>
  </form>
  <p class="body-small"><a href="/">Just looking? View the journal</a></p>
</div>`,
  );
}

export function messagePage(title: string, message: string, link = { href: "/", label: "Back to the app" }): string {
  return page(
    `${title} · Performance Journal`,
    `<div class="card solo-card">${LOGO}<h1 class="headline-small">${esc(title)}</h1><p class="body-medium muted">${esc(message)}</p><p><a class="btn filled" href="${esc(link.href)}">${esc(link.label)}</a></p></div>`,
  );
}

/** Shown instead of any data until the deployment is configured, so nothing is ever public. */
export function setupPage(missing: string[]): string {
  return page(
    "Setup needed · Performance Journal",
    `<div class="card solo-card">
  ${LOGO}
  <h1 class="headline-small">Almost there</h1>
  <p class="body-medium muted">This deployment still needs:</p>
  <ul class="body-medium">${missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
  <p class="body-small muted">Add them in your Vercel project (Settings → Environment Variables, or the Storage tab for Redis), then redeploy. See the README section "Run it on Vercel".</p>
</div>`,
  );
}
