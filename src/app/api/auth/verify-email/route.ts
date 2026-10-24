import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import {
  hashVerificationCode,
  timingSafeEqualHex,
  VERIFICATION_MAX_ATTEMPTS,
} from "@/lib/email/crypto";

const verifyEmailSchema = z
  .object({
    code: z
      .string()
      .regex(/^\d{6}$/, "Verification code must be 6 digits"),
  })
  .strict();

/**
 * POST /api/auth/verify-email — confirm the 6-digit code emailed at signup.
 *
 * - Timing-safe hash comparison (only the SHA-256 hash is stored).
 * - 15-minute expiry (expired rows are deleted).
 * - 5-attempt lockout: attempts increment on each failure; locked after 5.
 * - On success: user.emailVerified=true, emailVerifiedAt=now(), row deleted.
 */
export const POST = handler(async (req: NextRequest) => {
  const session = await requireUser();
  const body = await parseBody(req, verifyEmailSchema);

  const row = await db.emailVerification.findFirst({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
  });
  if (!row) {
    throw err("No pending email verification", 404, {
      code: "NO_PENDING_VERIFICATION",
    });
  }

  if (row.expiresAt.getTime() < Date.now()) {
    await db.emailVerification.delete({ where: { id: row.id } }).catch(() => {});
    throw err("Verification code has expired — request a new one", 410, {
      code: "VERIFICATION_EXPIRED",
    });
  }

  if (row.attempts >= VERIFICATION_MAX_ATTEMPTS) {
    throw err("Too many attempts — request a new code", 429, {
      code: "VERIFICATION_LOCKED",
    });
  }

  const matches = timingSafeEqualHex(
    hashVerificationCode(body.code),
    row.codeHash
  );
  if (!matches) {
    await db.emailVerification.update({
      where: { id: row.id },
      data: { attempts: row.attempts + 1 },
    });
    throw err("Invalid verification code", 401, { code: "INVALID_CODE" });
  }

  await db.$transaction([
    db.user.update({
      where: { id: session.userId },
      data: { emailVerified: true, emailVerifiedAt: new Date() },
    }),
    db.emailVerification.delete({ where: { id: row.id } }),
  ]);

  return ok({ verified: true });
});
