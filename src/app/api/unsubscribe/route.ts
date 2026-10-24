/**
 * GET /api/unsubscribe?token= — public unsubscribe confirmation page.
 *
 * No authentication: the recipient clicks this link from their own email,
 * so the HMAC-signed token IS the authorization (it grants exactly one
 * thing: suppressing one contact's email). Verification uses a
 * timing-safe comparison; ANY invalid token gets the same generic 400 —
 * no detail is leaked about why it failed.
 *
 * On a valid token the contact is suppressed for email (Suppression row,
 * channel "email") and an OPTED_OUT ConsentRecord is written (deduped,
 * so repeated clicks stay idempotent). A valid token for a contact that
 * no longer exists still returns the confirmation page — there is nothing
 * left to email, and the page must not oracle contact existence.
 *
 * Deliberately dependency-free (no app shell, no tenancy): this page is
 * rendered for people who may never have a FlowPilot account.
 */
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler } from "@/lib/api";
import {
  verifyUnsubscribeToken,
  UNSUBSCRIBE_CHANNEL,
} from "@/lib/email/unsubscribe";

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:48px auto;padding:0 24px;color:#111">` +
      `<h2 style="margin:0 0 16px">${title}</h2><p>${body}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export const GET = handler(async (req: NextRequest) => {
  const token = new URL(req.url).searchParams.get("token");
  const verified = token ? verifyUnsubscribeToken(token) : null;
  if (!verified) {
    return page(
      "Invalid link",
      "This unsubscribe link is invalid. If you believe this is an error, please contact the sender directly.",
      400
    );
  }

  const contact = await db.contact.findFirst({
    where: { id: verified.contactId, workspaceId: verified.workspaceId },
    select: { id: true },
  });

  if (contact) {
    await db.suppression.upsert({
      where: {
        workspaceId_contactId_channel: {
          workspaceId: verified.workspaceId,
          contactId: verified.contactId,
          channel: UNSUBSCRIBE_CHANNEL,
        },
      },
      update: {},
      create: {
        workspaceId: verified.workspaceId,
        contactId: verified.contactId,
        channel: UNSUBSCRIBE_CHANNEL,
        reason: "unsubscribed via email link",
      },
    });
    // Consent ledger (durable record; Suppression remains the enforcement
    // mechanism). Deduped: repeat clicks must not pile up OPTED_OUT rows.
    const existing = await db.consentRecord.findFirst({
      where: {
        workspaceId: verified.workspaceId,
        contactId: verified.contactId,
        channel: UNSUBSCRIBE_CHANNEL,
        status: "OPTED_OUT",
      },
      select: { id: true },
    });
    if (!existing) {
      await db.consentRecord.create({
        data: {
          workspaceId: verified.workspaceId,
          contactId: verified.contactId,
          channel: UNSUBSCRIBE_CHANNEL,
          status: "OPTED_OUT",
          source: "unsubscribe",
        },
      });
    }
  }

  return page(
    "You have been unsubscribed",
    "You will no longer receive marketing emails from this sender. If you change your mind, contact the sender to resubscribe."
  );
});
