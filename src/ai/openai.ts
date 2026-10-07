// AI insights through OpenAI's Responses API, kept cheap: a few hundred tokens of summary go in,
// a short answer comes out, nothing is stored at OpenAI, and every call's cost is counted.
// Models and prices: https://developers.openai.com/api/docs/models

export interface ModelInfo {
  id: string;
  label: string;
  /** US dollars per million tokens. */
  input: number;
  cachedInput: number;
  output: number;
  note: string;
}

// Prices as listed on 7 Oct 2026 (Sol's is a promotion running at least to 21 Nov 2026).
export const MODELS: ModelInfo[] = [
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", input: 0.2, cachedInput: 0.02, output: 1.2, note: "Cheapest, and plenty for match summaries" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", input: 2, cachedInput: 0.2, output: 12, note: "Sharper reading, about 10× the cost" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", input: 4, cachedInput: 0.4, output: 20, note: "Most capable, about 17× the cost" },
];
export const DEFAULT_MODEL = MODELS[0].id;

/** Unknown models are priced like the dearest known one, so the monthly budget still protects you. */
export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? { ...MODELS[MODELS.length - 1], id, label: id, note: "Custom model" };
}

export interface TokenCounts {
  input: number;
  /** Part of `input` served from OpenAI's prompt cache (billed at the cached rate). */
  cached: number;
  /** Includes the model's hidden reasoning tokens. */
  output: number;
  reasoning: number;
}

export function costUsd(model: string, t: TokenCounts): number {
  const m = modelInfo(model);
  return ((t.input - t.cached) * m.input + t.cached * m.cachedInput + t.output * m.output) / 1_000_000;
}

/** A typical insight (about 700 tokens in, 500 out including reasoning), for the price shown on the button. */
export function typicalCostUsd(model: string): number {
  return costUsd(model, { input: 700, cached: 0, output: 500, reasoning: 300 });
}

export interface AskOptions {
  apiKey: string;
  model: string;
  instructions: string;
  input: string;
  /** Includes reasoning tokens; the visible answer is far shorter. */
  maxOutputTokens?: number;
  fetch?: typeof fetch;
}

export interface Answer {
  text: string;
  /** False when the answer was cut off by the output limit. */
  complete: boolean;
  tokens: TokenCounts;
}

/** OpenAI refused or failed; `message` is meant for the user. */
export class AiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function ask(o: AskOptions): Promise<Answer> {
  const call = async (reasoning: boolean) => {
    const res = await (o.fetch ?? fetch)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: o.model,
        instructions: o.instructions,
        input: o.input,
        max_output_tokens: o.maxOutputTokens ?? 1200,
        // A little thinking is plenty for a summary, and thinking tokens are billed as output.
        ...(reasoning ? { reasoning: { effort: "low" } } : {}),
        // Health data: don't keep the conversation on OpenAI's side.
        store: false,
      }),
      signal: AbortSignal.timeout(50_000),
    });
    return { res, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  let { res, body } = await call(true);
  // Models without reasoning (a custom OPENAI_MODEL) reject the setting; ask again without it.
  if (res.status === 400 && /reasoning/i.test(String(body.error?.message ?? ""))) ({ res, body } = await call(false));
  if (!res.ok) {
    const err = (body.error ?? {}) as { message?: string; code?: string };
    let message = `OpenAI returned ${res.status}${err.message ? `: ${err.message}` : ""}`;
    if (res.status === 401) message = "OpenAI didn't accept the API key. Check OPENAI_API_KEY in your Vercel environment variables.";
    else if (err.code === "insufficient_quota") message = "Your OpenAI account is out of credit. Top it up at platform.openai.com (Settings → Billing).";
    else if (res.status === 429) message = "OpenAI is limiting requests right now. Try again in a minute.";
    else if (err.code === "model_not_found" || res.status === 404) message = `Your OpenAI account can't use "${o.model}". Pick another model in Settings.`;
    throw new AiError(message, res.status);
  }
  const text = ((body.output ?? []) as Record<string, any>[])
    .filter((item) => item.type === "message")
    .flatMap((item) => (item.content ?? []) as Record<string, any>[])
    .filter((c) => c.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
  const u = (body.usage ?? {}) as Record<string, any>;
  return {
    text,
    complete: body.status === "completed",
    tokens: {
      input: Number(u.input_tokens) || 0,
      cached: Number(u.input_tokens_details?.cached_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      reasoning: Number(u.output_tokens_details?.reasoning_tokens) || 0,
    },
  };
}
