import type { Campaign, Contact } from "@prisma/client";

/** Parse a JSON string column, falling back to `fallback` on bad data. */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Contact row → API shape (JSON string columns parsed for consumers). */
export function serializeContact(c: Contact) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    name: c.name,
    channel: c.channel,
    email: c.email,
    phone: c.phone,
    tags: parseJson<string[]>(c.tags, []),
    customFields: parseJson<Record<string, string>>(c.customFields, {}),
    leadStatus: c.leadStatus,
    leadScore: c.leadScore,
    externalIds: parseJson<Record<string, string>>(c.externalIds, {}),
    consent: parseJson<Record<string, unknown>>(c.consent, {}),
    assignedTo: c.assignedTo,
    notes: c.notes,
    firstSeenAt: c.firstSeenAt,
    lastSeenAt: c.lastSeenAt,
    lastInboundAt: c.lastInboundAt,
  };
}

/** Campaign row → API shape (JSON string columns parsed for consumers). */
export function serializeCampaign(c: Campaign) {
  return {
    ...c,
    audience: parseJson<Record<string, unknown>>(c.audience, {}),
    message: parseJson<Record<string, unknown>>(c.message, {}),
  };
}
