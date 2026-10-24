import { z } from "zod";

/**
 * Workflow node registry — the single source of truth for every node type
 * the builder, validator, templates, and engine understand.
 *
 * A node type id is namespaced by kind: `trigger.*`, `condition.*`,
 * `action.*`, `flow.*`. The validator checks `config` against
 * `configSchema`; the engine dispatches on `type`.
 */

export type NodeKind = "trigger" | "condition" | "action" | "flow";

export interface NodeDef {
  type: string;
  kind: NodeKind;
  label: string;
  description: string;
  /** Lucide icon name (string — the builder resolves it to a component). */
  icon: string;
  category: string;
  configSchema: z.ZodType;
  defaults: Record<string, unknown>;
  requiredPermissions: string[];
}

/** Channels the mock adapters can "send" through (all sends are simulated). */
export const SUPPORTED_CHANNELS = [
  "instagram",
  "facebook",
  "whatsapp",
  "telegram",
  "webchat",
  "email",
] as const;

export type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];

function def(d: NodeDef): NodeDef {
  return d;
}

const noConfig = z.object({});

export const NODE_TYPES: Record<string, NodeDef> = {
  // ── Triggers ──────────────────────────────────────────────────────────
  "trigger.new_message": def({
    type: "trigger.new_message",
    kind: "trigger",
    label: "New message",
    description: "Fires when an inbound message arrives on any connected channel.",
    icon: "MessageSquare",
    category: "Triggers",
    configSchema: noConfig,
    defaults: {},
    requiredPermissions: [],
  }),
  "trigger.new_comment": def({
    type: "trigger.new_comment",
    kind: "trigger",
    label: "New comment",
    description: "Fires when someone comments on your post or video.",
    icon: "MessageCircle",
    category: "Triggers",
    configSchema: noConfig,
    defaults: {},
    requiredPermissions: [],
  }),
  "trigger.new_conversation": def({
    type: "trigger.new_conversation",
    kind: "trigger",
    label: "New conversation",
    description: "Fires when a new conversation thread is opened.",
    icon: "MessagesSquare",
    category: "Triggers",
    configSchema: noConfig,
    defaults: {},
    requiredPermissions: [],
  }),
  "trigger.new_lead": def({
    type: "trigger.new_lead",
    kind: "trigger",
    label: "New lead",
    description: "Fires when a new lead/contact is created in the CRM.",
    icon: "UserPlus",
    category: "Triggers",
    configSchema: noConfig,
    defaults: {},
    requiredPermissions: [],
  }),
  "trigger.keyword": def({
    type: "trigger.keyword",
    kind: "trigger",
    label: "Keyword trigger",
    description: "Fires when an inbound message contains a specific keyword.",
    icon: "Hash",
    category: "Triggers",
    configSchema: z.object({ keyword: z.string().min(1).max(120) }),
    defaults: { keyword: "" },
    requiredPermissions: [],
  }),
  "trigger.tag_added": def({
    type: "trigger.tag_added",
    kind: "trigger",
    label: "Tag added",
    description: "Fires when a tag is added to a contact.",
    icon: "Tag",
    category: "Triggers",
    configSchema: z.object({ tag: z.string().min(1).max(60) }),
    defaults: { tag: "" },
    requiredPermissions: [],
  }),
  "trigger.scheduled": def({
    type: "trigger.scheduled",
    kind: "trigger",
    label: "Scheduled",
    description: "Fires on a cron schedule (e.g. daily follow-ups).",
    icon: "Clock",
    category: "Triggers",
    configSchema: z.object({
      cron: z.string().min(1).max(120),
      timezone: z.string().min(1).max(80).default("UTC"),
    }),
    defaults: { cron: "0 9 * * *", timezone: "UTC" },
    requiredPermissions: [],
  }),
  "trigger.webhook": def({
    type: "trigger.webhook",
    kind: "trigger",
    label: "Webhook",
    description: "Fires when an external system calls this workflow's webhook URL.",
    icon: "Webhook",
    category: "Triggers",
    configSchema: z.object({ secret: z.string().max(200).default("") }),
    defaults: { secret: "" },
    requiredPermissions: [],
  }),
  "trigger.commerce_event": def({
    type: "trigger.commerce_event",
    kind: "trigger",
    label: "Commerce event",
    description: "Fires on a commerce event such as order_created or payment_failed.",
    icon: "ShoppingCart",
    category: "Triggers",
    configSchema: z.object({ eventName: z.string().min(1).max(80) }),
    defaults: { eventName: "order_created" },
    requiredPermissions: [],
  }),
  "trigger.manual": def({
    type: "trigger.manual",
    kind: "trigger",
    label: "Manual",
    description: "Fires only when launched manually from the dashboard or API.",
    icon: "Play",
    category: "Triggers",
    configSchema: noConfig,
    defaults: {},
    requiredPermissions: [],
  }),

  // ── Conditions ────────────────────────────────────────────────────────
  "condition.keyword_contains": def({
    type: "condition.keyword_contains",
    kind: "condition",
    label: "Message contains keyword",
    description: "True when the inbound text contains the keyword (case-insensitive).",
    icon: "Search",
    category: "Conditions",
    configSchema: z.object({ keyword: z.string().min(1).max(120) }),
    defaults: { keyword: "" },
    requiredPermissions: [],
  }),
  "condition.comment_matches": def({
    type: "condition.comment_matches",
    kind: "condition",
    label: "Comment matches phrase",
    description: "True when the comment equals or contains the phrase.",
    icon: "Quote",
    category: "Conditions",
    configSchema: z.object({ phrase: z.string().min(1).max(200) }),
    defaults: { phrase: "" },
    requiredPermissions: [],
  }),
  "condition.is_new_contact": def({
    type: "condition.is_new_contact",
    kind: "condition",
    label: "Is new contact",
    description: "True when the sender has never contacted you before.",
    icon: "Sparkles",
    category: "Conditions",
    configSchema: noConfig,
    defaults: {},
    requiredPermissions: [],
  }),
  "condition.has_tag": def({
    type: "condition.has_tag",
    kind: "condition",
    label: "Contact has tag",
    description: "True when the contact carries the given tag.",
    icon: "Tags",
    category: "Conditions",
    configSchema: z.object({ tag: z.string().min(1).max(60) }),
    defaults: { tag: "" },
    requiredPermissions: [],
  }),
  "condition.lead_score_gte": def({
    type: "condition.lead_score_gte",
    kind: "condition",
    label: "Lead score ≥",
    description: "True when the contact's lead score meets the threshold.",
    icon: "Gauge",
    category: "Conditions",
    configSchema: z.object({ score: z.number().int().min(0).max(100) }),
    defaults: { score: 50 },
    requiredPermissions: [],
  }),
  "condition.channel_is": def({
    type: "condition.channel_is",
    kind: "condition",
    label: "Channel is",
    description: "True when the event arrived on the given channel.",
    icon: "Filter",
    category: "Conditions",
    configSchema: z.object({
      channel: z.string().min(1).refine((c) => (SUPPORTED_CHANNELS as readonly string[]).includes(c), {
        message: `channel not supported — must be one of: ${SUPPORTED_CHANNELS.join(", ")}`,
      }),
    }),
    defaults: { channel: "instagram" },
    requiredPermissions: [],
  }),
  "condition.business_hours": def({
    type: "condition.business_hours",
    kind: "condition",
    label: "Within business hours",
    description: "True when the event arrives inside the configured windows.",
    icon: "CalendarClock",
    category: "Conditions",
    configSchema: z.object({
      timezone: z.string().min(1).max(80).default("UTC"),
      windows: z
        .array(
          z.object({
            day: z.number().int().min(0).max(6),
            start: z.string().min(1).max(8),
            end: z.string().min(1).max(8),
          })
        )
        .default([]),
    }),
    defaults: { timezone: "UTC", windows: [] },
    requiredPermissions: [],
  }),
  "condition.ai_intent": def({
    type: "condition.ai_intent",
    kind: "condition",
    label: "AI intent is",
    description: "True when the classified intent matches (mock: event.intent).",
    icon: "Brain",
    category: "Conditions",
    configSchema: z.object({ intent: z.string().min(1).max(80) }),
    defaults: { intent: "pricing" },
    requiredPermissions: [],
  }),
  "condition.qualification_rule": def({
    type: "condition.qualification_rule",
    kind: "condition",
    label: "Qualification rule",
    description: "True when the named qualification rule passed for this lead.",
    icon: "BadgeCheck",
    category: "Conditions",
    configSchema: z.object({ rule: z.string().min(1).max(80) }),
    defaults: { rule: "budget_confirmed" },
    requiredPermissions: [],
  }),

  // ── Actions ───────────────────────────────────────────────────────────
  "action.send_message": def({
    type: "action.send_message",
    kind: "action",
    label: "Send message",
    description: "Send a text message on a channel (simulated until provider is connected).",
    icon: "Send",
    category: "Messaging",
    configSchema: z.object({
      channel: z.string().min(1).refine((c) => (SUPPORTED_CHANNELS as readonly string[]).includes(c), {
        message: `channel not supported — must be one of: ${SUPPORTED_CHANNELS.join(", ")}`,
      }),
      body: z.string().min(1).max(4000),
      integrationId: z.string().max(64).default(""),
    }),
    defaults: { channel: "instagram", body: "Hi {{name}}! Thanks for reaching out.", integrationId: "" },
    requiredPermissions: ["messages:send"],
  }),
  "action.reply_comment": def({
    type: "action.reply_comment",
    kind: "action",
    label: "Reply to comment",
    description: "Post a public reply to the triggering comment (simulated).",
    icon: "Reply",
    category: "Messaging",
    configSchema: z.object({ body: z.string().min(1).max(2000), integrationId: z.string().max(64).default("") }),
    defaults: { body: "Thanks for your comment! We've sent you a DM with details.", integrationId: "" },
    requiredPermissions: ["messages:send"],
  }),
  "action.ai_reply": def({
    type: "action.ai_reply",
    kind: "action",
    label: "AI reply",
    description: "Generate a reply with the AI assistant (mock by default).",
    icon: "Bot",
    category: "Messaging",
    configSchema: z.object({
      confidenceThreshold: z.number().min(0).max(1).default(0.7),
      integrationId: z.string().max(64).default(""),
    }),
    defaults: { confidenceThreshold: 0.7, integrationId: "" },
    requiredPermissions: ["messages:send", "ai:generate"],
  }),
  "action.add_tag": def({
    type: "action.add_tag",
    kind: "action",
    label: "Add tag",
    description: "Add a tag to the contact in the CRM.",
    icon: "Tag",
    category: "CRM",
    configSchema: z.object({ tag: z.string().min(1).max(60) }),
    defaults: { tag: "" },
    requiredPermissions: ["crm:write"],
  }),
  "action.update_crm_field": def({
    type: "action.update_crm_field",
    kind: "action",
    label: "Update CRM field",
    description: "Write a value into a contact's custom field.",
    icon: "PenLine",
    category: "CRM",
    configSchema: z.object({
      field: z.string().min(1).max(80),
      value: z.string().max(500).default(""),
    }),
    defaults: { field: "", value: "" },
    requiredPermissions: ["crm:write"],
  }),
  "action.assign_conversation": def({
    type: "action.assign_conversation",
    kind: "action",
    label: "Assign conversation",
    description: "Assign the conversation to a teammate or queue.",
    icon: "UserCheck",
    category: "Team",
    configSchema: z.object({ assignee: z.string().min(1).max(120) }),
    defaults: { assignee: "sales" },
    requiredPermissions: ["conversations:assign"],
  }),
  "action.create_lead": def({
    type: "action.create_lead",
    kind: "action",
    label: "Create lead",
    description: "Create a new lead/contact in the CRM.",
    icon: "UserPlus",
    category: "CRM",
    configSchema: z.object({ name: z.string().min(1).max(120) }),
    defaults: { name: "New Lead" },
    requiredPermissions: ["crm:write"],
  }),
  "action.internal_note": def({
    type: "action.internal_note",
    kind: "action",
    label: "Internal note",
    description: "Leave an internal note on the conversation for the team.",
    icon: "StickyNote",
    category: "Team",
    configSchema: z.object({ note: z.string().min(1).max(2000) }),
    defaults: { note: "" },
    requiredPermissions: ["conversations:write"],
  }),
  "action.wait": def({
    type: "action.wait",
    kind: "action",
    label: "Wait",
    description: "Pause the workflow for a number of seconds before continuing.",
    icon: "Timer",
    category: "Flow control",
    configSchema: z.object({ seconds: z.number().int().min(1).max(86400) }),
    defaults: { seconds: 300 },
    requiredPermissions: [],
  }),
  "action.send_email": def({
    type: "action.send_email",
    kind: "action",
    label: "Send email",
    description: "Send an email. Requires a CONNECTED email integration, otherwise an approval is requested.",
    icon: "Mail",
    category: "Messaging",
    configSchema: z.object({
      to: z.string().min(1).max(200),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(8000),
      integrationId: z.string().max(64).default(""),
    }),
    defaults: { to: "{{email}}", subject: "", body: "", integrationId: "" },
    requiredPermissions: ["messages:send"],
  }),
  "action.send_whatsapp_template": def({
    type: "action.send_whatsapp_template",
    kind: "action",
    label: "Send WhatsApp template",
    description: "Send a pre-approved WhatsApp template. Requires a CONNECTED WhatsApp integration.",
    icon: "MessageSquareText",
    category: "Messaging",
    configSchema: z.object({
      templateName: z.string().min(1).max(120),
      params: z.array(z.string()).default([]),
      integrationId: z.string().max(64).default(""),
    }),
    defaults: { templateName: "", params: [], integrationId: "" },
    requiredPermissions: ["messages:send"],
  }),
  "action.call_webhook": def({
    type: "action.call_webhook",
    kind: "action",
    label: "Call webhook",
    description: "Notify an external URL. Simulated in this build — no real request is made.",
    icon: "Webhook",
    category: "Integrations",
    configSchema: z.object({ url: z.string().url().max(500), integrationId: z.string().max(64).default("") }),
    defaults: { url: "https://example.com/webhook", integrationId: "" },
    requiredPermissions: ["integrations:invoke"],
  }),
  "action.notify_team": def({
    type: "action.notify_team",
    kind: "action",
    label: "Notify team",
    description: "Write an audit-log entry to notify the team (in-app notification).",
    icon: "Bell",
    category: "Team",
    configSchema: z.object({ message: z.string().min(1).max(1000) }),
    defaults: { message: "" },
    requiredPermissions: ["team:notify"],
  }),
  "action.request_approval": def({
    type: "action.request_approval",
    kind: "action",
    label: "Request approval",
    description: "Pause and ask a human to approve before continuing. Stops the run.",
    icon: "ShieldCheck",
    category: "Team",
    configSchema: z.object({ instructions: z.string().min(1).max(2000) }),
    defaults: { instructions: "" },
    requiredPermissions: ["approvals:request"],
  }),
  "action.end": def({
    type: "action.end",
    kind: "action",
    label: "End",
    description: "Stop this branch of the workflow.",
    icon: "Ban",
    category: "Flow control",
    configSchema: noConfig,
    defaults: {},
    requiredPermissions: [],
  }),

  // ── Flow control ──────────────────────────────────────────────────────
  "flow.if_else": def({
    type: "flow.if_else",
    kind: "flow",
    label: "If / Else",
    description: "Branch on a simple expression, e.g. `leadScore >= 50` or `text includes price`.",
    icon: "GitBranch",
    category: "Flow control",
    configSchema: z.object({ expression: z.string().min(1).max(500) }),
    defaults: { expression: "leadScore >= 50" },
    requiredPermissions: [],
  }),
  "flow.delay": def({
    type: "flow.delay",
    kind: "flow",
    label: "Delay",
    description: "Delay continuation by a number of seconds (scheduled, no busy-wait).",
    icon: "Hourglass",
    category: "Flow control",
    configSchema: z.object({ seconds: z.number().int().min(1).max(86400) }),
    defaults: { seconds: 60 },
    requiredPermissions: [],
  }),
  "flow.retry": def({
    type: "flow.retry",
    kind: "flow",
    label: "Retry",
    description: "Mark the following steps as retryable up to N attempts on failure.",
    icon: "RotateCcw",
    category: "Flow control",
    configSchema: z.object({ maxAttempts: z.number().int().min(1).max(10).default(3) }),
    defaults: { maxAttempts: 3 },
    requiredPermissions: [],
  }),
  "flow.timeout": def({
    type: "flow.timeout",
    kind: "flow",
    label: "Timeout",
    description: "Bound how long the following steps may take (informational in this build).",
    icon: "AlarmClock",
    category: "Flow control",
    configSchema: z.object({ seconds: z.number().int().min(1).max(3600) }),
    defaults: { seconds: 30 },
    requiredPermissions: [],
  }),
  "flow.dedupe": def({
    type: "flow.dedupe",
    kind: "flow",
    label: "Dedupe",
    description: "Skip the branch if this key was already seen in the current run. Supports {{placeholders}}.",
    icon: "Fingerprint",
    category: "Flow control",
    configSchema: z.object({ key: z.string().min(1).max(200) }),
    defaults: { key: "{{from}}-{{type}}" },
    requiredPermissions: [],
  }),
  "flow.error_branch": def({
    type: "flow.error_branch",
    kind: "flow",
    label: "Error branch",
    description: "Route failures here. Pass-through marker in this build.",
    icon: "TriangleAlert",
    category: "Flow control",
    configSchema: noConfig,
    defaults: {},
    requiredPermissions: [],
  }),
  "flow.end": def({
    type: "flow.end",
    kind: "flow",
    label: "End flow",
    description: "Terminate this branch of the workflow.",
    icon: "Flag",
    category: "Flow control",
    configSchema: noConfig,
    defaults: {},
    requiredPermissions: [],
  }),
};

/** Map a trigger node type to the `event.type` string it listens for. */
export const TRIGGER_EVENT_MAP: Record<string, string> = {
  "trigger.new_message": "new_message",
  "trigger.new_comment": "new_comment",
  "trigger.new_conversation": "new_conversation",
  "trigger.new_lead": "new_lead",
  "trigger.keyword": "new_message",
  "trigger.tag_added": "tag_added",
  "trigger.scheduled": "scheduled",
  "trigger.webhook": "webhook",
  "trigger.commerce_event": "commerce_event",
  "trigger.manual": "manual",
};

/** Node types grouped by kind, for the builder palette. */
export function nodeTypesByKind(): Record<NodeKind, NodeDef[]> {
  const kinds: NodeKind[] = ["trigger", "condition", "action", "flow"];
  const out = {} as Record<NodeKind, NodeDef[]>;
  for (const k of kinds) out[k] = Object.values(NODE_TYPES).filter((d) => d.kind === k);
  return out;
}
