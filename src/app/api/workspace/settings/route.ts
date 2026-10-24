import { NextRequest } from "next/server";
import { handler, ok, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import {
  workspaceSettingsSchema,
  getWorkspaceSettings,
  updateWorkspaceSettings,
} from "@/lib/workspace-settings";
import { auditLog } from "@/lib/audit";

/** Any workspace member can read the settings (no secrets live here). */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const settings = await getWorkspaceSettings(ctx.workspaceId);
  return ok({ settings });
});

/** MANAGER+ can update workflow execution defaults and notification toggles. */
export const PUT = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, workspaceSettingsSchema);
  const settings = await updateWorkspaceSettings(ctx.workspaceId, body);
  await auditLog(ctx.workspaceId, ctx.userId, "workspace.settings_updated", {
    type: "workspace_settings",
    keys: Object.keys(body),
  });
  return ok({ settings });
});
