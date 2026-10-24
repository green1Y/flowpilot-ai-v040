/**
 * Shared helpers for the Comment-to-DM API routes (workspace scoping +
 * the honest BLOCKED response). No route logic lives here.
 */
import { db } from "@/lib/db";
import { err } from "@/lib/api";
import type { Integration } from "@prisma/client";

/** Workspace-scoped rule lookup; 404 when it belongs to another tenant. */
export async function findWorkspaceRule(workspaceId: string, id: string) {
  const rule = await db.commentDmRule.findFirst({
    where: { id, workspaceId },
  });
  if (!rule) throw err("Comment-to-DM rule not found", 404);
  return rule;
}

/**
 * Workspace-scoped Instagram account lookup. Throws a 404 for a missing
 * row (including rows of another workspace) and a 400 for a row of a
 * different provider — never silently re-routes to another account.
 */
export async function findWorkspaceInstagramAccount(
  workspaceId: string,
  integrationId: string
): Promise<Integration> {
  const row = await db.integration.findFirst({
    where: { id: integrationId, workspaceId },
  });
  if (!row) throw err("Connected account not found in this workspace", 404);
  if (row.provider !== "instagram") {
    throw err("That account is not an Instagram account", 400);
  }
  return row;
}

/**
 * Honest BLOCKED response: the UI shows `error` as the prerequisite
 * (e.g. "connect an Instagram account first") instead of receiving fake
 * or empty data. `blocked: true` lets clients distinguish it from a
 * generic failure.
 */
export function blocked(message: string, status = 409) {
  return Response.json({ ok: false, blocked: true, error: message }, { status });
}

/** Minimal account shape for the UI picker (never includes credentials). */
export function serializeAccount(row: Integration) {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    accountName: row.accountName,
    externalAccountId: row.externalAccountId,
    isDefault: row.isDefault,
  };
}
