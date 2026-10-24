import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { inviteSchema } from "@/lib/validation";
import { auditLog } from "@/lib/audit";
import { withSeatSlot } from "@/lib/billing/usage";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Any member can list the team; only ADMIN+ can change roles (see [id]).
  const memberships = await db.membership.findMany({
    where: { workspaceId: ctx.workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { id: "asc" },
  });
  return ok({
    members: memberships.map((m) => ({ id: m.id, role: m.role, user: m.user })),
  });
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "ADMIN");
  const body = await parseBody(req, inviteSchema);
  const email = body.email.toLowerCase().trim();

  // Invites only work for existing FlowPilot accounts — no new-user provisioning here.
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    throw err("No FlowPilot account with this email — they must sign up first", 404);
  }
  const existing = await db.membership.findFirst({
    where: { userId: user.id, workspaceId: ctx.workspaceId },
  });
  if (existing) throw err("This user is already a member of this workspace", 409);

  // Plan limit: seatLimit caps Membership rows. The seat count and the
  // membership insert happen inside one transaction (Batch C) so two
  // concurrent invites cannot race past the cap; at the cap this throws
  // the honest 402. The duplicate check is repeated inside the
  // transaction so a raced invite of the same user still gets the 409.
  const membership = await withSeatSlot(ctx.workspaceId, async (tx) => {
    const raced = await tx.membership.findFirst({
      where: { userId: user.id, workspaceId: ctx.workspaceId },
    });
    if (raced) throw err("This user is already a member of this workspace", 409);
    return tx.membership.create({
      data: { userId: user.id, workspaceId: ctx.workspaceId, role: body.role },
    });
  });

  await auditLog(ctx.workspaceId, ctx.userId, "team.invited", {
    type: "membership",
    id: membership.id,
    email,
    role: membership.role,
  });

  return ok(
    {
      member: {
        id: membership.id,
        role: membership.role,
        user: { id: user.id, name: user.name, email: user.email },
      },
    },
    { status: 201 }
  );
});
