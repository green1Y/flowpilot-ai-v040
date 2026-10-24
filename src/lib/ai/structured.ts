/**
 * Structured AI generation for the workflow copilot.
 *
 * Uses the same provider model as src/lib/ai/providers.ts:
 *   - AI_PROVIDER=openai + OPENAI_API_KEY  → real OpenAI-compatible chat API
 *   - anything else                        → AiNotConfiguredError (honest 503)
 *
 * The mock provider is deliberately NOT used here: generating a fake
 * workflow and presenting it as AI output would violate the honesty
 * boundary (never invent successful generations).
 */

export class AiNotConfiguredError extends Error {
  readonly code = "AI_PROVIDER_NOT_CONFIGURED";
  constructor() {
    super(
      "AI provider not configured — set OPENAI_API_KEY (and optionally AI_PROVIDER=openai, OPENAI_BASE_URL, AI_MODEL). See INTEGRATIONS_SETUP.md."
    );
    this.name = "AiNotConfiguredError";
  }
}

export class AiTimeoutError extends Error {
  readonly code = "AI_TIMEOUT";
  constructor() {
    super("The AI request timed out.");
    this.name = "AiTimeoutError";
  }
}

/** True when a real provider is configured (never the mock). */
export function isAiConfigured(): boolean {
  return (process.env.AI_PROVIDER || "mock") === "openai" && !!process.env.OPENAI_API_KEY;
}

export interface StructuredResult {
  /** Raw model output (expected JSON). */
  raw: string;
  /** Always false here — the mock provider is never used for copilot work. */
  mocked: false;
  model: string;
}

function baseUrl(): string {
  return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function model(): string {
  return process.env.AI_MODEL || "gpt-4o-mini";
}

async function postJson(
  systemPrompt: string,
  userMessage: string,
  opts: { jsonMode: boolean; timeoutMs: number }
): Promise<StructuredResult> {
  if (!isAiConfigured()) throw new AiNotConfiguredError();

  const body: Record<string, unknown> = {
    model: model(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.2,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      // AbortSignal.timeout: hard timeout on the AI call (no hanging requests).
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new AiTimeoutError();
    }
    throw e;
  }
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`AI provider error (${res.status}): ${snippet}`);
  }
  const json = await res.json();
  const raw: string = json.choices?.[0]?.message?.content ?? "";
  if (!raw.trim()) throw new Error("AI provider returned an empty response");
  return { raw, mocked: false, model: model() };
}

/**
 * Ask the AI for a JSON object (response_format: json_object).
 * Parses the envelope; schema validation happens in the caller.
 */
export async function generateStructuredJson(
  systemPrompt: string,
  userMessage: string,
  opts: { timeoutMs?: number } = {}
): Promise<StructuredResult> {
  return postJson(systemPrompt, userMessage, { jsonMode: true, timeoutMs: opts.timeoutMs ?? 45000 });
}

/** Ask the AI for free text (used by explain/diagnose/translate ops). */
export async function generateText(
  systemPrompt: string,
  userMessage: string,
  opts: { timeoutMs?: number } = {}
): Promise<StructuredResult> {
  return postJson(systemPrompt, userMessage, { jsonMode: false, timeoutMs: opts.timeoutMs ?? 45000 });
}
