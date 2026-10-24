/**
 * Phase B — Retargeting Center: campaign send engine.
 *
 * Five campaign types, each with its own eligibility rules:
 *  - dm_reengagement: Instagram/Facebook/WhatsApp DM via the real send
 *    pipeline (sendFollowUp — mock-backed without provider credentials, and
 *    labeled honestly). 24h window / WhatsApp template rules from
 *    checkEligibility, suppression via isSuppressed, frequency caps.
 *  - comment_to_dm: Instagram/Facebook private reply to a recent comment
 *    (7-day window, one reply per comment — checkEligibility).
 *  - email: NO live email provider is wired in this platform. Eligible
 *    recipients (email + marketing consent, not suppressed) are recorded as
 *    SIMULATED sends — honest, never presented as delivered.
 *  - crm_sequence: no automatic send at all. Each step is logged as a CRM
 *    task (campaign_interaction event); the contact's human owner works it.
 *  - paid_ad: NEVER creates ads or audiences. Launch returns the Meta setup
 *    checklist + a consent-flagged audience CSV for manual import into Ads
 *    Manager. No fake ad IDs, ever.
 *
 * Attribution: sendFollowUp's campaignId is informational and points at the
 * legacy Campaign table, so we do NOT pass the retargeting id there. Instead
 * we record our own CustomerEvent campaign_interaction with
 * attribution { retargetingCampaignId } — no FK confusion.
 */

import { db } from "../db";
import { err } from "../api";
import { auditLog } from "../audit";
import { recordCustomerEvent } from "../events/record";
import {
  checkEligibility,
  EligibilityChannel,
  EligibilityMessageType,
} from "../messaging/eligibility";
import {
  sendFollowUp,
  isSuppressed,
  resolveRecipientAddress,
  SendError,
  SendChannel,
} from "../messaging/send";
import {
  parseConditions,
  resolveSegmentContacts,
  describeConditions,
  ContactFactContext,
} from "./segments";
import { assertLiveSendAllowed } from "../demo/guard";

export const RETARGETING_TYPES = [
  "dm_reengagement",
  "email",
  "paid_ad",
  "comment_to_dm",
  "crm_sequence",
] as const;
export type RetargetingType = (typeof RETARGETING_TYPES)[number];

export const RETARGETING_STATUSES = [
  "draft",
  "scheduled",
  "running",
  "paused",
  "completed",
  "cancelled",
] as const;

export function retargetingRecipientKey(campaignId: string, contactId: string): string {
  return `retargeting:${campaignId}:contact:${contactId}`;
}

interface CampaignRow {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
  status: string;
  channel: string | null;
  integrationId: string | null;
  segmentId: string | null;
  objective: string;
  message: string;
  schedule: string;
  budget: string;
  dryRun: boolean;
  confirmedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignMessage {
  body?: string;
  templateId?: string | null;
  messageType?: string; // "freeform" | "template" (dm_reengagement)
  sequence?: Array<{ day: number; title: string; note?: string }>; // crm_sequence
  creativeRef?: string; // paid_ad: reference to the ad creative doc
}

export interface CampaignSchedule {
  startsAt?: string | null;
  endsAt?: string | null;
  timezone?: string | null;
  frequencyCap?: { maxPerContactPerDay?: number } | null;
}

export interface RecipientVerdict {
  eligible: boolean;
  reasons: string[];
  ineligibleReasons: string[];
  /** Resolved send channel (null for paid_ad / crm_sequence). */
  channel: string | null;
  /** Resolved recipient address / comment id, when applicable. */
  address: string | null;
  /** True when the "send" is simulated or manual (email, crm_sequence). */
  simulated: boolean;
  /** Extra context stored on the RetargetingRecipient eligibility JSON. */
  extra?: Record<string, unknown>;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    const v = JSON.parse(raw || "");
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function parseConsent(raw: string | null | undefined): Record<string, boolean> {
  const v = parseJson<Record<string, unknown>>(raw, {});
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "boolean") out[k] = val;
  }
  return out;
}

export function campaignMessage(c: CampaignRow): CampaignMessage {
  return parseJson<CampaignMessage>(c.message, {});
}

export function campaignSchedule(c: CampaignRow): CampaignSchedule {
  return parseJson<CampaignSchedule>(c.schedule, {});
}

/** Tenant-scoped lookup; 404 when missing (or not ours). Never leaks cross-workspace existence. */
export async function scopedRetargetingCampaign(
  workspaceId: string,
  id: string
): Promise<CampaignRow> {
  const campaign = await db.retargetingCampaign.findFirst({
    where: { id, workspaceId },
  });
  if (!campaign) throw err("Retargeting campaign not found", 404);
  return campaign as CampaignRow;
}

/** Map a lib-level SendError to an err() Response; rethrows anything else. */
export function mapRetargetingError(e: unknown): never {
  if (e instanceof SendError) {
    throw err(e.message, e.status, e.extra as Record<string, unknown> | undefined);
  }
  throw e;
}

function asEligibilityChannel(channel: string): EligibilityChannel {
  if (channel === "instagram" || channel === "facebook" || channel === "whatsapp") return channel;
  throw new SendError(`Unsupported DM channel "${channel}"`, 422);
}

function asSendChannel(channel: string): SendChannel {
  if (channel === "instagram" || channel === "facebook" || channel === "whatsapp") return channel;
  throw new SendError(`Unsupported send channel "${channel}"`, 422);
}

/**
 * Frequency cap: max sends to one contact per rolling 24h across ALL
 * FlowPilot outbound (follow-ups + campaigns + retargeting). Default 1/day.
 * Counts OutboundSend rows plus retargeting recipients marked sent (email /
 * crm_sequence don't write OutboundSend).
 */
export async function frequencyCapReached(
  workspaceId: string,
  contactId: string,
  capPerDay: number,
  now: Date
): Promise<{ reached: boolean; sentInWindow: number }> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [outbound, retargeted] = await Promise.all([
    db.outboundSend.count({ where: { workspaceId, contactId, createdAt: { gte: since } } }),
    db.retargetingRecipient.count({
      where: {
        contactId,
        status: "sent",
        sentAt: { gte: since },
        campaign: { workspaceId },
      },
    }),
  ]);
  const sentInWindow = outbound + retargeted;
  return { reached: sentInWindow >= Math.max(1, capPerDay), sentInWindow };
}

/**
 * Per-type eligibility verdict for one contact. Pure-ish: reads the contact
 * row, suppression list, and (for comment_to_dm) the contact's comments.
 */
export async function evaluateRecipient(
  workspaceId: string,
  campaign: CampaignRow,
  facts: ContactFactContext,
  opts?: { now?: Date }
): Promise<RecipientVerdict> {
  const now = opts?.now ?? new Date();
  const type = campaign.type as RetargetingType;
  const schedule = campaignSchedule(campaign);
  const cap = schedule.frequencyCap?.maxPerContactPerDay ?? 1;

  const contact = await db.contact.findFirst({
    where: { id: facts.contactId, workspaceId },
  });
  if (!contact) {
    return {
      eligible: false, reasons: [], ineligibleReasons: ["contact no longer exists"],
      channel: null, address: null, simulated: false,
    };
  }

  // Suppression blocks everything, every type (checked explicitly for the
  // non-DM types; the DM path re-checks inside sendFollowUp at send time).
  const suppressed =
    (await isSuppressed(workspaceId, contact.id, campaign.channel ?? "")) ||
    facts.optedOut;
  if (suppressed) {
    return {
      eligible: false, reasons: [], ineligibleReasons: ["contact is suppressed/opted out"],
      channel: null, address: null, simulated: false,
    };
  }

  const capCheck = await frequencyCapReached(workspaceId, contact.id, cap, now);
  if (capCheck.reached) {
    return {
      eligible: false, reasons: [],
      ineligibleReasons: [`frequency cap reached (${capCheck.sentInWindow} send(s) in the last 24h)`],
      channel: null, address: null, simulated: false,
    };
  }

  const consent = parseConsent(contact.consent);

  switch (type) {
    case "dm_reengagement": {
      if (!campaign.channel) {
        return { eligible: false, reasons: [], ineligibleReasons: ["campaign has no channel configured"], channel: null, address: null, simulated: false };
      }
      const channel = asSendChannel(campaign.channel);
      const msg = campaignMessage(campaign);
      const messageType: EligibilityMessageType =
        msg.messageType === "template" ? "template" : "freeform";
      const address = resolveRecipientAddress(channel, contact.externalIds);
      if (!address) {
        return {
          eligible: false, reasons: [],
          ineligibleReasons: [`contact has no ${channel} identity (external id) — cannot address this send`],
          channel, address: null, simulated: false,
        };
      }
      if (!msg.body && !msg.templateId) {
        return { eligible: false, reasons: [], ineligibleReasons: ["campaign message body is empty"], channel, address, simulated: false };
      }
      const verdict = checkEligibility({
        channel,
        messageType,
        lastInboundAt: contact.lastInboundAt,
        now,
      });
      return {
        eligible: verdict.eligible,
        reasons: verdict.reasons,
        ineligibleReasons: verdict.ineligibleReasons,
        channel,
        address,
        simulated: false,
        extra: { messageType, windowEndsAt: verdict.windowEndsAt?.toISOString() ?? null },
      };
    }

    case "comment_to_dm": {
      if (!campaign.channel || (campaign.channel !== "instagram" && campaign.channel !== "facebook")) {
        return { eligible: false, reasons: [], ineligibleReasons: ["comment_to_dm requires the instagram or facebook channel"], channel: null, address: null, simulated: false };
      }
      const channel = asEligibilityChannel(campaign.channel);
      // Resolve the contact's most recent reply-eligible comment.
      const comment = await db.comment.findFirst({
        where: {
          workspaceId,
          contactId: contact.id,
          privateRepliedAt: null,
          privateReplyEligibleUntil: { gt: now },
        },
        orderBy: { commentedAt: "desc" },
      });
      if (!comment) {
        return {
          eligible: false, reasons: [],
          ineligibleReasons: ["no comment within the 7-day private-reply window (or every recent comment already got a private reply)"],
          channel, address: null, simulated: false,
        };
      }
      const verdict = checkEligibility({
        channel,
        messageType: "private_reply",
        commentCreatedAt: comment.commentedAt,
        privateRepliedAt: comment.privateRepliedAt,
        now,
      });
      return {
        eligible: verdict.eligible,
        reasons: verdict.reasons,
        ineligibleReasons: verdict.ineligibleReasons,
        channel,
        address: comment.externalId,
        simulated: false,
        extra: { messageType: "private_reply", commentId: comment.externalId },
      };
    }

    case "email": {
      if (!contact.email) {
        return { eligible: false, reasons: [], ineligibleReasons: ["contact has no email address"], channel: "email", address: null, simulated: true };
      }
      if (consent.email !== true && consent.marketing !== true) {
        return {
          eligible: false, reasons: [],
          ineligibleReasons: ["no marketing email consent recorded (consent.email or consent.marketing must be true)"],
          channel: "email", address: contact.email, simulated: true,
        };
      }
      return {
        eligible: true,
        reasons: ["email present, marketing consent recorded, not suppressed"],
        ineligibleReasons: [],
        channel: "email",
        address: contact.email,
        simulated: true,
        extra: { note: "SIMULATED — no email delivery provider is connected in this workspace; the send is logged, not delivered." },
      };
    }

    case "crm_sequence": {
      if (consent.marketing === false && consent.email === false) {
        return { eligible: false, reasons: [], ineligibleReasons: ["contact declined marketing contact"], channel: null, address: null, simulated: true };
      }
      return {
        eligible: true,
        reasons: ["not suppressed — sequence steps are logged as CRM tasks for the owner to work"],
        ineligibleReasons: [],
        channel: null,
        address: null,
        simulated: true,
        extra: { note: "No automatic send — each step is recorded as a CRM task." },
      };
    }

    case "paid_ad": {
      if (!contact.email && !contact.phone) {
        return { eligible: false, reasons: [], ineligibleReasons: ["no email or phone to match against a Custom Audience"], channel: null, address: null, simulated: true };
      }
      if (consent.marketing !== true && consent.email !== true) {
        return {
          eligible: false, reasons: [],
          ineligibleReasons: ["no marketing consent recorded — Custom Audiences require a consent basis"],
          channel: null, address: null, simulated: true,
        };
      }
      return {
        eligible: true,
        reasons: ["identifier + marketing consent present — included in the audience export"],
        ineligibleReasons: [],
        channel: null,
        address: contact.email ?? contact.phone,
        simulated: true,
        extra: { note: "Export only — FlowPilot never creates ads or audiences in Meta." },
      };
    }

    default:
      return { eligible: false, reasons: [], ineligibleReasons: [`unknown campaign type "${type}"`], channel: null, address: null, simulated: false };
  }
}

export interface BuildRecipientsResult {
  created: number;
  eligible: number;
  skipped: number;
  dryRun: boolean;
  verdicts?: Array<{ contactId: string; name: string; verdict: RecipientVerdict }>;
  skippedSample: Array<{ contactId: string; name: string; reasons: string[] }>;
}

/**
 * Resolve the campaign's segment → contacts → per-recipient verdicts, then
 * persist RetargetingRecipient rows (status pending | skipped). Idempotent:
 * re-running only evaluates contacts not yet in the recipient list.
 * dryRun: evaluate everything, persist nothing.
 */
export async function buildRecipients(
  workspaceId: string,
  campaignId: string,
  opts?: { userId?: string | null; now?: Date; dryRun?: boolean }
): Promise<BuildRecipientsResult> {
  const now = opts?.now ?? new Date();
  const userId = opts?.userId ?? null;
  const dryRun = opts?.dryRun ?? false;

  const campaign = await scopedRetargetingCampaign(workspaceId, campaignId);
  if (!["draft", "scheduled", "paused"].includes(campaign.status)) {
    throw new SendError(
      `Cannot build recipients while campaign is ${campaign.status} — pause or reset to draft first`,
      422
    );
  }
  if (!campaign.segmentId) {
    throw new SendError("Select an audience segment before building recipients", 422);
  }
  const segment = await db.audienceSegment.findFirst({
    where: { id: campaign.segmentId, workspaceId },
  });
  if (!segment) throw new SendError("Audience segment not found", 404);

  const tree = parseConditions(segment.conditions);
  const { contacts } = await resolveSegmentContacts(workspaceId, tree, { now });

  const existing = await db.retargetingRecipient.findMany({
    where: { campaignId },
    select: { contactId: true },
  });
  const existingIds = new Set(existing.map((e) => e.contactId));
  const fresh = contacts.filter((c) => !existingIds.has(c.contactId));

  const rows: Array<{
    campaignId: string; contactId: string; status: string;
    eligibility: string; idempotencyKey: string;
  }> = [];
  const skippedSample: BuildRecipientsResult["skippedSample"] = [];
  const verdicts: BuildRecipientsResult["verdicts"] = [];
  let eligible = 0;
  let skipped = 0;

  for (const facts of fresh) {
    let verdict: RecipientVerdict;
    try {
      verdict = await evaluateRecipient(workspaceId, campaign, facts, { now });
    } catch (e) {
      const message = e instanceof SendError ? e.message : "evaluation failed";
      verdict = {
        eligible: false, reasons: [], ineligibleReasons: [message],
        channel: null, address: null, simulated: false,
      };
    }
    if (verdict.eligible) eligible++;
    else {
      skipped++;
      if (skippedSample.length < 10) {
        skippedSample.push({ contactId: facts.contactId, name: facts.name, reasons: verdict.ineligibleReasons });
      }
    }
    verdicts.push({ contactId: facts.contactId, name: facts.name, verdict });
    rows.push({
      campaignId,
      contactId: facts.contactId,
      status: verdict.eligible ? "pending" : "skipped",
      eligibility: JSON.stringify({
        eligible: verdict.eligible,
        reasons: verdict.reasons,
        ineligibleReasons: verdict.ineligibleReasons,
        channel: verdict.channel,
        simulated: verdict.simulated,
        ...(verdict.extra ?? {}),
        evaluatedAt: now.toISOString(),
      }),
      idempotencyKey: retargetingRecipientKey(campaignId, facts.contactId),
    });
  }

  let created = 0;
  if (!dryRun && rows.length > 0) {
    try {
      const res = await db.retargetingRecipient.createMany({ data: rows });
      created = res.count;
    } catch (e) {
      // P2002 race (two concurrent builds): rows are identical, re-read
      // below for the true counts; the build stays idempotent.
      if (!(e instanceof Error) || !/P2002|unique/i.test(e.message)) throw e;
      created = await db.retargetingRecipient.count({ where: { campaignId } });
    }
  }

  const totals = await db.retargetingRecipient.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { status: true },
  });
  const byStatus = new Map(totals.map((t) => [t.status, t._count.status]));

  await auditLog(workspaceId, userId, dryRun ? "retargeting.recipients_previewed" : "retargeting.recipients_built", {
    type: "retargeting_campaign",
    id: campaignId,
    created,
    eligible: byStatus.get("pending") ?? 0,
    skipped: byStatus.get("skipped") ?? 0,
    dryRun,
  });

  return {
    created,
    eligible: dryRun ? eligible : (byStatus.get("pending") ?? 0),
    skipped: dryRun ? skipped : (byStatus.get("skipped") ?? 0),
    dryRun,
    verdicts: dryRun ? verdicts : undefined,
    skippedSample,
  };
}

/**
 * Meta Marketing API activation checklist for paid_ad campaigns.
 * Returned by the launch endpoint INSTEAD of any ad/audience id — FlowPilot
 * never fabricates provider-side objects.
 */
export function getPaidAdChecklist(): Array<{
  id: string;
  title: string;
  description: string;
  required: boolean;
}> {
  return [
    {
      id: "ad_account",
      title: "Meta ad account ID",
      description:
        "The ad account (act_<ID>) that will own the campaign. Find it in Ads Manager → Account settings → Account ID.",
      required: true,
    },
    {
      id: "ads_management",
      title: "ads_management permission",
      description:
        "Your Meta app or system user must be granted ads_management on the ad account before it can create or manage Custom Audiences via the Marketing API.",
      required: true,
    },
    {
      id: "business_verification",
      title: "Business verification",
      description:
        "Meta requires a verified business (Business Settings → Security Center) before ads can deliver.",
      required: true,
    },
    {
      id: "billing",
      title: "Billing method on the ad account",
      description:
        "A valid payment method must be attached to the ad account or Meta will not deliver the campaign.",
      required: true,
    },
    {
      id: "custom_audience_terms",
      title: "Custom Audience terms accepted",
      description:
        "Accept Meta's Custom Audience terms in Ads Manager (Audiences) — required before uploading customer lists.",
      required: true,
    },
    {
      id: "consent_basis",
      title: "Consent basis for every exported contact",
      description:
        "FlowPilot only exports contacts with marketing consent recorded (consent.marketing or consent.email = true) and skips suppressed contacts. Keep proof of consent for your records.",
      required: true,
    },
    {
      id: "pixel_capi",
      title: "Pixel / Conversions API (optional, recommended)",
      description:
        "To measure real conversions and ROAS later, install the Meta Pixel or send server events via the Conversions API. Without it, FlowPilot reports spend/ROAS as 'not tracked'.",
      required: false,
    },
  ];
}

function csvEscape(v: string | null | undefined): string {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build the consent-flagged audience CSV for a paid_ad campaign. Eligible =
 * recipients with status pending (or sent — re-export is allowed) that have
 * an email or phone and are not suppressed.
 */
export async function buildAudienceExportCsv(
  workspaceId: string,
  campaignId: string
): Promise<{ csv: string; exported: number; excluded: number }> {
  const campaign = await scopedRetargetingCampaign(workspaceId, campaignId);
  const recipients = await db.retargetingRecipient.findMany({
    where: { campaignId, status: { in: ["pending", "sent"] } },
    include: { contact: true },
  });
  const lines = [
    "email,phone,first_name,last_name,consent_marketing,contact_id",
  ];
  let exported = 0;
  let excluded = 0;
  for (const r of recipients) {
    const contact = r.contact;
    const consent = parseConsent(contact.consent);
    const hasConsent = consent.marketing === true || consent.email === true;
    const hasIdentifier = !!(contact.email || contact.phone);
    const suppressed = await isSuppressed(workspaceId, contact.id, "");
    if (!hasConsent || !hasIdentifier || suppressed) {
      excluded++;
      continue;
    }
    const nameParts = (contact.name || "").trim().split(/\s+/);
    const firstName = nameParts[0] ?? "";
    const lastName = nameParts.slice(1).join(" ");
    lines.push(
      [
        csvEscape(contact.email),
        csvEscape(contact.phone),
        csvEscape(firstName),
        csvEscape(lastName),
        "true",
        csvEscape(contact.id),
      ].join(",")
    );
    exported++;
  }
  return { csv: lines.join("\n") + "\n", exported, excluded };
}

export interface LaunchResult {
  status: string;
  dryRun: boolean;
  eligible: number;
  skipped: number;
  skippedSample: Array<{ contactId: string; name: string; reasons: string[] }>;
  /** paid_ad only: setup checklist + audience export (never a fake ad id). */
  paidAd?: {
    checklist: ReturnType<typeof getPaidAdChecklist>;
    audienceCsv: string;
    exported: number;
    excluded: number;
    note: string;
  };
}

/**
 * Launch a campaign. Requires explicit { confirmed: true } — the route
 * enforces this with Zod, the engine double-checks so the rule can't be
 * bypassed by calling the engine directly.
 */
export async function launchRetargetingCampaign(
  workspaceId: string,
  campaignId: string,
  opts: { userId: string | null; confirmed: boolean; now?: Date }
): Promise<LaunchResult> {
  const now = opts.now ?? new Date();
  const campaign = await scopedRetargetingCampaign(workspaceId, campaignId);
  // Demo-mode guard (per-campaign): launching a real DM campaign is a real
  // external send — blocked server-side for demo workspaces (or
  // DEMO_MODE=true). Dry-run rehearsals, paid_ad exports, and the simulated
  // email/crm_sequence types make no external calls and stay allowed. DM
  // recipients are additionally guarded per-recipient inside sendFollowUp.
  if (
    !campaign.dryRun &&
    (campaign.type === "dm_reengagement" || campaign.type === "comment_to_dm")
  ) {
    await assertLiveSendAllowed(workspaceId);
  }
  if (opts.confirmed !== true) {
    throw new SendError(
      "Launch requires explicit confirmation — pass { confirmed: true }",
      422
    );
  }
  if (!["draft", "scheduled"].includes(campaign.status)) {
    throw new SendError(`Campaign cannot be launched from status ${campaign.status}`, 422);
  }

  // Build (or rebuild) the recipient list so launch always reflects the
  // current segment + eligibility state.
  const built = await buildRecipients(workspaceId, campaignId, {
    userId: opts.userId,
    now,
    dryRun: false,
  });

  if (campaign.type === "paid_ad") {
    // paid_ad: no sends, no ad creation — checklist + audience export.
    const { csv, exported, excluded } = await buildAudienceExportCsv(workspaceId, campaignId);
    await db.retargetingCampaign.update({
      where: { id: campaignId },
      data: { status: "completed", confirmedAt: now, startedAt: now, completedAt: now },
    });
    await auditLog(workspaceId, opts.userId, "retargeting.paid_ad_exported", {
      type: "retargeting_campaign",
      id: campaignId,
      exported,
      excluded,
    });
    return {
      status: "completed",
      dryRun: false,
      eligible: built.eligible,
      skipped: built.skipped,
      skippedSample: built.skippedSample,
      paidAd: {
        checklist: getPaidAdChecklist(),
        audienceCsv: csv,
        exported,
        excluded,
        note: "FlowPilot does not create ads or Custom Audiences in Meta. Import the CSV in Ads Manager (Audiences → Create Audience → Custom Audience → Customer list), then build the campaign there. API-based creation requires a connected Meta Marketing API integration, which is not yet implemented.",
      },
    };
  }

  if (built.eligible === 0 && !campaign.dryRun) {
    throw new SendError(
      "Launch blocked: no eligible recipients. Review the exclusions and adjust the segment or message timing.",
      422,
      { skippedSample: built.skippedSample }
    );
  }

  const updated = await db.retargetingCampaign.update({
    where: { id: campaignId },
    data: { status: "running", confirmedAt: now, startedAt: now },
  });
  await auditLog(workspaceId, opts.userId, "retargeting.launched", {
    type: "retargeting_campaign",
    id: campaignId,
    eligible: built.eligible,
    skipped: built.skipped,
    dryRun: campaign.dryRun,
  });
  return {
    status: updated.status,
    dryRun: campaign.dryRun,
    eligible: built.eligible,
    skipped: built.skipped,
    skippedSample: built.skippedSample,
  };
}

export interface ProcessDueResult {
  status: string;
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  simulated: number;
  completed: boolean;
  note?: string;
}

async function recordCampaignInteraction(args: {
  workspaceId: string;
  campaignId: string;
  contactId: string;
  provider: string;
  action: string;
  metadata: Record<string, unknown>;
  now: Date;
}): Promise<void> {
  await recordCustomerEvent({
    workspaceId: args.workspaceId,
    contactId: args.contactId,
    type: "campaign_interaction",
    provider: args.provider,
    providerEventId: `retargeting:${args.campaignId}:${args.contactId}:${args.action}`,
    source: "retargeting-engine",
    timestamp: args.now,
    metadata: { ...args.metadata, action: args.action },
    attribution: { retargetingCampaignId: args.campaignId },
  });
}

/**
 * Send the next batch of pending recipients (rate-capped). DM types go
 * through the real send pipeline (eligibility re-checked at send time);
 * email and crm_sequence are logged as SIMULATED/manual — never presented
 * as delivered. paid_ad campaigns never reach this function.
 */
export async function processDueRetargeting(
  workspaceId: string,
  campaignId: string,
  opts?: { userId?: string | null; limit?: number; now?: Date }
): Promise<ProcessDueResult> {
  const now = opts?.now ?? new Date();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const userId = opts?.userId ?? null;

  const campaign = await scopedRetargetingCampaign(workspaceId, campaignId);
  // Demo-mode guard (per-campaign): DM sends go through sendFollowUp, which
  // is guarded per-recipient — but fail fast here too so a demo workspace
  // (or DEMO_MODE=true) can never start a real send batch. Without this the
  // guard's 403 Response would be swallowed below as a per-recipient
  // "failed" row. Dry-run rehearsals and the simulated email/crm_sequence
  // types make no external calls and stay allowed.
  if (
    !campaign.dryRun &&
    (campaign.type === "dm_reengagement" || campaign.type === "comment_to_dm")
  ) {
    await assertLiveSendAllowed(workspaceId);
  }
  if (campaign.status !== "running") {
    return { status: campaign.status, processed: 0, sent: 0, skipped: 0, failed: 0, simulated: 0, completed: false, note: `campaign is ${campaign.status}, not running` };
  }
  if (campaign.type === "paid_ad") {
    throw new SendError("paid_ad campaigns have no sends to process — launch produces the audience export", 422);
  }

  const schedule = campaignSchedule(campaign);
  if (schedule.startsAt && now < new Date(schedule.startsAt)) {
    return { status: "running", processed: 0, sent: 0, skipped: 0, failed: 0, simulated: 0, completed: false, note: "schedule has not started yet" };
  }
  if (schedule.endsAt && now > new Date(schedule.endsAt)) {
    await db.retargetingCampaign.update({ where: { id: campaignId }, data: { status: "completed", completedAt: now } });
    return { status: "completed", processed: 0, sent: 0, skipped: 0, failed: 0, simulated: 0, completed: true, note: "schedule end reached" };
  }

  const pending = await db.retargetingRecipient.findMany({
    where: { campaignId, status: "pending" },
    orderBy: { id: "asc" },
    take: limit,
    include: { contact: true },
  });

  const msg = campaignMessage(campaign);
  const result: ProcessDueResult = {
    status: "running", processed: 0, sent: 0, skipped: 0, failed: 0, simulated: 0, completed: false,
  };

  for (const recipient of pending) {
    result.processed++;
    const eligibility = parseJson<Record<string, unknown>>(recipient.eligibility, {});
    try {
      if (campaign.dryRun) {
        // Dry-run rehearsal: record what WOULD happen, touch nothing real.
        await db.retargetingRecipient.update({
          where: { id: recipient.id },
          data: { status: "sent", sentAt: now, attempts: { increment: 1 } },
        });
        await recordCampaignInteraction({
          workspaceId, campaignId, contactId: recipient.contactId,
          provider: (eligibility.channel as string) ?? campaign.channel ?? campaign.type,
          action: "dry_run_send",
          metadata: { dryRun: true, simulated: true, channel: eligibility.channel ?? null },
          now,
        });
        result.sent++;
        result.simulated++;
        continue;
      }

      if (campaign.type === "dm_reengagement" || campaign.type === "comment_to_dm") {
        const channel = asSendChannel(String(eligibility.channel ?? campaign.channel));
        const messageType: EligibilityMessageType =
          eligibility.messageType === "private_reply" ? "private_reply"
          : eligibility.messageType === "template" ? "template"
          : "freeform";
        // NOTE: campaignId is intentionally NOT passed to sendFollowUp —
        // its field references the legacy Campaign table. Attribution goes
        // through our own campaign_interaction CustomerEvent below.
        const sendResult = await sendFollowUp({
          workspaceId,
          userId,
          contactId: recipient.contactId,
          channel,
          messageType,
          templateId: msg.templateId ?? null,
          body: msg.body,
          commentId: (eligibility.commentId as string | undefined) ?? null,
          idempotencyKey: retargetingRecipientKey(campaignId, recipient.contactId),
          now,
        });
        await db.retargetingRecipient.update({
          where: { id: recipient.id },
          data: {
            status: sendResult.status === "SENT" ? "sent" : "skipped",
            sentAt: sendResult.status === "SENT" ? now : null,
            attempts: { increment: 1 },
            eligibility: JSON.stringify({ ...eligibility, mocked: sendResult.mocked }),
          },
        });
        await recordCampaignInteraction({
          workspaceId, campaignId, contactId: recipient.contactId,
          provider: channel,
          action: sendResult.status === "SENT" ? "dm_sent" : "dm_skipped",
          metadata: { channel, messageType, mocked: sendResult.mocked, providerMessageId: sendResult.providerMessageId },
          now,
        });
        if (sendResult.status === "SENT") result.sent++;
        else result.skipped++;
        continue;
      }

      if (campaign.type === "email") {
        // SIMULATED: no email delivery provider is wired. Logged, not sent.
        await db.retargetingRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "sent", sentAt: now, attempts: { increment: 1 },
            eligibility: JSON.stringify({ ...eligibility, simulated: true }),
          },
        });
        await recordCampaignInteraction({
          workspaceId, campaignId, contactId: recipient.contactId,
          provider: "email",
          action: "email_simulated",
          metadata: { simulated: true, to: eligibility.address ?? null, note: "No email delivery provider connected — logged only, not delivered." },
          now,
        });
        result.sent++;
        result.simulated++;
        continue;
      }

      if (campaign.type === "crm_sequence") {
        // No automatic send — log the sequence step as a CRM task.
        await db.retargetingRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "sent", sentAt: now, attempts: { increment: 1 },
            eligibility: JSON.stringify({ ...eligibility, crmTask: true }),
          },
        });
        await recordCampaignInteraction({
          workspaceId, campaignId, contactId: recipient.contactId,
          provider: "crm",
          action: "sequence_step_logged",
          metadata: { note: "No automatic send — sequence step recorded as a CRM task for the owner.", sequence: msg.sequence ?? [] },
          now,
        });
        result.sent++;
        result.simulated++;
        continue;
      }

      throw new SendError(`Unknown campaign type "${campaign.type}"`, 500);
    } catch (e) {
      // Demo-mode policy block (403 Response from assertLiveSendAllowed) is
      // never a per-recipient failure — re-throw so the batch stops loudly
      // instead of recording misleading "failed" rows.
      if (e instanceof Response && e.status === 403) throw e;
      if (e instanceof SendError && e.status === 422) {
        // Eligibility lapsed or contact became suppressed between build and
        // send time — honest skip, never a silent failure.
        await db.retargetingRecipient.update({
          where: { id: recipient.id },
          data: { status: "skipped", lastError: e.message.slice(0, 2000), attempts: { increment: 1 } },
        });
        result.skipped++;
      } else {
        await db.retargetingRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "failed",
            lastError: (e instanceof Error ? e.message : String(e)).slice(0, 2000),
            attempts: { increment: 1 },
          },
        });
        await recordCampaignInteraction({
          workspaceId, campaignId, contactId: recipient.contactId,
          provider: (eligibility.channel as string) ?? campaign.type,
          action: "send_failed",
          metadata: { error: (e instanceof Error ? e.message : String(e)).slice(0, 500) },
          now,
        });
        result.failed++;
      }
    }
  }

  const remaining = await db.retargetingRecipient.count({
    where: { campaignId, status: "pending" },
  });
  if (remaining === 0) {
    await db.retargetingCampaign.update({
      where: { id: campaignId },
      data: { status: "completed", completedAt: now },
    });
    result.status = "completed";
    result.completed = true;
  }

  await auditLog(workspaceId, userId, "retargeting.processed", {
    type: "retargeting_campaign",
    id: campaignId,
    ...result,
  });
  return result;
}

export async function pauseRetargetingCampaign(
  workspaceId: string, campaignId: string, userId: string | null
): Promise<CampaignRow> {
  const campaign = await scopedRetargetingCampaign(workspaceId, campaignId);
  if (campaign.status !== "running") throw new SendError(`Cannot pause a ${campaign.status} campaign`, 422);
  const updated = await db.retargetingCampaign.update({
    where: { id: campaignId }, data: { status: "paused" },
  });
  await auditLog(workspaceId, userId, "retargeting.paused", { type: "retargeting_campaign", id: campaignId });
  return updated as CampaignRow;
}

export async function resumeRetargetingCampaign(
  workspaceId: string, campaignId: string, userId: string | null
): Promise<CampaignRow> {
  const campaign = await scopedRetargetingCampaign(workspaceId, campaignId);
  if (campaign.status !== "paused") throw new SendError(`Cannot resume a ${campaign.status} campaign`, 422);
  const updated = await db.retargetingCampaign.update({
    where: { id: campaignId }, data: { status: "running" },
  });
  await auditLog(workspaceId, userId, "retargeting.resumed", { type: "retargeting_campaign", id: campaignId });
  return updated as CampaignRow;
}

export async function stopRetargetingCampaign(
  workspaceId: string, campaignId: string, userId: string | null
): Promise<CampaignRow> {
  const campaign = await scopedRetargetingCampaign(workspaceId, campaignId);
  if (!["running", "paused", "scheduled", "draft"].includes(campaign.status)) {
    throw new SendError(`Cannot stop a ${campaign.status} campaign`, 422);
  }
  const updated = await db.retargetingCampaign.update({
    where: { id: campaignId }, data: { status: "cancelled", completedAt: new Date() },
  });
  await auditLog(workspaceId, userId, "retargeting.stopped", { type: "retargeting_campaign", id: campaignId });
  return updated as CampaignRow;
}

export interface ReportMetric {
  value: number | null;
  /** measured = read from real data; estimated = heuristic; not_tracked = no data source exists. */
  source: "measured" | "estimated" | "not_tracked";
  note?: string;
}

export interface RetargetingReport {
  campaignId: string;
  status: string;
  type: string;
  dryRun: boolean;
  recipients: Record<string, number>;
  attempted: ReportMetric;
  delivered: ReportMetric;
  failed: ReportMetric;
  replies: ReportMetric;
  clicks: ReportMetric;
  conversions: ReportMetric;
  spend: ReportMetric;
  roas: ReportMetric;
  simulatedSends: number;
  mockedSends: number;
}

/**
 * Campaign report. Every metric is labeled measured / estimated / not_tracked.
 * Revenue, spend and ROAS are NEVER invented: without a connected Meta
 * Marketing API (paid_ad) or conversion events, they report "not tracked".
 */
export async function retargetingReport(
  workspaceId: string,
  campaignId: string
): Promise<RetargetingReport> {
  const campaign = await scopedRetargetingCampaign(workspaceId, campaignId);

  const grouped = await db.retargetingRecipient.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { status: true },
  });
  const byStatus: Record<string, number> = {};
  for (const g of grouped) byStatus[g.status] = g._count.status;
  const sent = byStatus.sent ?? 0;
  const failed = byStatus.failed ?? 0;
  const skipped = byStatus.skipped ?? 0;
  const pending = byStatus.pending ?? 0;
  const replied = byStatus.replied ?? 0;
  const delivered = byStatus.delivered ?? 0;

  const recipientContacts = await db.retargetingRecipient.findMany({
    where: { campaignId },
    select: { contactId: true, eligibility: true },
  });
  const contactIds = recipientContacts.map((r) => r.contactId);
  let mockedSends = 0;
  let simulatedSends = 0;
  for (const r of recipientContacts) {
    const e = parseJson<Record<string, unknown>>(r.eligibility, {});
    if (e.mocked === true) mockedSends++;
    if (e.simulated === true) simulatedSends++;
  }

  // Replies: inbound messages from campaign contacts after launch — measured
  // but approximate (we can't prove the reply was caused by the campaign).
  let replyEvents = 0;
  if (campaign.startedAt && contactIds.length > 0) {
    replyEvents = await db.customerEvent.count({
      where: {
        workspaceId,
        type: "message_received",
        contactId: { in: contactIds },
        timestamp: { gte: campaign.startedAt },
      },
    });
  }

  // Clicks / conversions: only events that carry our retargeting attribution.
  // attribution is a JSON string — filter in JS to stay DB-agnostic.
  const attributed = await db.customerEvent.findMany({
    where: {
      workspaceId,
      type: { in: ["campaign_interaction", "conversion_attributed"] },
    },
    select: { type: true, attribution: true, metadata: true },
  });
  let clicks = 0;
  let conversions = 0;
  for (const ev of attributed) {
    const attr = parseJson<Record<string, unknown>>(ev.attribution, {});
    if (attr.retargetingCampaignId !== campaignId) continue;
    const meta = parseJson<Record<string, unknown>>(ev.metadata, {});
    if (ev.type === "conversion_attributed") conversions++;
    else if (meta.action === "click") clicks++;
  }

  const budget = parseJson<{ amount?: number; currency?: string }>(campaign.budget, {});

  return {
    campaignId,
    status: campaign.status,
    type: campaign.type,
    dryRun: campaign.dryRun,
    recipients: { sent, delivered, failed, skipped, pending, replied },
    attempted: { value: sent + failed, source: "measured", note: "recipients with a send attempted" },
    delivered: {
      value: delivered,
      source: campaign.type === "dm_reengagement" || campaign.type === "comment_to_dm" ? "measured" : "not_tracked",
      note:
        campaign.type === "dm_reengagement" || campaign.type === "comment_to_dm"
          ? "delivery receipts are not pushed by all adapters; 'sent' is the reliable signal"
          : `${campaign.type} has no delivery channel in FlowPilot`,
    },
    failed: { value: failed, source: "measured" },
    replies: {
      value: replied + replyEvents,
      source: "estimated",
      note: "Inbound messages from campaign contacts after launch — approximate; not provably caused by this campaign.",
    },
    clicks: {
      value: clicks,
      source: "measured",
      note: clicks === 0 ? "No click events with this campaign's attribution were recorded." : undefined,
    },
    conversions: {
      value: conversions,
      source: conversions > 0 ? "measured" : "not_tracked",
      note:
        conversions > 0
          ? "conversion_attributed events carrying this campaign's attribution"
          : "No conversion events attributed to this campaign. Connect a store adapter or the Meta Conversions API to track real revenue.",
    },
    spend: {
      value: null,
      source: "not_tracked",
      note:
        campaign.type === "paid_ad"
          ? "Real ad spend lives in Meta Ads Manager. FlowPilot has no Meta Marketing API connection, so spend is not tracked — check Ads Manager."
          : `Planned budget${budget.amount ? `: ${budget.amount} ${budget.currency ?? ""}`.trim() : " not set"}. No media spend applies to ${campaign.type}.`,
    },
    roas: {
      value: null,
      source: "not_tracked",
      note: "ROAS requires real spend AND real attributed revenue — neither is tracked by FlowPilot today.",
    },
    simulatedSends,
    mockedSends,
  };
}
