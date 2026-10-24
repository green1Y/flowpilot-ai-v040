// Stage 4a — Inbox hardening validation schemas.
import { z } from "zod";

// Priority accepts the lowercase UI values and the existing uppercase
// storage values, normalizing to the existing uppercase convention
// (LOW | NORMAL | HIGH | URGENT).
export const prioritySchema = z
  .string()
  .refine((v) => ["low", "normal", "high", "urgent"].includes(v.toLowerCase()), {
    message: "priority must be one of low | normal | high | urgent",
  })
  .transform((v) => v.toUpperCase());

export const conversationPatchSchema = z
  .object({
    // user id to assign; null (or "") clears the assignment.
    assignedTo: z.string().max(64).nullable().optional(),
    priority: prioritySchema.optional(),
    humanTakeover: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });

export const internalNoteSchema = z.object({
  body: z.string().min(1).max(4000),
});

export const typingSchema = z.object({
  active: z.boolean().default(true),
});

export const analyticsDetailQuerySchema = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  channel: z.string().max(40).optional(),
  campaignId: z.string().max(64).optional(),
  stage: z
    .enum(["NEW", "CONTACTED", "QUALIFIED", "INTERESTED", "CONVERTED", "LOST"])
    .optional(),
});

export const analyticsExportQuerySchema = z.object({
  metric: z.enum(["messages", "campaigns", "leads"]),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  channel: z.string().max(40).optional(),
});
