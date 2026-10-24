import { db } from "../db";
import { err } from "../api";
import { assertLiveSendAllowed } from "../demo/guard";
import { getEmailSender } from "./sender";

/**
 * Guarded email send (Workstream A).
 *
 * CENTRAL CONTRACT for transactional email: every send path MUST go through
 * this helper (or `assertEmailSendAllowedForUser` below) so that
 * `assertLiveSendAllowed(workspaceId)` runs BEFORE any external send.
 *
 * Throws a Response (never returns a fake success):
 * - 503 { error: "Email not configured", code: "EMAIL_NOT_CONFIGURED" }
 *   when no provider is configured — callers surface this honestly.
 * - 403 from the demo-mode guard when sends are blocked for the workspace.
 * Route handlers wrapped in `handler()` return these Responses as-is.
 */
export async function sendGuardedEmail(
  workspaceId: string,
  to: string,
  subject: string,
  html: string
): Promise<{ ok: boolean; messageId?: string }> {
  const sender = getEmailSender();
  if (!sender) {
    throw err("Email not configured", 503, { code: "EMAIL_NOT_CONFIGURED" });
  }
  await assertLiveSendAllowed(workspaceId);
  return sender.send(to, subject, html);
}

/**
 * Guard variant for flows with no single workspace in context (e.g. password
 * reset for a signed-out user): applies `assertLiveSendAllowed` across every
 * workspace the user belongs to. When the user has no memberships, a
 * sentinel id is still passed through the guard so the global DEMO_MODE
 * check is enforced. Throws the same 403 Response as the guard.
 */
export async function assertEmailSendAllowedForUser(
  userId: string
): Promise<void> {
  const memberships = await db.membership.findMany({
    where: { userId },
    select: { workspaceId: true },
  });
  const ids = memberships.map((m) => m.workspaceId);
  // No memberships: the guard's findUnique misses, but its global DEMO_MODE
  // check still runs first — exactly the enforcement we need here.
  if (ids.length === 0) ids.push("__no_workspace__");
  for (const id of ids) {
    await assertLiveSendAllowed(id);
  }
}
