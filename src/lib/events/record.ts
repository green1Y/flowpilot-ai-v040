/**
 * Phase 3A — unified customer event log.
 *
 * Every meaningful customer-facing occurrence is recorded as a CustomerEvent
 * so the CRM, retargeting center, and analytics all read from ONE source of
 * truth. Events are tenant-scoped (workspaceId) and idempotent:
 * re-ingesting the same provider event (same workspaceId + providerEventId)
 * returns the existing row instead of creating a duplicate.
 *
 * Never throws for logging failures at call sites — use `recordCustomerEvent`
 * (returns null on failure) or `recordCustomerEventStrict` when the caller
 * must know. Never logs secrets: only structured metadata the caller passes.
 */

import { db } from "../db";

/** Canonical event types. Stored as plain strings (SQLite has no enums). */
export const CUSTOMER_EVENT_TYPES = [
  "comment_received",
  "conversation_started",
  "message_received",
  "message_sent",
  "message_delivered",
  "message_failed",
  "workflow_executed",
  "contact_tagged",
  "segment_changed",
  "opted_out",
  "consent_changed",
  "purchase_recorded",
  "campaign_interaction",
  "conversion_attributed",
] as const;

export type CustomerEventType = (typeof CUSTOMER_EVENT_TYPES)[number];

export interface RecordCustomerEventInput {
  workspaceId: string;
  contactId?: string | null;
  /** Batch B: the connected account the event came through / went out on. */
  integrationId?: string | null;
  type: CustomerEventType | string;
  provider?: string | null;
  /** Dedupe key. When set, a second record with the same (workspaceId, providerEventId) is a no-op. */
  providerEventId?: string | null;
  timestamp?: Date;
  source?: string;
  metadata?: Record<string, unknown>;
  attribution?: Record<string, unknown>;
}

function toJson(v: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}

/**
 * Record an event idempotently. Returns the event id, or the existing id
 * when the (workspaceId, providerEventId) pair was already recorded.
 * Returns null (never throws) on unexpected failures so event logging can
 * never break the main business flow.
 */
export async function recordCustomerEvent(
  input: RecordCustomerEventInput
): Promise<string | null> {
  try {
    return await recordCustomerEventStrict(input);
  } catch (e) {
    console.warn("[events] recordCustomerEvent failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Strict variant: throws on failure. Prefers the existing row when the
 * dedupe key already exists (idempotent ingestion). Uses a single atomic
 * upsert so concurrent duplicate deliveries cannot race the check-then-insert
 * (the loser of the race gets the existing row instead of a P2002 throw).
 */
export async function recordCustomerEventStrict(
  input: RecordCustomerEventInput
): Promise<string> {
  const providerEventId = input.providerEventId ?? null;
  const data = {
    workspaceId: input.workspaceId,
    contactId: input.contactId ?? null,
    integrationId: input.integrationId ?? null,
    type: input.type,
    provider: input.provider ?? null,
    providerEventId,
    timestamp: input.timestamp ?? new Date(),
    source: input.source ?? "system",
    metadata: toJson(input.metadata),
    attribution: toJson(input.attribution),
  };
  // No dedupe key: every call records a new row (unchanged behavior).
  if (!providerEventId) {
    const created = await db.customerEvent.create({ data, select: { id: true } });
    return created.id;
  }
  const row = await db.customerEvent.upsert({
    where: {
      workspaceId_providerEventId: {
        workspaceId: input.workspaceId,
        providerEventId,
      },
    },
    // Idempotent: the first-recorded row wins; a duplicate re-ingest is a no-op.
    update: {},
    create: data,
    select: { id: true },
  });
  return row.id;
}

/** Convenience: record several events; never throws. */
export async function recordCustomerEvents(
  inputs: RecordCustomerEventInput[]
): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (const input of inputs) out.push(await recordCustomerEvent(input));
  return out;
}
