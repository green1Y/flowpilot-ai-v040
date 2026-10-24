/**
 * Email campaign sending (Wave 2E).
 *
 * One email-campaign send for one recipient, with the same honesty
 * contract as the rest of the email stack:
 *
 *  - Suppression wins: a Suppression row for channel "email" OR for all
 *    channels (channel null) means the recipient is SKIPPED, never sent.
 *    (Same rule as isSuppressed() in lib/messaging/send.ts, re-implemented
 *    here as a direct query so this module does not pull in the Meta
 *    messaging pipeline.)
 *  - Demo-mode guard: assertLiveSendAllowed() runs BEFORE any provider
 *    call. Its 403 Response propagates (the batch route re-throws it so
 *    a policy block stops the batch loudly instead of recording fake
 *    per-recipient failures).
 *  - Template variables come ONLY from verified contact fields: name,
 *    firstName (first token of name), company (the contact's explicit
 *    company, or customFields.company when it is a string), and email.
 *    Unknown {{variables}} are left untouched so typos stay visible,
 *    and nothing is ever invented for a missing field (it renders empty).
 *  - Every email carries a signed unsubscribe footer (see ./unsubscribe).
 *  - ACCEPTED means Resend's API accepted the message — never
 *    "delivered". No delivery/open tracking is claimed anywhere here:
 *    no Resend webhooks are implemented in this wave.
 *  - When Resend is unconfigured, the result is an honest
 *    EMAIL_NOT_CONFIGURED failure — never a fake success.
 */

import { db } from "../db";
import { assertLiveSendAllowed } from "../demo/guard";
import { getEmailSender } from "./sender";
import { createUnsubscribeToken, unsubscribeUrl } from "./unsubscribe";

export interface CampaignEmailRecipient {
  id: string;
  name: string;
  email: string | null;
  /** Explicit company; falls back to customFields.company (see below). */
  company?: string | null;
  /** Raw Contact.customFields JSON; company is read from it when set. */
  customFields?: string | null;
}

export interface CampaignEmailCampaign {
  id?: string;
  name?: string;
  /** Raw Campaign.message JSON; a string `subject` field is used when set. */
  message?: string | null;
}

export type SendCampaignEmailResult =
  | { skipped: true; reason: string }
  | { accepted: true; providerMessageId?: string }
  | { accepted: false; error: string; code?: string };

/** Verified contact fields only — the template variable allowlist. */
export function campaignEmailVariables(
  recipient: CampaignEmailRecipient
): Record<string, string> {
  const name = recipient.name ?? "";
  let company = recipient.company ?? "";
  if (!company && recipient.customFields) {
    try {
      const parsed: unknown = JSON.parse(recipient.customFields);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).company === "string"
      ) {
        company = (parsed as Record<string, string>).company;
      }
    } catch {
      // Unparseable customFields: company simply renders empty.
    }
  }
  return {
    name,
    firstName: name.trim().split(/\s+/)[0] ?? "",
    company,
    email: recipient.email ?? "",
  };
}

/**
 * Render {{variable}} substitution from verified contact fields only.
 * Unknown variables are left as-is (same rule as the messaging pipeline's
 * renderTemplate), so a typo never silently becomes an empty string.
 */
export function renderCampaignEmailBody(
  templateBody: string,
  recipient: CampaignEmailRecipient
): string {
  const vars = campaignEmailVariables(recipient);
  return templateBody.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, varName: string) => {
    return varName in vars ? vars[varName] : match;
  });
}

/** Resolve the email subject: explicit > campaign.message.subject > campaign name. */
export function resolveCampaignEmailSubject(
  campaign: CampaignEmailCampaign,
  explicitSubject?: string
): string {
  if (explicitSubject) return explicitSubject;
  if (campaign.message) {
    try {
      let parsed: unknown = JSON.parse(campaign.message);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).subject === "string" &&
        (parsed as Record<string, string>).subject
      ) {
        return (parsed as Record<string, string>).subject;
      }
    } catch {
      // Unparseable message JSON: fall through to the campaign name.
    }
  }
  return campaign.name || "A message for you";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the HTML email: escaped rendered body (line breaks preserved)
 * plus the unsubscribe footer. Contact-derived values are escaped here
 * so a name can never inject markup into the email.
 */
export function campaignEmailHtml(renderedBody: string, unsubUrl: string): string {
  const safeUrl = escapeHtml(unsubUrl);
  return (
    `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">\n` +
    `<div>${escapeHtml(renderedBody).replace(/\n/g, "<br>")}</div>\n` +
    `<hr style="margin:24px 0;border:none;border-top:1px solid #ddd">\n` +
    `<p style="color:#666;font-size:12px">You received this email because you are subscribed to updates. ` +
    `To stop receiving these emails, <a href="${safeUrl}">unsubscribe here</a>.<br>` +
    `<span style="word-break:break-all">${safeUrl}</span></p>\n` +
    `</body></html>`
  );
}

export async function isEmailSuppressed(
  workspaceId: string,
  contactId: string
): Promise<boolean> {
  const rows = await db.suppression.findMany({
    where: { workspaceId, contactId },
    select: { channel: true },
  });
  return rows.some((r) => r.channel === null || r.channel === "email");
}

export interface SendCampaignEmailInput {
  workspaceId: string;
  campaign: CampaignEmailCampaign;
  recipient: CampaignEmailRecipient;
  templateBody: string;
  subject?: string;
  /** Optional base URL override for the unsubscribe link (tests / previews). */
  baseUrl?: string;
}

/**
 * Send one campaign email. Suppression and missing-address checks run
 * before the demo guard and before any provider call; the demo guard's
 * 403 Response propagates; unconfigured Resend and provider failures
 * return an honest failure object (never a fake success).
 */
export async function sendCampaignEmail(
  input: SendCampaignEmailInput
): Promise<SendCampaignEmailResult> {
  const { workspaceId, campaign, recipient } = input;

  if (await isEmailSuppressed(workspaceId, recipient.id)) {
    return { skipped: true, reason: "contact is suppressed/opted out of email" };
  }
  if (!recipient.email) {
    return { skipped: true, reason: "contact has no email address" };
  }

  // Demo-mode guard BEFORE any external send (throws a 403 Response).
  await assertLiveSendAllowed(workspaceId);

  const sender = getEmailSender();
  if (!sender) {
    return {
      accepted: false,
      error: "Email not configured",
      code: "EMAIL_NOT_CONFIGURED",
    };
  }

  const rendered = renderCampaignEmailBody(input.templateBody, recipient);
  const subject = resolveCampaignEmailSubject(campaign, input.subject);
  const unsub = input.baseUrl
    ? `${input.baseUrl.replace(/\/+$/, "")}/api/unsubscribe?token=${encodeURIComponent(
        createUnsubscribeToken(workspaceId, recipient.id)
      )}`
    : unsubscribeUrl(workspaceId, recipient.id);
  const html = campaignEmailHtml(rendered, unsub);

  try {
    const result = await sender.send(recipient.email, subject, html);
    if (!result.ok) {
      return { accepted: false, error: "Email provider did not accept the message" };
    }
    // ACCEPTED by Resend's API — this is NOT a delivery confirmation.
    return { accepted: true, providerMessageId: result.messageId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { accepted: false, error: message.slice(0, 500) };
  }
}
