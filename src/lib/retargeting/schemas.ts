/**
 * Phase B — Retargeting Center: Zod validation schemas + serializers.
 */
import { z } from "zod";
import type { ConditionGroup } from "./segments";
import { parseJson } from "../serialize";

/* ------------------------- condition tree ------------------------- */

const conditionLeafSchema = z.object({
  field: z.enum([
    "tag",
    "channel",
    "leadStatus",
    "lastInboundAt",
    "messageCount",
    "purchaseCount",
    "abandonedCart",
    "optedOut",
    "email",
    "phone",
  ]),
  operator: z.string().min(1).max(40),
  value: z.unknown().optional(),
});

interface ConditionGroupInput {
  op: "and" | "or";
  rules: Array<z.infer<typeof conditionLeafSchema> | ConditionGroupInput>;
}

export const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.object({
    op: z.enum(["and", "or"]),
    rules: z
      .array(z.union([conditionLeafSchema, conditionGroupSchema as z.ZodType<ConditionGroupInput>]))
      .max(100),
  })
) as unknown as z.ZodType<ConditionGroup>;

/* ------------------------- segments ------------------------- */

export const segmentCreateSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(1000).default(""),
  conditions: conditionGroupSchema,
});

export const segmentUpdateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(1000).optional(),
  conditions: conditionGroupSchema.optional(),
});

/* ------------------------- campaigns ------------------------- */

export const retargetingTypeSchema = z.enum([
  "dm_reengagement",
  "email",
  "paid_ad",
  "comment_to_dm",
  "crm_sequence",
]);

const scheduleSchema = z.object({
  startsAt: z.string().max(120).optional().nullable(),
  endsAt: z.string().max(120).optional().nullable(),
  timezone: z.string().max(80).optional().nullable(),
  frequencyCap: z
    .object({ maxPerContactPerDay: z.number().int().min(1).max(10).optional() })
    .optional()
    .nullable(),
});

function isoDateString(v: string | null | undefined, path: string, ctx: z.RefinementCtx) {
  if (v == null || v === "") return;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "must be a valid ISO date string" });
  }
}

const DM_CHANNELS = ["instagram", "facebook", "whatsapp"] as const;

export const retargetingCampaignCreateSchema = z
  .object({
    name: z.string().min(2).max(120),
    type: retargetingTypeSchema,
    channel: z.enum(["instagram", "facebook", "whatsapp", "email"]).optional().nullable(),
    integrationId: z.string().min(1).max(64).optional().nullable(),
    segmentId: z.string().min(1).max(64).optional().nullable(),
    objective: z.string().max(2000).default(""),
    message: z.record(z.unknown()).default({}),
    schedule: scheduleSchema.default({}),
    budget: z
      .object({
        amount: z.number().nonnegative().optional(),
        currency: z.string().max(10).optional(),
      })
      .default({}),
    dryRun: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    isoDateString(v.schedule?.startsAt, "schedule.startsAt", ctx);
    isoDateString(v.schedule?.endsAt, "schedule.endsAt", ctx);
    if (v.schedule?.startsAt && v.schedule?.endsAt) {
      if (new Date(v.schedule.startsAt) >= new Date(v.schedule.endsAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schedule.endsAt"],
          message: "endsAt must be after startsAt",
        });
      }
    }
    const ch = v.channel ?? null;
    switch (v.type) {
      case "dm_reengagement":
        if (!ch || !(DM_CHANNELS as readonly string[]).includes(ch)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["channel"],
            message: "dm_reengagement requires channel instagram | facebook | whatsapp",
          });
        }
        break;
      case "comment_to_dm":
        if (ch !== "instagram" && ch !== "facebook") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["channel"],
            message: "comment_to_dm requires channel instagram | facebook (private replies are not supported on WhatsApp)",
          });
        }
        break;
      case "email":
        if (ch !== "email" && ch !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["channel"],
            message: 'email campaigns use channel "email" (or leave unset)',
          });
        }
        break;
      case "paid_ad":
      case "crm_sequence":
        if (ch !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["channel"],
            message: `${v.type} campaigns have no send channel — leave channel unset`,
          });
        }
        break;
    }
    const msg = v.message as Record<string, unknown>;
    if ((v.type === "dm_reengagement" || v.type === "comment_to_dm" || v.type === "email") && !v.dryRun) {
      if (typeof msg.body !== "string" || msg.body.trim() === "") {
        if (typeof msg.templateId !== "string" || msg.templateId.trim() === "") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["message.body"],
            message: "message.body (or message.templateId) is required for this campaign type",
          });
        }
      }
    }
  });

export const retargetingCampaignPatchSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    objective: z.string().max(2000).optional(),
    channel: z.enum(["instagram", "facebook", "whatsapp", "email"]).optional().nullable(),
    integrationId: z.string().min(1).max(64).optional().nullable(),
    segmentId: z.string().min(1).max(64).optional().nullable(),
    message: z.record(z.unknown()).optional(),
    schedule: scheduleSchema.optional(),
    budget: z
      .object({
        amount: z.number().nonnegative().optional(),
        currency: z.string().max(10).optional(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    isoDateString(v.schedule?.startsAt, "schedule.startsAt", ctx);
    isoDateString(v.schedule?.endsAt, "schedule.endsAt", ctx);
  });

export const launchSchema = z.object({
  confirmed: z.literal(true, {
    errorMap: () => ({ message: "Explicit confirmation required: pass { confirmed: true }" }),
  }),
});

/* ------------------------- serializers ------------------------- */

export function serializeRetargetingSegment(s: {
  id: string;
  name: string;
  description: string;
  conditions: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    conditions: parseJson<ConditionGroup>(s.conditions, { op: "and", rules: [] }),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function serializeRetargetingCampaign(c: {
  id: string;
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
}) {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    status: c.status,
    channel: c.channel,
    integrationId: c.integrationId,
    segmentId: c.segmentId,
    objective: c.objective,
    message: parseJson<Record<string, unknown>>(c.message, {}),
    schedule: parseJson<Record<string, unknown>>(c.schedule, {}),
    budget: parseJson<Record<string, unknown>>(c.budget, {}),
    dryRun: c.dryRun,
    confirmedAt: c.confirmedAt?.toISOString() ?? null,
    startedAt: c.startedAt?.toISOString() ?? null,
    completedAt: c.completedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function serializeRetargetingRecipient(r: {
  id: string;
  campaignId: string;
  contactId: string;
  status: string;
  eligibility: string;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  contact?: { name: string; email: string | null; phone: string | null } | null;
}) {
  return {
    id: r.id,
    campaignId: r.campaignId,
    contactId: r.contactId,
    contactName: r.contact?.name ?? null,
    contactEmail: r.contact?.email ?? null,
    contactPhone: r.contact?.phone ?? null,
    status: r.status,
    eligibility: parseJson<Record<string, unknown>>(r.eligibility, {}),
    attempts: r.attempts,
    lastError: r.lastError,
    sentAt: r.sentAt?.toISOString() ?? null,
  };
}
