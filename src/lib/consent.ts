/**
 * Consent ledger (v0.4.0, Wave 2B).
 *
 * Two tables, two jobs:
 * - ConsentRecord: the durable ledger — every opt-in / opt-out event,
 *   with its source and wording version. Append-only history.
 * - Suppression: the enforcement mechanism. Any row blocks outbound
 *   messaging to the contact (per channel, or all channels when
 *   channel is null). See the eligibility checker.
 *
 * Invariants:
 * - A Suppression row ALWAYS beats a stale OPTED_IN ConsentRecord when
 *   computing the effective state. (A contact who opted out, then whose
 *   old opt-in is re-imported, stays suppressed.)
 * - An OPTED_IN record never removes a Suppression row. Un-suppressing
 *   is a separate, deliberate action (delete the Suppression row via
 *   the suppressions API), never a side effect of an import or record.
 * - Recording OPTED_OUT also creates the Suppression row, so the ledger
 *   and enforcement always agree.
 */

import { db } from "./db";

export type ConsentStatus = "OPTED_IN" | "OPTED_OUT";
export type EffectiveConsentState = "OPTED_IN" | "OPTED_OUT" | "SUPPRESSED" | "UNKNOWN";

/** Channels accepted by the consent API. `web` is not a messaging channel. */
export const CONSENT_CHANNELS = ["instagram", "facebook", "whatsapp", "email", "sms"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

/**
 * True when a Suppression row blocks this contact on this channel —
 * either a row scoped to exactly this channel, or an all-channel row
 * (channel = null). Pass no channel to test "suppressed anywhere".
 */
export async function isSuppressed(
  workspaceId: string,
  contactId: string,
  channel?: string | null
): Promise<boolean> {
  const rows = await db.suppression.findMany({
    where: { workspaceId, contactId },
    select: { channel: true },
  });
  return rows.some(
    (r) => r.channel === null || (channel != null && r.channel === channel)
  );
}

/** Ensure a Suppression row exists (idempotent; SQLite NULLs are distinct in unique indexes). */
export async function ensureSuppression(
  workspaceId: string,
  contactId: string,
  channel: string | null,
  reason: string
) {
  const existing = await db.suppression.findFirst({
    where: { workspaceId, contactId, channel },
  });
  if (existing) return existing;
  return db.suppression.create({
    data: { workspaceId, contactId, channel, reason },
  });
}

export interface ConsentState {
  state: EffectiveConsentState;
  /** True when any Suppression row covers this channel. */
  suppressed: boolean;
  /** Latest ConsentRecord for this channel, or null when there is none. */
  record: {
    id: string;
    status: string;
    source: string;
    wordingVersion: string | null;
    createdAt: Date;
  } | null;
}

/**
 * Effective consent state for one contact + channel.
 * Order of precedence: suppression > latest ConsentRecord > UNKNOWN.
 */
export async function getConsentState(
  workspaceId: string,
  contactId: string,
  channel: string
): Promise<ConsentState> {
  const [suppressed, latest] = await Promise.all([
    isSuppressed(workspaceId, contactId, channel),
    db.consentRecord.findFirst({
      where: { workspaceId, contactId, channel },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const record = latest
    ? {
        id: latest.id,
        status: latest.status,
        source: latest.source,
        wordingVersion: latest.wordingVersion,
        createdAt: latest.createdAt,
      }
    : null;
  if (suppressed) return { state: "SUPPRESSED", suppressed: true, record };
  if (!record) return { state: "UNKNOWN", suppressed: false, record: null };
  return {
    state: record.status === "OPTED_IN" ? "OPTED_IN" : "OPTED_OUT",
    suppressed: false,
    record,
  };
}

/**
 * Append a ConsentRecord. When status is OPTED_OUT, also create the
 * Suppression row (per channel) so enforcement and ledger agree.
 * The contact must belong to the workspace; throws otherwise.
 */
export async function recordConsent(
  workspaceId: string,
  contactId: string,
  channel: string,
  status: ConsentStatus,
  source: string,
  wordingVersion?: string | null
) {
  const contact = await db.contact.findFirst({
    where: { id: contactId, workspaceId },
  });
  if (!contact) throw new Error("Contact not found");
  const record = await db.consentRecord.create({
    data: {
      workspaceId,
      contactId,
      channel,
      status,
      source,
      wordingVersion: wordingVersion ?? null,
    },
  });
  if (status === "OPTED_OUT") {
    await ensureSuppression(workspaceId, contactId, channel, `opted out via ${source}`);
  }
  return record;
}

/** Effective states for every channel that has any record or suppression for this contact. */
export async function getConsentStatesForContact(
  workspaceId: string,
  contactId: string
): Promise<Record<string, ConsentState>> {
  const [records, suppressions] = await Promise.all([
    db.consentRecord.findMany({ where: { workspaceId, contactId } }),
    db.suppression.findMany({ where: { workspaceId, contactId } }),
  ]);
  const channels = new Set<string>();
  for (const r of records) channels.add(r.channel);
  for (const s of suppressions) if (s.channel) channels.add(s.channel);
  const out: Record<string, ConsentState> = {};
  for (const channel of channels) {
    out[channel] = await getConsentState(workspaceId, contactId, channel);
  }
  return out;
}
