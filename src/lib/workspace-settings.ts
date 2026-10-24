/**
 * Phase 4 — Workspace settings: workflow execution defaults + workspace
 * notification toggles. Stored as JSON on WorkspaceSettings; defaults are
 * merged on read so new keys are always additive.
 */
import { z } from "zod";
import { db } from "./db";

export const automationDefaults = {
  maxRetries: 3,
  backoffBaseMs: 5000,
  rateLimitPerMinute: 60,
  dedupeEnabled: true,
} as const;

export const workspaceNotifDefaults = {
  workflowFailures: true,
  integrationDisconnected: true,
  quotaWarnings: true,
  emailAlerts: false,
} as const;

/** Per-user notification preferences (stored on User.notificationPrefs). */
export const userNotifDefaults = {
  newMessage: true,
  aiApproval: true,
  mention: true,
  weeklyDigest: false,
} as const;

const automationSchema = z.object({
  maxRetries: z.number().int().min(0).max(10).default(automationDefaults.maxRetries),
  backoffBaseMs: z.number().int().min(1000).max(300000).default(automationDefaults.backoffBaseMs),
  rateLimitPerMinute: z.number().int().min(1).max(10000).default(automationDefaults.rateLimitPerMinute),
  dedupeEnabled: z.boolean().default(automationDefaults.dedupeEnabled),
});

const workspaceNotifSchema = z.object({
  workflowFailures: z.boolean().default(workspaceNotifDefaults.workflowFailures),
  integrationDisconnected: z.boolean().default(workspaceNotifDefaults.integrationDisconnected),
  quotaWarnings: z.boolean().default(workspaceNotifDefaults.quotaWarnings),
  emailAlerts: z.boolean().default(workspaceNotifDefaults.emailAlerts),
});

/** Full settings payload accepted by PUT /api/workspace/settings (partial ok). */
export const workspaceSettingsSchema = z
  .object({
    automation: automationSchema.partial().optional(),
    notifications: workspaceNotifSchema.partial().optional(),
  })
  .strict();

export type WorkspaceSettingsPayload = z.infer<typeof workspaceSettingsSchema>;

export interface ResolvedWorkspaceSettings {
  automation: z.infer<typeof automationSchema>;
  notifications: z.infer<typeof workspaceNotifSchema>;
}

function safeParseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Read workspace settings with defaults merged in. Never throws on bad JSON. */
export async function getWorkspaceSettings(workspaceId: string): Promise<ResolvedWorkspaceSettings> {
  const row = await db.workspaceSettings.findUnique({ where: { workspaceId } });
  const raw = safeParseJson(row?.settings);
  const automationRaw = raw.automation;
  const notificationsRaw = raw.notifications;
  const automation = automationSchema.parse(
    automationRaw && typeof automationRaw === "object" ? automationRaw : {}
  );
  const notifications = workspaceNotifSchema.parse(
    notificationsRaw && typeof notificationsRaw === "object" ? notificationsRaw : {}
  );
  return { automation, notifications };
}

/**
 * Merge a partial payload over the stored settings and persist.
 * Unknown keys are dropped by the Zod schema (strict object with optional
 * sub-objects validated via .partial()).
 */
export async function updateWorkspaceSettings(
  workspaceId: string,
  patch: WorkspaceSettingsPayload
): Promise<ResolvedWorkspaceSettings> {
  const current = await getWorkspaceSettings(workspaceId);
  const next = {
    automation: { ...current.automation, ...(patch.automation ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
  };
  await db.workspaceSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, settings: JSON.stringify(next) },
    update: { settings: JSON.stringify(next) },
  });
  return next;
}

/** Per-user notification prefs with defaults merged. Never throws on bad JSON. */
export function resolveUserNotifPrefs(raw: string | null | undefined) {
  const parsed = safeParseJson(raw);
  return {
    newMessage: typeof parsed.newMessage === "boolean" ? parsed.newMessage : userNotifDefaults.newMessage,
    aiApproval: typeof parsed.aiApproval === "boolean" ? parsed.aiApproval : userNotifDefaults.aiApproval,
    mention: typeof parsed.mention === "boolean" ? parsed.mention : userNotifDefaults.mention,
    weeklyDigest: typeof parsed.weeklyDigest === "boolean" ? parsed.weeklyDigest : userNotifDefaults.weeklyDigest,
  };
}

export const userNotifPrefsSchema = z
  .object({
    newMessage: z.boolean().optional(),
    aiApproval: z.boolean().optional(),
    mention: z.boolean().optional(),
    weeklyDigest: z.boolean().optional(),
  })
  .strict();
