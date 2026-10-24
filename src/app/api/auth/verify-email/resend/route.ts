import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { sendGuardedEmail } from "@/lib/email/send";
import {
  generateVerificationCode,
  hashVerificationCode,
  verificationEmailHtml,
  VERIFICATION_CODE_TTL_MS,
} from "@/lib/email/crypto";
import {
  getResendCooldownRemainingMs,
  recordResend,
  isVerifyResendBlocked,
  recordVerifyResend,
} from "@/lib/rate-limit";

/**
 * POST /api/auth/verify-email/resend — issue a fresh 6-digit code.
 *
 * - 60-second cooldown between sends (429 + retryAfterSec while cooling).
 * - Hourly per-user resend budget (429 when exhausted).
 * - Replaces any previous pending code (single active code per user).
 * - The demo-mode send guard runs BEFORE sending; when email is not
 *   configured the caller gets an honest 503 EMAIL_NOT_CONFIGURED.
 */
export const POST = handler(async () => {
  const session = await requireUser();

  const cooldownMs = getResendCooldownRemainingMs(session.userId);
  if (cooldownMs > 0) {
    throw err("Please wait before requesting another code", 429, {
      code: "RESEND_COOLDOWN",
      retryAfterSec: Math.ceil(cooldownMs / 1000),
    });
  }
  if (isVerifyResendBlocked(session.userId)) {
    throw err("Too many resend requests — please try again later", 429, {
      code: "RESEND_RATE_LIMITED",
    });
  }

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user) throw err("Account not found", 404);
  if (user.emailVerified) {
    return ok({ alreadyVerified: true });
  }

  const membership = await db.membership.findFirst({
    where: { userId: user.id },
    orderBy: { id: "asc" },
    select: { workspaceId: true },
  });
  if (!membership) throw err("No workspace found for user", 404);

  // Single active code: rotate the previous one out.
  const code = generateVerificationCode();
  await db.$transaction([
    db.emailVerification.deleteMany({ where: { userId: user.id } }),
    db.emailVerification.create({
      data: {
        userId: user.id,
        codeHash: hashVerificationCode(code),
        expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      },
    }),
  ]);

  // Guarded send: honest 503 when unconfigured, 403 when demo-blocked.
  await sendGuardedEmail(
    membership.workspaceId,
    user.email,
    "Your FlowPilot verification code",
    verificationEmailHtml(code)
  );

  recordResend(user.id);
  recordVerifyResend(user.id);

  return ok({ sent: true });
});
