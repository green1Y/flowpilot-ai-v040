/**
 * Phase B — Retargeting Center: audience segment condition evaluator.
 *
 * AudienceSegment.conditions stores a condition tree:
 *   { op: "and" | "or", rules: [...] }
 * where each rule is either a nested group or a leaf:
 *   { field: "tag", operator: "contains", value: "vip" }
 *   { field: "lastInboundAt", operator: "older_than_days", value: 30 }
 *
 * The evaluator is split into two layers:
 *  - PURE: evaluateConditionGroup(ctx, tree) — no database access, fully
 *    unit-testable. ContactFactContext carries every fact a rule can read.
 *  - DB: resolveSegmentContacts(workspaceId, tree) — aggregates per-contact
 *    facts from Contact / Conversation / Message / ContactOrder / Suppression
 *    and returns the matching contact contexts.
 *
 * Honesty rules (see PROVIDER_AVAILABILITY): a rule can only match on data
 * FlowPilot actually stores. Meta platforms do not expose purchase history
 * or cart state, so purchaseCount/abandonedCart only resolve when a store
 * adapter (Shopify/custom) or an import wrote ContactOrder rows /
 * contact.customFields — otherwise they match nobody and the preview UI
 * warns about it.
 */

import { db } from "../db";

export type ConditionOp = "and" | "or";

export interface ConditionRule {
  field: string;
  operator: string;
  value?: unknown;
}

export interface ConditionGroup {
  op: ConditionOp;
  rules: Array<ConditionRule | ConditionGroup>;
}

/** Every fact a segment rule is allowed to read about one contact. */
export interface ContactFactContext {
  contactId: string;
  name: string;
  channel: string;
  leadStatus: string;
  tags: string[];
  email: string | null;
  phone: string | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  /** Inbound (customer → us) message count across all conversations. */
  messageCount: number;
  /** ContactOrder rows for this contact. */
  purchaseCount: number;
  /**
   * true when contact.customFields.abandonedCart === true or a "cart-abandoned"
   * tag is present. Written by a connected store adapter or by imports —
   * Meta messaging platforms do not expose cart data.
   */
  abandonedCart: boolean;
  /** true when a Suppression row exists for this contact (any channel). */
  optedOut: boolean;
}

export interface SegmentMatchResult {
  count: number;
  contacts: ContactFactContext[];
}

/**
 * Honest per-field data-availability labels. Shown in the segment builder and
 * the preview API so nobody assumes a platform exposes data it doesn't.
 */
export const PROVIDER_AVAILABILITY: Record<string, string> = {
  tag: "First-party data — set by your team, workflows, or imports. Works everywhere.",
  channel:
    "First-party data — the channel a contact first appeared on. Works everywhere.",
  leadStatus:
    "First-party data — your CRM pipeline stage. Works everywhere.",
  lastInboundAt:
    "Driven by inbound events: Instagram + Facebook (DM/comment webhooks) and WhatsApp (message webhooks). Contacts with no inbound activity have no timestamp.",
  messageCount:
    "Counted from inbound messages stored by FlowPilot. Only channels with connected, receiving integrations accumulate history.",
  purchaseCount:
    "ContactOrder rows only — requires a connected store (Shopify/custom adapter) or imported orders. Meta platforms do not expose purchase history.",
  abandonedCart:
    "Connected store (Shopify/custom adapter) only — set via contact.customFields.abandonedCart or the cart-abandoned tag. Meta platforms do not expose cart data.",
  optedOut:
    "Your workspace suppression list — respected on every send, everywhere.",
  email: "First-party data — works everywhere.",
  phone: "First-party data — works everywhere.",
};

/** Fields a rule may reference, with a one-line description for the UI. */
export const SEGMENT_FIELDS: Array<{ field: string; label: string; operators: string[] }> = [
  { field: "tag", label: "Contact tag", operators: ["contains", "not_contains"] },
  { field: "channel", label: "Source channel", operators: ["eq", "neq"] },
  { field: "leadStatus", label: "Lead status", operators: ["eq", "neq"] },
  { field: "lastInboundAt", label: "Last inbound message", operators: ["older_than_days", "newer_than_days"] },
  { field: "messageCount", label: "Inbound message count", operators: ["eq", "neq", "gt", "gte", "lt", "lte"] },
  { field: "purchaseCount", label: "Purchase count", operators: ["eq", "neq", "gt", "gte", "lt", "lte"] },
  { field: "abandonedCart", label: "Abandoned cart", operators: ["is_true", "is_false"] },
  { field: "optedOut", label: "Opted out", operators: ["is_true", "is_false"] },
  { field: "email", label: "Email address", operators: ["exists", "not_exists"] },
  { field: "phone", label: "Phone number", operators: ["exists", "not_exists"] },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function isGroup(r: ConditionRule | ConditionGroup): r is ConditionGroup {
  return typeof (r as ConditionGroup).op === "string" && Array.isArray((r as ConditionGroup).rules);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return null;
}

/** Evaluate one leaf rule against a contact's facts. Unknown field/operator → false (never silently match). */
export function evaluateConditionRule(ctx: ContactFactContext, rule: ConditionRule, now: Date = new Date()): boolean {
  const { field, operator } = rule;
  const value = rule.value;

  switch (field) {
    case "tag": {
      if (typeof value !== "string" || value.trim() === "") return false;
      const want = value.trim().toLowerCase();
      const has = ctx.tags.some((t) => t.toLowerCase() === want);
      if (operator === "contains") return has;
      if (operator === "not_contains") return !has;
      return false;
    }
    case "channel": {
      if (typeof value !== "string") return false;
      const same = ctx.channel.toLowerCase() === value.toLowerCase();
      if (operator === "eq") return same;
      if (operator === "neq") return !same;
      return false;
    }
    case "leadStatus": {
      if (typeof value !== "string") return false;
      const same = ctx.leadStatus.toUpperCase() === value.toUpperCase();
      if (operator === "eq") return same;
      if (operator === "neq") return !same;
      return false;
    }
    case "lastInboundAt": {
      const days = toNumber(value);
      if (days === null || days < 0) return false;
      // "Never heard from them" counts as infinitely old: it matches
      // older_than_days (a re-engagement target) but never newer_than_days.
      if (!ctx.lastInboundAt) return operator === "older_than_days";
      const ageDays = (now.getTime() - ctx.lastInboundAt.getTime()) / DAY_MS;
      if (operator === "older_than_days") return ageDays > days;
      if (operator === "newer_than_days") return ageDays <= days;
      return false;
    }
    case "messageCount":
    case "purchaseCount": {
      const n = toNumber(value);
      if (n === null) return false;
      const actual = field === "messageCount" ? ctx.messageCount : ctx.purchaseCount;
      switch (operator) {
        case "eq": return actual === n;
        case "neq": return actual !== n;
        case "gt": return actual > n;
        case "gte": return actual >= n;
        case "lt": return actual < n;
        case "lte": return actual <= n;
        default: return false;
      }
    }
    case "abandonedCart":
    case "optedOut": {
      const actual = field === "abandonedCart" ? ctx.abandonedCart : ctx.optedOut;
      if (operator === "is_true") return actual === true;
      if (operator === "is_false") return actual === false;
      if (operator === "eq") {
        const b = toBool(value);
        return b === null ? false : actual === b;
      }
      return false;
    }
    case "email":
    case "phone": {
      const present = field === "email" ? !!ctx.email : !!ctx.phone;
      if (operator === "exists") return present;
      if (operator === "not_exists") return !present;
      return false;
    }
    default:
      return false; // unknown field — never match
  }
}

/**
 * Evaluate a condition tree. Edge cases:
 *  - empty "and" group → true (vacuous truth; matches everyone)
 *  - empty "or" group → false (matches nobody)
 *  - unknown op → treated as "and" (fail-closed toward the strict side)
 */
export function evaluateConditionGroup(ctx: ContactFactContext, group: ConditionGroup, now: Date = new Date()): boolean {
  const rules = group?.rules ?? [];
  const op: ConditionOp = group?.op === "or" ? "or" : "and";
  if (rules.length === 0) return op === "and";
  if (op === "or") return rules.some((r) => (isGroup(r) ? evaluateConditionGroup(ctx, r, now) : evaluateConditionRule(ctx, r, now)));
  return rules.every((r) => (isGroup(r) ? evaluateConditionGroup(ctx, r, now) : evaluateConditionRule(ctx, r, now)));
}

/** Parse the JSON conditions column; falls back to an empty (match-all) AND group. */
export function parseConditions(raw: string | null | undefined): ConditionGroup {
  try {
    const parsed = JSON.parse(raw || "{}") as Partial<ConditionGroup>;
    const op: ConditionOp = parsed.op === "or" ? "or" : "and";
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    return { op, rules };
  } catch {
    return { op: "and", rules: [] };
  }
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Walk a condition tree and collect every field it references (for availability warnings). */
export function collectFields(group: ConditionGroup): Set<string> {
  const fields = new Set<string>();
  const walk = (g: ConditionGroup) => {
    for (const r of g.rules ?? []) {
      if (isGroup(r)) walk(r);
      else fields.add(r.field);
    }
  };
  walk(group);
  return fields;
}

/**
 * Human-readable one-liner for a rule, e.g. `tag contains "vip"`.
 * Used by the preview/review UI and the report.
 */
export function describeRule(rule: ConditionRule | ConditionGroup): string {
  if (isGroup(rule)) {
    const inner = rule.rules.map(describeRule).join(rule.op === "or" ? " OR " : " AND ");
    return `(${inner || "no rules"})`;
  }
  const v = rule.value === undefined ? "" : ` ${JSON.stringify(rule.value)}`;
  return `${rule.field} ${rule.operator}${v}`;
}

export function describeConditions(group: ConditionGroup): string {
  if (!group.rules.length) return "All contacts";
  const glue = group.op === "or" ? " OR " : " AND ";
  return group.rules.map(describeRule).join(glue);
}

/**
 * Resolve every contact in the workspace matching a condition tree.
 * Aggregates facts from Contact / Conversation / Message / ContactOrder /
 * Suppression in a bounded number of queries.
 */
export async function resolveSegmentContacts(
  workspaceId: string,
  tree: ConditionGroup,
  opts?: { now?: Date; limit?: number }
): Promise<SegmentMatchResult> {
  const now = opts?.now ?? new Date();

  const contacts = await db.contact.findMany({ where: { workspaceId } });
  if (contacts.length === 0) return { count: 0, contacts: [] };

  const contactIds = contacts.map((c) => c.id);

  // Inbound message counts per contact (via Conversation).
  const conversations = await db.conversation.findMany({
    where: { workspaceId, contactId: { in: contactIds } },
    select: { id: true, contactId: true },
  });
  const convToContact = new Map(conversations.map((c) => [c.id, c.contactId]));
  const messageCounts = new Map<string, number>();
  if (conversations.length > 0) {
    const grouped = await db.message.groupBy({
      by: ["conversationId"],
      where: {
        conversationId: { in: conversations.map((c) => c.id) },
        direction: "INBOUND",
      },
      _count: { conversationId: true },
    });
    for (const g of grouped) {
      const contactId = convToContact.get(g.conversationId);
      if (contactId) messageCounts.set(contactId, (messageCounts.get(contactId) ?? 0) + g._count.conversationId);
    }
  }

  // Purchase counts per contact.
  const purchaseCounts = new Map<string, number>();
  const orderGroups = await db.contactOrder.groupBy({
    by: ["contactId"],
    where: { workspaceId, contactId: { in: contactIds } },
    _count: { contactId: true },
  });
  for (const g of orderGroups) purchaseCounts.set(g.contactId, g._count.contactId);

  // Opt-out set.
  const suppressionRows = await db.suppression.findMany({
    where: { workspaceId, contactId: { in: contactIds } },
    select: { contactId: true },
  });
  const optedOut = new Set(suppressionRows.map((r) => r.contactId));

  const matched: ContactFactContext[] = [];
  for (const c of contacts) {
    const tags = parseTags(c.tags);
    let customFields: Record<string, unknown> = {};
    try {
      customFields = JSON.parse(c.customFields || "{}") as Record<string, unknown>;
    } catch {
      customFields = {};
    }
    const abandonedCart =
      customFields.abandonedCart === true ||
      tags.some((t) => t.toLowerCase() === "cart-abandoned");
    const ctx: ContactFactContext = {
      contactId: c.id,
      name: c.name,
      channel: c.channel,
      leadStatus: c.leadStatus,
      tags,
      email: c.email,
      phone: c.phone,
      lastInboundAt: c.lastInboundAt,
      lastOutboundAt: c.lastOutboundAt,
      messageCount: messageCounts.get(c.id) ?? 0,
      purchaseCount: purchaseCounts.get(c.id) ?? 0,
      abandonedCart,
      optedOut: optedOut.has(c.id),
    };
    if (evaluateConditionGroup(ctx, tree, now)) matched.push(ctx);
  }

  const limited = opts?.limit ? matched.slice(0, opts.limit) : matched;
  return { count: matched.length, contacts: limited };
}

/** Availability warnings for the fields a tree references — shown on preview. */
export function availabilityWarningsFor(tree: ConditionGroup): string[] {
  const fields = collectFields(tree);
  const warnings: string[] = [];
  for (const f of fields) {
    if (f === "purchaseCount" || f === "abandonedCart") {
      warnings.push(
        `${f}: ${PROVIDER_AVAILABILITY[f]} Matches nobody until a store adapter or import provides the data.`
      );
    }
  }
  return warnings;
}
