// Bridges Node's http (what Vercel's Node.js functions and `npm run serve` provide) and the app's
// Web-standard Request/Response handler.
import type { IncomingMessage, ServerResponse } from "node:http";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "expect"]);

export function toNodeHandler(handle: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0].trim();
      const proto = first(req.headers["x-forwarded-proto"]) ?? "http";
      const host = first(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost";
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key)) continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
      }
      const chunks: Buffer[] = [];
      if (req.method !== "GET" && req.method !== "HEAD") for await (const chunk of req) chunks.push(chunk as Buffer);
      const response = await handle(
        new Request(`${proto}://${host}${req.url ?? "/"}`, {
          method: req.method,
          headers,
          body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
        }),
      );
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") res.setHeader(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader("set-cookie", cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  };
}
