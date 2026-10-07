// Google OAuth 2.0 (authorization code + PKCE) for the Google Health API, run from the command line.
// A one-off local server on http://localhost:<port>/oauth/callback receives the redirect.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

/** The saved login no longer works and the user has to connect again. */
export class ReconnectError extends Error {}

export interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
}

export function redirectUri(port: number): string {
  return `http://localhost:${port}/oauth/callback`;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthUrl(clientId: string, redirect: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // always return a refresh token, even on re-auth
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

/** Runs the browser consent flow and returns tokens. */
export async function authorize(client: OAuthClient, port: number): Promise<StoredToken> {
  const redirect = redirectUri(port);
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("hex");
  const url = buildAuthUrl(client.clientId, redirect, state, challenge);
  const code = await waitForCode(port, state, url);
  const { token, missingScopes } = await exchangeCode(client, code, redirect, verifier);
  if (missingScopes.length > 0) {
    console.warn(`Warning: these permissions weren't granted, so some data will be missing:\n  ${missingScopes.join("\n  ")}`);
  }
  return token;
}

/** Swaps the one-time code from Google's redirect for tokens. */
export async function exchangeCode(
  client: OAuthClient,
  code: string,
  redirect: string,
  verifier: string,
): Promise<{ token: StoredToken; missingScopes: string[] }> {
  const token = await tokenRequest(client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  if (!token.refresh_token) {
    throw new Error("Google didn't return a refresh token. Remove the app's access at https://myaccount.google.com/permissions and connect again.");
  }
  return { token, missingScopes: SCOPES.filter((s) => !token.scope.split(" ").includes(s)) };
}

/** Exchanges a refresh token for a fresh access token. */
export async function refresh(client: OAuthClient, token: StoredToken): Promise<StoredToken> {
  const next = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: token.refresh_token });
  return {
    ...next,
    refresh_token: next.refresh_token || token.refresh_token,
    scope: next.scope || token.scope,
  };
}

async function tokenRequest(
  client: OAuthClient,
  fields: Record<string, string>,
): Promise<StoredToken & { refresh_token: string }> {
  const res = await (client.fetch ?? fetch)(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...fields }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (body.error === "invalid_grant") {
      throw new ReconnectError(
        "Google rejected the saved login (expired or revoked). While your OAuth consent screen is in " +
          "'Testing' mode, logins expire after 7 days. Connect again (npm run auth, or Connect on the web app).",
      );
    }
    throw new Error(`Token request failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return {
    access_token: String(body.access_token),
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : "",
    expires_at: Date.now() + Number(body.expires_in ?? 3600) * 1000,
    scope: String(body.scope ?? ""),
  };
}

/** Serves the redirect on localhost and resolves with the authorization code. Exported for tests. */
export function waitForCode(port: number, expectedState: string, url: string, open: (url: string) => void = openBrowser): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for Google sign-in (5 minutes)."));
    }, 5 * 60_000);

    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (u.pathname !== "/oauth/callback") {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, message: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
        res.end(`<!doctype html><title>Sports Companion</title><body style="font:16px system-ui;padding:40px">${message}</body>`);
        clearTimeout(timer);
        server.close();
      };
      const error = u.searchParams.get("error");
      if (error) {
        finish(400, `Sign-in failed: ${escapeHtml(error)}. You can close this tab.`);
        reject(new Error(`Google sign-in failed: ${error}`));
      } else if (u.searchParams.get("state") !== expectedState) {
        finish(400, "Sign-in failed: state mismatch. Please run <code>npm run auth</code> again.");
        reject(new Error("OAuth state mismatch"));
      } else {
        finish(200, "Connected. You can close this tab and return to the terminal.");
        resolve(u.searchParams.get("code") ?? "");
      }
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't listen on port ${port} for the sign-in redirect: ${err.message}`));
    });
    server.listen(port, "localhost", () => {
      console.log(`\nOpen this link to connect your Google (Fitbit) account:\n\n${url}\n`);
      open(url);
    });
  });
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The link is printed above; opening it manually works too.
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
