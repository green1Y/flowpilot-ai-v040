import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { verifyPassword, signToken, setSessionCookie } from "@/lib/auth";
import { setWorkspaceCookie } from "@/lib/tenancy";
import { loginSchema } from "@/lib/validation";
import { auditLog } from "@/lib/audit";
import {
  isLoginBlocked,
  recordFailedLogin,
  clearFailedLogins,
} from "@/lib/rate-limit";

export const POST = handler(async (req: NextRequest) => {
  const body = await parseBody(req, loginSchema);
  const email = body.email.toLowerCase().trim();

  // Brute-force protection: budget failed attempts per client IP + email.
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateKey = `${clientIp}:${email}`;
  if (isLoginBlocked(rateKey)) {
    throw err(
      "Too many failed login attempts. Please wait a few minutes and try again.",
      429
    );
  }

  const user = await db.user.findUnique({ where: { email } });
  // Timing-oracle guard: always run a bcrypt comparison (~200ms) even when the
  // user does not exist, so response time does not reveal email existence.
  // DUMMY_HASH is a valid bcrypt hash of an unknown password (generated once).
  const DUMMY_HASH = "$2a$12$QiV30KbaTSRYqZAOqQ34pOWz80ltsF1CQ3LRAD8RVIYq5XxY5JOOC";
  const passwordValid = user
    ? await verifyPassword(body.password, user.passwordHash)
    : (await verifyPassword(body.password, DUMMY_HASH), false);
  // Same client message either way — never reveal whether the email exists.
  if (!user || !passwordValid) {
    recordFailedLogin(rateKey);
    // Temporary dev-only diagnostic: reports WHAT the server saw without
    // exposing secrets. Never logs the password or the password hash.
    // Compare these booleans between the browser attempt and the PowerShell
    // attempt to see exactly where they diverge.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[auth] failed login: email="${email}" userFound=${user !== null} passwordValid=${passwordValid} bodyKeys=${Object.keys(body).join(",")}`
      );
    }
    throw err(
      "Invalid email or password. Check for typos, Caps Lock, or extra spaces.",
      401
    );
  }

  // Legitimate login: the budget is for attackers, not for this user.
  clearFailedLogins(rateKey);

  const memberships = await db.membership.findMany({
    where: { userId: user.id },
    include: { workspace: { select: { id: true, name: true, slug: true } } },
    orderBy: { id: "asc" },
  });

  await setSessionCookie(signToken({ userId: user.id, email: user.email, tokenVersion: user.tokenVersion }));
  // Restore the user's saved language preference (cookie drives rendering).
  if (user.locale === "ar" || user.locale === "en") {
    const { cookies } = await import("next/headers");
    const { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } = await import("@/i18n/config");
    (await cookies()).set(LOCALE_COOKIE, user.locale, {
      path: "/",
      maxAge: LOCALE_COOKIE_MAX_AGE,
      sameSite: "lax",
    });
  }
  // Default the workspace cookie to the first workspace for convenience.
  if (memberships.length > 0) {
    await setWorkspaceCookie(memberships[0].workspaceId);
    await auditLog(memberships[0].workspaceId, user.id, "auth.login", {
      type: "user",
      id: user.id,
    });
  }

  return ok({
    user: { id: user.id, name: user.name, email: user.email },
    workspaces: memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
    })),
  });
});
