import { ResendEmailSender } from "./resend";

/**
 * Email sender abstraction (Workstream A — public-beta readiness).
 *
 * All transactional email (verification codes, password resets) goes through
 * this interface so the provider can be swapped without touching call sites.
 * Every send path MUST call `assertLiveSendAllowed(workspaceId)` BEFORE
 * sending (see ./send.ts) — never send from a new call site without it.
 *
 * Honesty contract: `getEmailSender()` returns null when no provider is
 * configured. Callers must surface an honest 503 EMAIL_NOT_CONFIGURED —
 * never pretend an email was sent, and never mark anything verified unless
 * a real send + verify round-trip succeeded.
 */
export interface EmailSender {
  send(
    to: string,
    subject: string,
    html: string
  ): Promise<{ ok: boolean; messageId?: string }>;
}

/**
 * Resolve the configured email sender, or null when email is not configured
 * (RESEND_API_KEY or EMAIL_FROM unset). Credentials come from env ONLY —
 * never hardcode, never log.
 */
export function getEmailSender(): EmailSender | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return null;
  return new ResendEmailSender(apiKey, from);
}
