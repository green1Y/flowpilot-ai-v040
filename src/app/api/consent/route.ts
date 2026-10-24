import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  recordConsent,
  getConsentState,
  getConsentStatesForContact,
  CONSENT_CHANNELS,
} from "@/lib/consent";

/**
 * GET /api/consent — Member read.
 * ?contactId=… → that contact's records + suppressions + effective
 * states per channel (suppression always beats a stale OPTED_IN record).
 * No contactId → workspace-wide records + suppressions (capped at 500).
 * Optional ?channel=… narrows the effective state to one channel.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;
  const contactId = sp.get("contactId");
  const channel = sp.get("channel");

  if (contactId) {
    const contact = await db.contact.findFirst({
      where: { id: contactId, workspaceId: ctx.workspaceId },
      select: { id: true, name: true },
    });
    if (!contact) throw err("Contact not found", 404);
    const [records, suppressions, effective] = await Promise.all([
      db.consentRecord.findMany({
        where: { workspaceId: ctx.workspaceId, contactId, ...(channel ? { channel } : {}) },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      db.suppression.findMany({
        where: { workspaceId: ctx.workspaceId, contactId, ...(channel ? { channel } : {}) },
        orderBy: { createdAt: "desc" },
      }),
      channel
        ? getConsentState(ctx.workspaceId, contactId, channel).then((s) => ({ [channel]: s }))
        : getConsentStatesForContact(ctx.workspaceId, contactId),
    ]);
    return ok({
      contact,
      records: records.map((r) => ({
        id: r.id,
        channel: r.channel,
        status: r.status,
        source: r.source,
        wordingVersion: r.wordingVersion,
        createdAt: r.createdAt.toISOString(),
      })),
      suppressions: suppressions.map((s) => ({
        id: s.id,
        channel: s.channel,
        reason: s.reason,
        createdAt: s.createdAt.toISOString(),
      })),
      effective,
    });
  }

  const [records, suppressions] = await Promise.all([
    db.consentRecord.findMany({
      where: { workspaceId: ctx.workspaceId, ...(channel ? { channel } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { contact: { select: { id: true, name: true } } },
    }),
    db.suppression.findMany({
      where: { workspaceId: ctx.workspaceId, ...(channel ? { channel } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { contact: { select: { id: true, name: true } } },
    }),
  ]);
  return ok({
    records: records.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      contactName: r.contact?.name ?? null,
      channel: r.channel,
      status: r.status,
      source: r.source,
      wordingVersion: r.wordingVersion,
      createdAt: r.createdAt.toISOString(),
    })),
    suppressions: suppressions.map((s) => ({
      id: s.id,
      contactId: s.contactId,
      contactName: s.contact?.name ?? null,
      channel: s.channel,
      reason: s.reason,
      createdAt: s.createdAt.toISOString(),
    })),
  });
});

const createSchema = z.object({
  contactId: z.string().min(1),
  channel: z.enum(CONSENT_CHANNELS),
  status: z.enum(["OPTED_IN", "OPTED_OUT"]),
  source: z.string().max(100).optional(),
  wordingVersion: z.string().max(100).optional().nullable(),
});

/**
 * POST /api/consent — AGENT+. Appends a ConsentRecord. When status is
 * OPTED_OUT, recordConsent() also creates the Suppression row, so the
 * ledger and enforcement agree; an OPTED_IN record never removes an
 * existing suppression.
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, createSchema);
  let record;
  try {
    record = await recordConsent(
      ctx.workspaceId,
      body.contactId,
      body.channel,
      body.status,
      body.source?.trim() || "manual",
      body.wordingVersion ?? null
    );
  } catch {
    throw err("Contact not found", 404);
  }
  const effective = await getConsentState(ctx.workspaceId, body.contactId, body.channel);
  await auditLog(ctx.workspaceId, ctx.userId, "consent.recorded", {
    type: "consent",
    id: record.id,
    contactId: body.contactId,
    channel: body.channel,
    status: body.status,
    source: record.source,
  });
  return ok({
    record: {
      id: record.id,
      channel: record.channel,
      status: record.status,
      source: record.source,
      wordingVersion: record.wordingVersion,
      createdAt: record.createdAt.toISOString(),
    },
    effective,
  });
});
