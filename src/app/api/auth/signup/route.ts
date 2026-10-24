import { NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { hashPassword, signToken, setSessionCookie } from "@/lib/auth";
import { signupSchema } from "@/lib/validation";
import { ensureDemoData } from "@/lib/demo";
import { auditLog } from "@/lib/audit";
import { isSignupBlocked, recordSignup } from "@/lib/rate-limit";
import { getEmailSender } from "@/lib/email/sender";
import { assertLiveSendAllowed } from "@/lib/demo/guard";
import {
  generateVerificationCode,
  hashVerificationCode,
  verificationEmailHtml,
  VERIFICATION_CODE_TTL_MS,
} from "@/lib/email/crypto";

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "workspace";
}

/** Unique workspace slug: slugified name + 6-char random suffix. */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = `${base}-${randomBytes(3).toString("hex")}`;
    const existing = await db.workspace.findUnique({ where: { slug } });
    if (!existing) return slug;
  }
  // Extremely unlikely fallback — still unique.
  return `${base}-${Date.now().toString(36)}`;
}

export const POST = handler(async (req: NextRequest) => {
  const body = await parseBody(req, signupSchema);
  const email = body.email.toLowerCase().trim();

  // Mass-account-creation protection: budget signups per client IP.
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isSignupBlocked(clientIp)) {
    throw err("Too many accounts created from this address. Please try again later.", 429);
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) throw err("An account with this email already exists", 409);

  const passwordHash = await hashPassword(body.password);
  const name = body.name.trim();
  const workspaceName = body.workspaceName?.trim() || `${name}'s Workspace`;
  const slug = await uniqueSlug(workspaceName);

  // Email verification (Workstream A): 6-digit code, 15-minute expiry. Only
  // the SHA-256 hash is stored — the plaintext code is emailed, never saved.
  const verificationCode = generateVerificationCode();

  const { user, workspace } = await db.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { name, email, passwordHash } });
    const org = await tx.organization.create({ data: { name: `${name}'s Organization` } });
    const workspace = await tx.workspace.create({
      data: {
        orgId: org.id,
        name: workspaceName,
        slug,
        // Demo-mode: workspaces created while DEMO_MODE is on are demo
        // workspaces — all real external sends are blocked server-side.
        isDemo: process.env.DEMO_MODE === "true",
      },
    });
    await tx.membership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "OWNER" },
    });
    await tx.emailVerification.create({
      data: {
        userId: user.id,
        codeHash: hashVerificationCode(verificationCode),
        expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      },
    });
    return { user, workspace };
  });

  // Seed clearly-labeled demo data for the new workspace when DEMO_MODE is on.
  if (process.env.DEMO_MODE === "true") {
    await ensureDemoData(workspace.id);
  }

  await setSessionCookie(signToken({ userId: user.id, email: user.email, tokenVersion: 0 }));
  recordSignup(clientIp);
  await auditLog(workspace.id, user.id, "workspace.created", {
    type: "workspace",
    id: workspace.id,
  });

  // Deliver the verification code. Honest states only: when email is not
  // configured (or sending is blocked/failed) the account is still created
  // and the response says verification is pending — nothing is ever marked
  // verified without a real send + code round-trip.
  let verification: { status: "sent" | "pending"; reason?: string };
  const sender = getEmailSender();
  if (!sender) {
    verification = { status: "pending", reason: "EMAIL_NOT_CONFIGURED" };
  } else {
    try {
      await assertLiveSendAllowed(workspace.id);
      await sender.send(
        user.email,
        "Verify your FlowPilot email",
        verificationEmailHtml(verificationCode)
      );
      verification = { status: "sent" };
    } catch (e) {
      // Demo-mode guard (403) or provider failure: keep the account, report
      // pending with the honest reason. Never log the code.
      let reason = "EMAIL_SEND_FAILED";
      if (e instanceof Response) {
        try {
          const body = (await e.json()) as { code?: string } | null;
          if (body?.code) reason = body.code;
        } catch {
          /* keep default reason */
        }
      } else {
        console.error("[signup] verification email send failed");
      }
      verification = { status: "pending", reason };
    }
  }

  return ok(
    {
      user: { id: user.id, name: user.name, email: user.email },
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
      verification,
    },
    { status: 201 }
  );
});
