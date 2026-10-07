// Signed cookies for the login session and the Google sign-in handshake.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface Signer {
  /** Signs a payload that expires after ttlSec. */
  seal(payload: Record<string, unknown>, ttlSec: number): string;
  /** The payload, or null if the value was tampered with or has expired. */
  open<T extends Record<string, unknown>>(value: string | undefined): T | null;
}

export function signer(secret: string, now: () => number = Date.now): Signer {
  const key = createHash("sha256").update(`performance-journal:${secret}`).digest();
  const mac = (s: string) => createHmac("sha256", key).update(s).digest("base64url");
  return {
    seal(payload, ttlSec) {
      const body = Buffer.from(JSON.stringify({ ...payload, exp: now() + ttlSec * 1000 })).toString("base64url");
      return `${body}.${mac(body)}`;
    },
    open<T extends Record<string, unknown>>(value: string | undefined): T | null {
      const [body, sig] = (value ?? "").split(".");
      if (!body || !sig || !sameText(sig, mac(body))) return null;
      try {
        const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
        return data.exp > now() ? data : null;
      } catch {
        return null;
      }
    },
  };
}

export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Constant-time password check (hashing first makes the lengths equal). */
export function passwordMatches(given: string, expected: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(given), h(expected));
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(name: string, value: string, opts: { maxAgeSec: number; secure: boolean }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${opts.maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
    opts.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}
