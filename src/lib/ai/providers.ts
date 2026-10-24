/**
 * AI provider abstraction (ARCHITECTURE.md).
 * "mock" for local dev/tests — deterministic, clearly labeled.
 * "openai" uses an OpenAI-compatible chat API; requires OPENAI_API_KEY.
 */

export interface AiGenerateInput {
  systemPrompt: string;
  userMessage: string;
  knowledgeSnippets?: string[];
  tone?: string;
  responseLength?: string;
}

export interface AiGenerateOutput {
  text: string;
  confidence: number;
  mocked: boolean;
  sourcesUsed: string[];
}

const MOCK_REPLIES: Record<string, string> = {
  pricing: "Our pricing depends on the plan you choose — Starter, Growth, or Agency. I can walk you through what each includes if you'd like.",
  shipping: "Standard shipping takes 3–5 business days. Express options are available at checkout.",
  refund: "We offer a 30-day return window for unused items in original packaging.",
  default: "Thanks for your message! Based on what you've shared, here's what I can help with — could you tell me a little more so I give you the right answer?",
};

export async function generateReply(input: AiGenerateInput): Promise<AiGenerateOutput> {
  const provider = process.env.AI_PROVIDER || "mock";
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return generateWithOpenAI(input);
  }
  return generateMock(input);
}

function pickMockReply(text: string): string {
  const lower = text.toLowerCase();
  for (const [key, reply] of Object.entries(MOCK_REPLIES)) {
    if (key !== "default" && lower.includes(key)) return reply;
  }
  return MOCK_REPLIES.default;
}

async function generateMock(input: AiGenerateInput): Promise<AiGenerateOutput> {
  await new Promise((r) => setTimeout(r, 150));
  const text = pickMockReply(input.userMessage);
  return {
    text: `[mock AI] ${text}`,
    confidence: 0.62,
    mocked: true,
    sourcesUsed: input.knowledgeSnippets?.slice(0, 2) ?? [],
  };
}

async function generateWithOpenAI(input: AiGenerateInput): Promise<AiGenerateOutput> {
  // Stage 4c: actually include the retrieved knowledge snippets in the prompt —
  // the system prompt's anti-invention rules only work if the snippets are present.
  const knowledgeBlock =
    input.knowledgeSnippets && input.knowledgeSnippets.length > 0
      ? `\n\n[Knowledge snippets from the business's knowledge base — use these as your facts:]\n${input.knowledgeSnippets
          .map((s, i) => `${i + 1}. ${s}`)
          .join("\n")}`
      : `\n\n[No knowledge snippets were found for this question. Follow the system prompt's no-information rule.]`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userMessage + knowledgeBlock },
      ],
      temperature: 0.4,
      max_tokens: input.responseLength === "detailed" ? 600 : 220,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AI provider error (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const text: string = json.choices?.[0]?.message?.content ?? "";
  return { text, confidence: 0.85, mocked: false, sourcesUsed: input.knowledgeSnippets ?? [] };
}

/** Build the system prompt from an AiConfig row (parsed JSON fields). */
export function buildSystemPrompt(cfg: {
  assistantName: string;
  businessName: string;
  businessDescription: string;
  brandVoice: string;
  tone: string;
  responseLength: string;
  fallbackResponse: string;
  prohibitedTopics: string[];
}): string {
  return [
    `You are ${cfg.assistantName}, the AI assistant for ${cfg.businessName || "the business"}.`,
    cfg.businessDescription ? `Business: ${cfg.businessDescription}` : "",
    `Voice: ${cfg.brandVoice}. Tone: ${cfg.tone}. Keep replies ${cfg.responseLength}.`,
    "Answer ONLY from the knowledge snippets provided with the question. They are the business's approved facts — do not go beyond them.",
    "If the answer is not in the snippets, say you don't have that information and use the fallback response verbatim. Never guess.",
    "NEVER invent prices, availability, shipping times, discounts, or policies. If a number or policy is not stated in the snippets, it does not exist — say so.",
    "Ask clarifying questions when the request is ambiguous. Detect buying intent and complaints; escalate complaints.",
    cfg.prohibitedTopics.length ? `Never discuss: ${cfg.prohibitedTopics.join(", ")}.` : "",
    `If you cannot answer confidently, reply exactly: "${cfg.fallbackResponse}"`,
  ]
    .filter(Boolean)
    .join("\n");
}
