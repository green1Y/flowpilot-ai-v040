import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { getWorkspaceSettings } from "@/lib/workspace-settings";
import { auditLog } from "@/lib/audit";

/**
 * Download this workspace's data as JSON. MANAGER+ only.
 * Never includes credentials, password hashes, or provider tokens.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");

  const [workspace, members, contacts, workflows, templates, segments, settings] = await Promise.all([
    db.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { id: true, name: true, slug: true, brandColor: true, plan: true, createdAt: true },
    }),
    db.membership.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    db.contact.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { id: true, name: true, email: true, phone: true },
    }),
    db.workflow.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { id: true, name: true, status: true, nodes: true, edges: true, createdAt: true, updatedAt: true },
    }),
    db.messageTemplate.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { id: true, name: true, channel: true, body: true, createdAt: true },
    }),
    db.audienceSegment.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { id: true, name: true, conditions: true, createdAt: true },
    }),
    getWorkspaceSettings(ctx.workspaceId),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    workspace,
    members: members.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role })),
    contacts,
    workflows,
    messageTemplates: templates,
    audienceSegments: segments,
    settings,
    note: "This export contains workspace data only. Credentials and provider tokens are never included.",
  };

  await auditLog(ctx.workspaceId, ctx.userId, "workspace.data_exported", {
    type: "workspace",
    id: ctx.workspaceId,
  });

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="flowpilot-workspace-export-${ctx.workspaceId}.json"`,
    },
  });
});
