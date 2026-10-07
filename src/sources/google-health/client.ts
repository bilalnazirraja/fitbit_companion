// Minimal REST client for the Google Health API (successor to the Fitbit Web API).
// Docs: https://developers.google.com/health/reference/rest
export const BASE_URL = "https://health.googleapis.com/v4/users/me";

export type DataPoint = Record<string, unknown> & { name?: string };

export interface ClientOptions {
  /** Returns a valid access token; forceRefresh after a 401. */
  getAccessToken: (forceRefresh?: boolean) => Promise<string>;
  fetch?: typeof fetch;
  /** Called with every raw page, so responses can be archived as-is. */
  onPage?: (dataType: string, filter: string, page: number, body: unknown) => void;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GoogleHealthClient {
  /** GET .../dataTypes/{dataType}/dataPoints, following nextPageToken until done. */
  listAll(dataType: string, filter: string, pageSize: number): Promise<DataPoint[]>;
}

export class GoogleHealthError extends Error {
  status: number;
  constructor(status: number, body: string, url: string) {
    const hint =
      status === 403
        ? "\nCheck that the Google Health API is enabled in your Cloud project, that you ticked every permission on the consent screen, and that your Fitbit account has been moved to your Google account."
        : status === 400
          ? "\nThe API rejected the request (often the filter). See https://developers.google.com/health/filters"
          : "";
    super(`Google Health API returned ${status} for ${url}\n${body.slice(0, 600)}${hint}`);
    this.status = status;
  }
}

export function createClient(opts: ClientOptions): GoogleHealthClient {
  const doFetch = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function get(url: string): Promise<{ dataPoints?: DataPoint[]; nextPageToken?: string }> {
    let token = await opts.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      if (res.ok) return (await res.json()) as { dataPoints?: DataPoint[]; nextPageToken?: string };
      if (res.status === 401 && !refreshed) {
        token = await opts.getAccessToken(true);
        refreshed = true;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new GoogleHealthError(res.status, await res.text(), url);
    }
  }

  return {
    async listAll(dataType, filter, pageSize) {
      const out: DataPoint[] = [];
      let pageToken = "";
      for (let page = 0; page < 1000; page++) {
        const params = new URLSearchParams({ filter, pageSize: String(pageSize) });
        if (pageToken) params.set("pageToken", pageToken);
        const body = await get(`${BASE_URL}/dataTypes/${dataType}/dataPoints?${params}`);
        opts.onPage?.(dataType, filter, page, body);
        out.push(...(body.dataPoints ?? []));
        pageToken = body.nextPageToken ?? "";
        if (!pageToken) return out;
      }
      throw new Error(`Stopped paging ${dataType} after 1000 pages`);
    },
  };
}
