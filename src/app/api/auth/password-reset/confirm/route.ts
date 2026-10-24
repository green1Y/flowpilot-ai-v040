import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { newPasswordSchema } from "@/lib/validation";
import {
  hashResetToken,
  timingSafeEqualHex,
} from "@/lib/email/crypto";
import { isPasswordResetBlocked, recordPasswordReset } from "@/lib/rate-limit";

const confirmSchema = z
  .object({
    token: z.string().min(1).max(256),
    newPassword: newPasswordSchema,
  })
  .strict();

/**
 * POST /api/auth/password-reset/confirm — redeem a reset token.
 *
 * - Token validated by SHA-256 hash lookup + timing-safe compare.
 * - 1-hour expiry; expired rows are deleted.
 * - Single-use: usedAt is set atomically with the password change; a
 *   redeemed token is rejected with the same generic message.
 * - Invalid / expired / reused tokens all answer identically (no oracle).
 * - Password strength reuses the shared `newPasswordSchema`.
 */
export const POST = handler(async (req: NextRequest) => {
  const body = await parseBody(req, confirmSchema);

  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isPasswordResetBlocked(clientIp)) {
    throw err("Too many requests. Please try again later.", 429);
  }
  recordPasswordReset(clientIp);

  const tokenHash = hashResetToken(body.token);
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash },
  });
  // Exact hash lookup (+ timing-safe compare as defense in depth). Every
  // failure mode answers identically so tokens can't be probed.
  const badToken = !row || !timingSafeEqualHex(row.tokenHash, tokenHash);
  const spent = !!row && (!!row.usedAt || row.expiresAt.getTime() < Date.now());
  if (badToken || spent) {
    if (row) {
      await db.passwordResetToken
        .delete({ where: { id: row.id } })
        .catch(() => {});
    }
    throw err("Invalid or expired reset link", 400, {
      code: "INVALID_RESET_TOKEN",
    });
  }

  await db.$transaction([
    db.user.update({
      where: { id: row.userId },
      // v0.4.0: bump tokenVersion — see password route comment.
      data: { passwordHash: await hashPassword(body.newPassword), tokenVersion: { increment: 1 } },
    }),
    db.passwordResetToken.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    }),
  ]);

  return ok({ ok: true });
});
