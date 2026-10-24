import { NODE_TYPES, type NodeDef } from "@/lib/workflows/nodeRegistry";

/**
 * Copilot prompt engineering + clarifying-question heuristics.
 *
 * The system prompt embeds the full registered node catalog (types, kinds,
 * config fields) so the model can only emit node types that genuinely exist.
 * Server-side validation (spec.ts) enforces this a second time.
 */

export interface ClarifyingQuestion {
  id: string;
  question: string;
  questionAr: string;
  hint?: string;
  hintAr?: string;
  /** Suggested quick-pick answers (optional). */
  options?: string[];
}

function schemaSummary(def: NodeDef): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = def.configSchema as any;
  if (raw?._def?.typeName !== "ZodObject" || typeof raw.shape !== "object") return "{}";
  const fields = Object.entries(raw.shape).map(([k, f]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fr = f as any;
    const tn = fr?._def?.typeName;
    const inner = tn === "ZodOptional" || tn === "ZodDefault" ? fr._def.innerType : fr;
    const itn = inner?._def?.typeName ?? "string";
    const optional = tn === "ZodOptional" || tn === "ZodDefault" ? "?" : "";
    let detail = itn.replace(/^Zod/, "").toLowerCase();
    if (itn === "ZodEnum") detail = `one of: ${(inner._def.values as string[]).join("|")}`;
    return `${k}${optional}: ${detail}`;
  });
  return `{ ${fields.join("; ")} }`;
}

/** Compact catalog text embedded in the generation system prompt. */
export function nodeCatalogText(): string {
  const lines: string[] = [];
  for (const def of Object.values(NODE_TYPES)) {
    lines.push(
      `- ${def.type} [${def.kind}] — ${def.label}: ${def.description} config ${schemaSummary(def)}`
    );
  }
  return lines.join("\n");
}

export function generationSystemPrompt(): string {
  return [
    "You are FlowPilot's workflow copilot. You design automation workflows as JSON.",
    "",
    "RULES (strict):",
    "1. Output ONLY a JSON object — no markdown, no prose.",
    "2. Use ONLY node types from the catalog below. Never invent a node type.",
    "3. Every node needs: id (unique short string), kind (must match the catalog kind), type, label, config (all required config fields filled with sensible values), x, y (canvas coordinates, flow left→right: trigger x=80, then +260 per step, y=120).",
    "4. edges: array of { sourceId, targetId, label }. Labels are \"\" except out of flow.if_else which MUST be \"true\" / \"false\".",
    "5. Every workflow MUST start with exactly one trigger node. Chain: trigger → conditions/flow → actions.",
    "6. condition.* nodes evaluate but do not branch — put flow.if_else when branching is needed.",
    "7. Prefer action.send_message with a concrete channel. For WhatsApp outside the 24h window use action.send_whatsapp_template.",
    "8. Keep workflows focused: 3–8 nodes. Fill config with concrete values from the user's answers (keywords, messages, tags).",
    "9. Template variables like {{name}}, {{text}} are allowed inside message bodies.",
    "",
    "RESPONSE SHAPE:",
    '{ "nodes": [ { "id": "t1", "kind": "trigger", "type": "trigger.new_message", "label": "New message", "config": {}, "x": 80, "y": 120 } ], "edges": [ { "sourceId": "t1", "targetId": "c1", "label": "" } ] }',
    "",
    "NODE CATALOG:",
    nodeCatalogText(),
  ].join("\n");
}

export function generationUserMessage(prompt: string, answers: Record<string, string>): string {
  const answerLines = Object.entries(answers)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `- ${k}: ${v}`);
  return [
    `User request: ${prompt}`,
    answerLines.length ? `Clarifying answers:\n${answerLines.join("\n")}` : "No clarifying answers provided.",
    "Generate the workflow JSON now.",
  ].join("\n\n");
}

// ── Clarifying questions ────────────────────────────────────────────────

const CHANNEL_WORDS: Record<string, string[]> = {
  instagram: ["instagram", " ig ", "insta", "إنستغرام", "انستقرام", "إنستا"],
  facebook: ["facebook", "messenger", "فيسبوك", "ماسنجر"],
  whatsapp: ["whatsapp", "واتساب", "واتس اب"],
  telegram: ["telegram", "تيليجرام", "تلغرام"],
  email: ["email", "e-mail", "بريد", "إيميل"],
  webchat: ["website", "webchat", "chat widget", "الموقع"],
};

const TRIGGER_WORDS: Array<[string, RegExp]> = [
  ["trigger", /comment|تعليق/i],
  ["trigger", /keyword|كلمة/i],
  ["trigger", /schedul|daily|every morning|يومي|مجدول/i],
  ["trigger", /new lead|عميل جديد/i],
  ["trigger", /order|طلب/i],
];

const CONTENT_WORDS = /say|send|message|reply|respond|answer|notify|remind|follow.?up|tag|assign|note|يقول|أرسل|ارسل|رد|رسالة|تذكير|متابعة/i;

/**
 * Heuristic: does the prompt carry enough to generate a good workflow?
 * Returns questions when the goal, channel, trigger, or message content
 * is missing. Pure function — unit-testable, no AI needed.
 */
export function clarificationQuestions(
  prompt: string,
  locale: "en" | "ar" = "en"
): ClarifyingQuestion[] | null {
  const p = ` ${prompt.toLowerCase()} `;
  const questions: ClarifyingQuestion[] = [];

  const hasChannel = Object.values(CHANNEL_WORDS).some((words) =>
    words.some((w) => p.includes(w.toLowerCase()))
  );
  if (!hasChannel) {
    questions.push({
      id: "channel",
      question: "Which channel should this run on?",
      questionAr: "على أي قناة يجب أن يعمل سير العمل؟",
      hint: "e.g. Instagram, WhatsApp, Facebook, email",
      hintAr: "مثال: إنستغرام، واتساب، فيسبوك، بريد إلكتروني",
      options: ["instagram", "facebook", "whatsapp", "telegram", "email", "webchat"],
    });
  }

  const hasTrigger = TRIGGER_WORDS.some(([, re]) => re.test(prompt)) || /message|رسالة/i.test(prompt);
  if (!hasTrigger) {
    questions.push({
      id: "trigger",
      question: "What should start this workflow?",
      questionAr: "ما الذي يجب أن يبدأ سير العمل؟",
      hint: "e.g. a new message, a comment with a keyword, a new lead, a schedule",
      hintAr: "مثال: رسالة جديدة، تعليق بكلمة مفتاحية، عميل جديد، جدول زمني",
      options: ["new_message", "new_comment", "keyword", "new_lead", "scheduled"],
    });
  }

  if (!CONTENT_WORDS.test(prompt)) {
    questions.push({
      id: "content",
      question: "What should the workflow do? (the message to send, the tag to add, who to notify…)",
      questionAr: "ماذا يجب أن يفعل سير العمل؟ (الرسالة المراد إرسالها، الوسم المراد إضافته، من يتم إشعاره…)",
      hint: "Write the actual message text or action you want.",
      hintAr: "اكتب نص الرسالة الفعلي أو الإجراء المطلوب.",
    });
  }

  // Very short prompts almost always need more.
  if (prompt.trim().length < 24 && questions.length === 0) {
    questions.push({
      id: "goal",
      question: "Can you describe the goal in one more sentence?",
      questionAr: "هل يمكنك وصف الهدف بجملة إضافية؟",
    });
  }

  void locale;
  return questions.length > 0 ? questions : null;
}

// ── Op prompts (explain / diagnose / translate / add-step) ──────────────

export interface WorkflowSummary {
  name: string;
  status: string;
  nodes: Array<{ id: string; kind: string; type: string; label: string; config: Record<string, unknown> }>;
  edges: Array<{ sourceId: string; targetId: string; label: string }>;
}

export function workflowSummaryText(w: WorkflowSummary): string {
  const nodeById = new Map(w.nodes.map((n) => [n.id, n]));
  const lines = w.nodes.map((n) => {
    const outs = w.edges
      .filter((e) => e.sourceId === n.id)
      .map((e) => `→ ${nodeById.get(e.targetId)?.label ?? e.targetId}${e.label ? ` [${e.label}]` : ""}`);
    const cfg = Object.entries(n.config ?? {})
      .filter(([, v]) => v !== "" && v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    return `- ${n.label} (${n.type}${cfg ? `; ${cfg}` : ""})${outs.length ? ` ${outs.join(" ")}` : ""}`;
  });
  return `Workflow "${w.name}" [${w.status}]:\n${lines.join("\n")}`;
}

export function explainSystemPrompt(ar: boolean): string {
  return ar
    ? "أنت مساعد FlowPilot. اشرح سير العمل التالي باللغة العربية الفصحى المبسطة: ماذا يفعل، متى يبدأ، وما الخطوات بالترتيب. كن موجزًا وواضحًا. أجب كنص عادي."
    : "You are FlowPilot's assistant. Explain the following workflow in plain language: what it does, when it starts, and each step in order. Be concise. Answer as plain text.";
}

export function diagnoseSystemPrompt(ar: boolean): string {
  return ar
    ? "أنت خبير تشخيص أعطال FlowPilot. بالنظر إلى ملخص سير العمل وآخر تشغيل فاشل، اشرح بالعربية: ما الخطوة التي فشلت، والسبب المحتمل، وخطوات الإصلاح المقترحة. كن عمليًا وموجزًا. أجب كنص عادي."
    : "You are FlowPilot's failure-diagnosis expert. Given the workflow summary and its last failed execution, explain: which step failed, the likely cause, and concrete fix steps. Be practical and concise. Answer as plain text.";
}

export function addStepSystemPrompt(): string {
  return [
    generationSystemPrompt(),
    "",
    "ADD-STEP MODE: the user wants to ADD nodes to an existing workflow (described below).",
    "Output a JSON object with ONLY the new nodes/edges to append:",
    '{ "nodes": [ ...new nodes with fresh ids n_new_1, ... ], "edges": [ { "sourceId": "<existing or new id>", "targetId": "<new id>", "label": "" } ] }',
    "Use the existing node ids given in the workflow summary as attachment points.",
  ].join("\n");
}

export function translateSystemPrompt(toAr: boolean): string {
  return [
    "You translate workflow node labels and descriptions between English and Arabic.",
    toAr ? "Translate every label/description to Arabic." : "Translate every label/description to English.",
    "Output ONLY JSON: { \"labels\": { \"<nodeId>\": \"<translated label>\" } }.",
    "Keep node ids exactly as given. Do not change anything else.",
  ].join("\n");
}
