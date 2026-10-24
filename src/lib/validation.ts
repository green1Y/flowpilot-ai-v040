import { z } from "zod";

// Shared Zod schemas for API validation.

export const signupSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email().max(160),
  password: z.string().min(8).max(128),
  workspaceName: z.string().min(2).max(80).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Minimum bar for a newly-chosen password. Reused by the password-change
 * route contract and the password-reset confirm route (Workstream A) so both
 * enforce the same strength rule.
 */
export const newPasswordSchema = z.string().min(8).max(200);

export const workspaceCreateSchema = z.object({
  name: z.string().min(2).max(80),
});

export const contactSchema = z.object({
  name: z.string().min(1).max(120),
  channel: z.string().max(40).default("web"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(40).optional(),
  tags: z.array(z.string()).default([]),
  leadStatus: z.enum(["NEW", "CONTACTED", "QUALIFIED", "INTERESTED", "CONVERTED", "LOST"]).default("NEW"),
  leadScore: z.number().int().min(0).max(100).default(0),
  customFields: z.record(z.string()).default({}),
  notes: z.string().max(4000).default(""),
  assignedTo: z.string().optional(),
});

export const contactPatchSchema = contactSchema.partial();

export const workflowNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["trigger", "condition", "action", "flow"]),
  type: z.string(),
  label: z.string(),
  config: z.record(z.unknown()).default({}),
  position: z.object({ x: z.number(), y: z.number() }),
  disabled: z.boolean().default(false),
});

export const workflowEdgeSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  label: z.string().default(""),
  condition: z.record(z.unknown()).default({}),
});

export const workflowCreateSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(1000).default(""),
  nodes: z.array(workflowNodeSchema).default([]),
  edges: z.array(workflowEdgeSchema).default([]),
});

export const workflowUpdateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(1000).optional(),
  nodes: z.array(workflowNodeSchema).optional(),
  edges: z.array(workflowEdgeSchema).optional(),
  // Conflict-safe autosave: when present, the update is rejected with 409
  // if the row changed since this timestamp (another tab/user saved first).
  expectedUpdatedAt: z.string().datetime().optional(),
});

export const executeSchema = z.object({
  event: z.record(z.unknown()),
  idempotencyKey: z.string().min(8).max(128),
  dryRun: z.boolean().default(false),
});

export const messageCreateSchema = z.object({
  body: z.string().min(1).max(4000),
  aiGenerated: z.boolean().default(false),
});

export const aiConfigSchema = z.object({
  assistantName: z.string().min(2).max(80),
  businessName: z.string().max(120).default(""),
  businessDescription: z.string().max(2000).default(""),
  brandVoice: z.string().max(40).default("friendly"),
  tone: z.string().max(40).default("professional"),
  responseLength: z.enum(["concise", "balanced", "detailed"]).default("concise"),
  languages: z.array(z.string()).default(["en"]),
  businessHours: z.record(z.unknown()).default({}),
  escalationRules: z.record(z.unknown()).default({}),
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
  requireApproval: z.boolean().default(true),
  fallbackResponse: z.string().max(1000),
  prohibitedTopics: z.array(z.string()).default([]),
});

export const knowledgeDocSchema = z.object({
  title: z.string().min(2).max(160),
  content: z.string().min(10).max(20000),
});

export const campaignSchema = z.object({
  name: z.string().min(2).max(120),
  objective: z.string().max(500).default(""),
  channel: z.string().max(40),
  audience: z.record(z.unknown()).default({}),
  message: z.record(z.unknown()).default({}),
  scheduledAt: z.string().datetime().optional(),
  // Stage 3: audience source + send configuration.
  segmentId: z.string().min(1).max(64).optional(),
  templateId: z.string().min(1).max(64).nullable().optional(),
  messageType: z.enum(["freeform", "template", "private_reply"]).default("freeform"),
  ratePerSecond: z.number().min(0.1).max(50).default(1),
  pauseOnReply: z.boolean().default(true),
});

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["ADMIN", "MANAGER", "AGENT", "ANALYST"]).default("AGENT"),
});

// --- Stage 1: contact segments (saved filter sets) ---

export const contactSegmentFiltersSchema = z.object({
  channel: z.string().max(40).optional(),
  tag: z.string().max(60).optional(),
  leadStatus: z
    .enum(["NEW", "CONTACTED", "QUALIFIED", "INTERESTED", "CONVERTED", "LOST"])
    .optional(),
  search: z.string().max(120).optional(),
  from: z.string().max(40).optional(), // interaction date range (ISO-ish)
  to: z.string().max(40).optional(),
});

export const contactSegmentSchema = z.object({
  name: z.string().min(2).max(80),
  filters: contactSegmentFiltersSchema.default({}),
});

// --- Meta integrations (Instagram / Facebook Messenger / WhatsApp) ---

export const metaAuthorizeSchema = z.object({
  provider: z.enum(["instagram", "facebook", "whatsapp"]),
});

export const metaSelectSchema = z.object({
  provider: z.enum(["instagram", "facebook"]),
  pageId: z.string().min(1).max(64),
});

export const whatsappManualSchema = z.object({
  phoneNumberId: z.string().min(1).max(64),
  accessToken: z.string().min(10).max(500),
  displayName: z.string().max(120).optional(),
  wabaId: z.string().max(64).optional(),
});

export const metaPagesQuerySchema = z.object({
  provider: z.enum(["instagram", "facebook", "whatsapp"]).optional(),
});

// --- E-commerce adapter (Stage 4e) ---

// Order ids are alphanumeric-ish across store providers (Shopify numeric
// ids, custom prefixed ids like DEMO-1001). Anything else is rejected so
// unknown input never reaches a provider lookup.
export const orderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "orderId may only contain letters, numbers, - and _");

export const linkOrderSchema = z.object({
  orderId: orderIdSchema,
});

export const ecommerceOrdersQuerySchema = z.object({
  contactId: z.string().min(1).max(64).optional(),
  orderId: orderIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
