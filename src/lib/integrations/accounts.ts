/**
 * Batch B — multi-account Integration row helpers.
 *
 * One workspace may now hold MULTIPLE connected accounts of the same
 * provider, keyed by their provider-side identity:
 *   @@unique([workspaceId, provider, externalAccountId])
 *
 * Every connect path MUST go through `upsertAccountRow` (find-or-create by
 * that triple) instead of the old per-provider upsert, so connecting a
 * second account NEVER overwrites the first account's credentials.
 * `externalAccountId = null` identifies the legacy placeholder row for a
 * provider (seeded/demo rows); SQLite treats NULLs as distinct in unique
 * indexes, so lookups for the placeholder use findFirst semantics here
 * rather than the compound unique key.
 */

import { db } from "@/lib/db";
import type { Integration, Prisma } from "@prisma/client";

/** Find the account row for an exact (workspace, provider, external id). */
export async function findAccountRow(
  workspaceId: string,
  provider: string,
  externalAccountId: string | null
): Promise<Integration | null> {
  return db.integration.findFirst({
    where: { workspaceId, provider, externalAccountId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Find-or-create/update the account row for (workspace, provider,
 * externalAccountId). Returns the row. On a unique-race (two concurrent
 * connects of the same account), the loser re-reads and updates the
 * winner's row instead of throwing or creating a duplicate.
 */
export async function upsertAccountRow(args: {
  workspaceId: string;
  provider: string;
  externalAccountId: string | null;
  /**
   * Either create-input flavor the Prisma client accepts: scalar style
   * (`workspaceId: ...`) or relation style (`workspace: { connect: ... }`)
   * — call sites use both.
   */
  create: Prisma.IntegrationCreateInput | Prisma.IntegrationUncheckedCreateInput;
  update: Prisma.IntegrationUpdateInput;
}): Promise<Integration> {
  const existing = await findAccountRow(
    args.workspaceId,
    args.provider,
    args.externalAccountId
  );
  if (existing) {
    return db.integration.update({ where: { id: existing.id }, data: args.update });
  }
  try {
    return await db.integration.create({ data: args.create });
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "P2002") {
      const winner = await findAccountRow(
        args.workspaceId,
        args.provider,
        args.externalAccountId
      );
      if (winner) {
        return db.integration.update({ where: { id: winner.id }, data: args.update });
      }
    }
    throw e;
  }
}

/**
 * Default-account invariant: at most one CONNECTED account per
 * (workspace, provider) pair carries isDefault. Called after a connect
 * lands a row in CONNECTED status: if the pair has no default yet, this
 * account becomes it (the first verified CONNECTED account wins). Runs in
 * a transaction so concurrent connects cannot produce two defaults.
 */
export async function ensureDefaultAccount(
  workspaceId: string,
  provider: string,
  integrationId: string
): Promise<void> {
  await db.$transaction(async (tx) => {
    const row = await tx.integration.findFirst({
      where: { id: integrationId, workspaceId, provider },
      select: { id: true, status: true, isDefault: true },
    });
    if (!row || row.status !== "CONNECTED") return;
    if (row.isDefault) return;
    const currentDefault = await tx.integration.findFirst({
      where: { workspaceId, provider, status: "CONNECTED", isDefault: true },
      select: { id: true },
    });
    if (currentDefault) return;
    await tx.integration.update({
      where: { id: row.id },
      data: { isDefault: true },
    });
  });
}

/**
 * Explicitly make one account the default for its (workspace, provider)
 * pair: clears the flag on every sibling row and sets it on this one,
 * atomically. Returns the updated row, or null when the account is not in
 * the workspace.
 */
export async function setDefaultAccount(
  workspaceId: string,
  integrationId: string
): Promise<Integration | null> {
  return db.$transaction(async (tx) => {
    const row = await tx.integration.findFirst({
      where: { id: integrationId, workspaceId },
    });
    if (!row) return null;
    await tx.integration.updateMany({
      where: { workspaceId, provider: row.provider, isDefault: true },
      data: { isDefault: false },
    });
    return tx.integration.update({
      where: { id: row.id },
      data: { isDefault: true },
    });
  });
}

/**
 * Diagnostic logger for ambiguous/unresolvable account routing. Counts and
 * ids only — NEVER credentials or message content.
 */
export function logAccountRoutingDiagnostic(
  scope: string,
  detail: Record<string, unknown>
): void {
  console.error(`[accounts] ${scope}`, detail);
}
