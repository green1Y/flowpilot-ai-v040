import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";

const roleSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "MANAGER", "AGENT", "ANALYST"]),
});

type Ctx = { params: Promise<{ id: string }> };

async function scopedMembership(workspaceId: string, id: string) {
  const membership = await db.membership.findFirst({ where: { id, workspaceId } });
  if (!membership) throw err("Member not found", 404);
  return membership;
}

async function ownerCount(workspaceId: string): Promise<number> {
  return db.membership.count({ where: { workspaceId, role: "OWNER" } });
}

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "ADMIN");
  const membership = await scopedMembership(ctx.workspaceId, (await params).id);
  const body = await parseBody(req, roleSchema);

  // Never leave a workspace without an owner.
  if (membership.role === "OWNER" && body.role !== "OWNER") {
    if ((await ownerCount(ctx.workspaceId)) <= 1) {
      throw err("Cannot demote the last owner of the workspace", 422);
    }
  }

  // Privilege-escalation guard: nobody may change their own role (an ADMIN
  // could otherwise promote themselves to OWNER), and only an OWNER may
  // grant the OWNER role to anyone.
  if (membership.userId === ctx.userId) {
    throw err("You cannot change your own role", 403);
  }
  if (body.role === "OWNER" && ctx.role !== "OWNER") {
    throw err("Only an owner can grant the owner role", 403);
  }

  const updated = await db.membership.update({
    where: { id: membership.id },
    data: { role: body.role },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "team.role_changed", {
    type: "membership",
    id: updated.id,
    role: updated.role,
  });

  return ok({ member: { id: updated.id, role: updated.role } });
});

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "ADMIN");
  const membership = await scopedMembership(ctx.workspaceId, (await params).id);

  if (membership.role === "OWNER" && (await ownerCount(ctx.workspaceId)) <= 1) {
    throw err("Cannot remove the last owner of the workspace", 422);
  }

  await db.membership.delete({ where: { id: membership.id } });
  await auditLog(ctx.workspaceId, ctx.userId, "team.removed", {
    type: "membership",
    id: membership.id,
  });

  return ok({ ok: true });
});
