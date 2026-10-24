import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, err, parseBody } from "@/lib/api";
import { getEmailSender } from "@/lib/email/sender";
import { assertEmailSendAllowedForUser } from "@/lib/email/send";
import {
  generateResetToken,
  hashResetToken,
  passwordResetEmailHtml,
  PASSWORD_RESET_TTL_MS,
} from "@/lib/email/crypto";
import { siteUrl } from "@/lib/site-url";
import { isPasswordResetBlocked, recordPasswordReset } from "@/lib/rate-limit";

const requestSchema = z
  .object({
    email: z.string().email().max(160),
  })
  .strict();

// Identical for every outcome — never leaks whether the email exists.
const GENERIC_REPLY = {
  ok: true,
  message: "If an account exists for this email, a reset link has been sent.",
};

/**
 * POST /api/auth/password-reset/request — no-oracle reset initiation.
 *
 * ALWAYS answers 200 with the generic message, whether or not the account
 * exists. When the account exists AND email is configured AND the demo-mode
 * send guard allows it, a single-use token (32 random bytes, SHA-256 stored,
 * 1-hour expiry) is created and the reset link is emailed.
 *
 * The guard's 403 is intentionally swallowed here: surfacing it would turn
 * the guard into an account-existence oracle. The send is still blocked —
 * only the error presentation is normalized.
 */
export const POST = handler(async (req: NextRequest) => {
  const body = await parseBody(req, requestSchema);
  const email = body.email.toLowerCase().trim();

  // Abuse protection counts every request (valid or not) so the budget
  // itself cannot become an oracle.
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isPasswordResetBlocked(clientIp)) {
    throw err("Too many requests. Please try again later.", 429);
  }
  recordPasswordReset(clientIp);

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });
  const sender = getEmailSender();

  if (user && sender) {
    let allowed = true;
    try {
      await assertEmailSendAllowedForUser(user.id);
    } catch {
      allowed = false; // demo-blocked: no send, generic reply (no oracle)
    }
    if (allowed) {
      // Rotate: at most one live token per user.
      await db.passwordResetToken.deleteMany({
        where: { userId: user.id, usedAt: null },
      });
      const token = generateResetToken();
      await db.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
        },
      });
      try {
        const link = `${siteUrl()}/reset-password?token=${token}`;
        await sender.send(
          email,
          "Reset your FlowPilot password",
          passwordResetEmailHtml(link)
        );
      } catch {
        // The token can never be delivered — remove it rather than leaving
        // a dangling credential. Never logs the token.
        await db.passwordResetToken
          .deleteMany({ where: { userId: user.id, usedAt: null } })
          .catch(() => {});
        console.error("[password-reset] reset email send failed");
      }
    }
  }

  return Response.json(GENERIC_REPLY, { status: 200 });
});
