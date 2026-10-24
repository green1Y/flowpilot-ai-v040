import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";

const workspacePatchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "brandColor must be a hex color like #8B5CF6")
    .optional(),
});

type Ctx = { params: Promise<{ id: string }> };

/** Load the caller's membership for the requested workspace id (tenant scoping). */
async function scopedMembership(userId: string, workspaceId: string) {
  const membership = await db.membership.findFirst({
    where: { userId, workspaceId },
    include: { workspace: true },
  });
  if (!membership) throw err("Workspace not found", 404);
  return membership;
}

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  const membership = await scopedMembership(ctx.userId, (await params).id);
  return ok({ workspace: membership.workspace, role: membership.role });
});

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  const membership = await scopedMembership(ctx.userId, (await params).id);
  // Role check against THIS workspace's membership, not the header-selected one.
  requireRole(
    { userId: ctx.userId, workspaceId: membership.workspaceId, role: membership.role },
    "ADMIN"
  );

  const body = await parseBody(req, workspacePatchSchema);
  const workspace = await db.workspace.update({
    where: { id: membership.workspaceId },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.brandColor !== undefined ? { brandColor: body.brandColor } : {}),
    },
  });

  await auditLog(membership.workspaceId, ctx.userId, "workspace.updated", {
    type: "workspace",
    id: workspace.id,
  });

  return ok({ workspace });
});
