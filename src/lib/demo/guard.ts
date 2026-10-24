import { db } from "../db";

/**
 * Demo-mode server-side send guard (Batch A public-beta readiness).
 *
 * CENTRAL CONTRACT: every real external send — messaging providers, workflow
 * engine action executors, campaign/bulk sending, and the email sender — MUST
 * call `assertLiveSendAllowed(workspaceId)` before performing the send.
 * This is enforced server-side so manually constructed requests and modified
 * client state cannot bypass it.
 *
 * A send is blocked when EITHER:
 * - the workspace has `isDemo = true` (per-workspace demo flag), OR
 * - `process.env.DEMO_MODE === "true"` (global demo deployment).
 *
 * Thrown as a 403 `Response`, matching the project's existing error
 * convention in route handlers (see src/lib/tenancy.ts).
 */
export async function assertLiveSendAllowed(workspaceId: string): Promise<void> {
  if (process.env.DEMO_MODE === "true") {
    throw Response.json(
      { error: "Demo mode: external sends are disabled", code: "DEMO_MODE_SEND_BLOCKED" },
      { status: 403 }
    );
  }
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { isDemo: true },
  });
  if (ws?.isDemo) {
    throw Response.json(
      { error: "Demo workspace: external sends are disabled", code: "DEMO_WORKSPACE_SEND_BLOCKED" },
      { status: 403 }
    );
  }
}

/** Non-throwing check, for UI state (e.g. showing "Demo" badges). */
export async function isDemoWorkspace(workspaceId: string): Promise<boolean> {
  if (process.env.DEMO_MODE === "true") return true;
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { isDemo: true },
  });
  return ws?.isDemo ?? false;
}
