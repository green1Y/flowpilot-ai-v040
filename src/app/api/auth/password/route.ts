import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireUser, verifyPassword, hashPassword } from "@/lib/auth";

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(200),
  })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: "New password must be different from the current one",
    path: ["newPassword"],
  });

/**
 * Change the signed-in user's password. The current password is verified
 * server-side with bcrypt; the new one is never logged or echoed back.
 */
export const PUT = handler(async (req: NextRequest) => {
  const session = await requireUser();
  const body = await parseBody(req, passwordSchema);

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, passwordHash: true },
  });
  if (!user) throw err("Account not found", 404);

  const valid = await verifyPassword(body.currentPassword, user.passwordHash);
  if (!valid) throw err("Current password is incorrect", 401);

  await db.user.update({
    where: { id: user.id },
    // v0.4.0: bump tokenVersion so every previously issued JWT dies now,
    // not at its 7-day expiry (stolen-token survival after password change).
    data: { passwordHash: await hashPassword(body.newPassword), tokenVersion: { increment: 1 } },
  });

  return ok({ ok: true });
});
