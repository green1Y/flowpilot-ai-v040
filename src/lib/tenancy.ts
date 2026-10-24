import { NextRequest } from "next/server";
import { requireUser } from "./auth";
import { db } from "./db";

/**
 * Tenant scoping helper for every API handler.
 *
 * Resolution order for the workspace id:
 *   1. `x-workspace-id` request header
 *   2. `fp_workspace_id` cookie
 *   3. the user's first membership (fallback)
 *
 * Throws a Response (401/403/404) when the user is not a member of the
 * requested workspace. Use `requireRole(ctx, [...])` for role checks.
 */
export interface WorkspaceContext {
  userId: string;
  workspaceId: string;
  role: string;
}

const WORKSPACE_COOKIE = "fp_workspace_id";

export async function setWorkspaceCookie(workspaceId: string) {
  // Set from a Route Handler via cookies(); kept here for naming consistency.
  const { cookies } = require("next/headers") as typeof import("next/headers");
  (await cookies()).set(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    // v0.4.0: match the session cookie — secure in production.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearWorkspaceCookie() {
  // Clear from a Route Handler via cookies(); kept here for naming consistency.
  // Used on logout so a stale selection can never leak into the next session
  // on a shared device.
  const { cookies } = require("next/headers") as typeof import("next/headers");
  (await cookies()).set(WORKSPACE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * Error codes for workspace-resolution failures. The client uses these to
 * recover from stale selections instead of looping on errors:
 * - WORKSPACE_NOT_FOUND: the selected id names no workspace (stale id,
 *   deleted workspace). The client should clear the selection and reselect.
 * - FORBIDDEN: the workspace exists but the caller is not a member. The
 *   client should clear the selection and fall back to a valid workspace.
 * - NO_WORKSPACE: the authenticated user has no memberships at all. The
 *   client should direct to a safe state (create/join workspace), not retry.
 */
export const WORKSPACE_NOT_FOUND = "WORKSPACE_NOT_FOUND";
export const WORKSPACE_FORBIDDEN = "FORBIDDEN";
export const NO_WORKSPACE = "NO_WORKSPACE";

export async function requireWorkspace(req: NextRequest): Promise<WorkspaceContext> {
  const session = await requireUser();

  const headerId = req.headers.get("x-workspace-id");
  let workspaceId = headerId || req.cookies.get(WORKSPACE_COOKIE)?.value || null;

  const memberships = await db.membership.findMany({
    where: { userId: session.userId },
    orderBy: { id: "asc" },
  });
  if (memberships.length === 0) {
    throw Response.json(
      { error: "No workspace found for user", code: NO_WORKSPACE },
      { status: 404 }
    );
  }

  if (!workspaceId) workspaceId = memberships[0].workspaceId;

  const membership = memberships.find((m) => m.workspaceId === workspaceId);
  if (!membership) {
    // The caller selected a workspace they are not a member of. Distinguish
    // a stale/unknown id (safe to tell the client to reselect) from a real
    // workspace the caller must not see (stay a bare 403, no details).
    const exists = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!exists) {
      throw Response.json(
        { error: "Workspace not found — please reselect", code: WORKSPACE_NOT_FOUND },
        { status: 404 }
      );
    }
    // Tenant isolation: never reveal anything about a workspace the caller
    // is not a member of beyond the denial itself.
    throw Response.json({ error: "Forbidden", code: WORKSPACE_FORBIDDEN }, { status: 403 });
  }

  return { userId: session.userId, workspaceId: membership.workspaceId, role: membership.role };
}

const ROLE_RANK: Record<string, number> = {
  ANALYST: 0,
  AGENT: 1,
  MANAGER: 2,
  ADMIN: 3,
  OWNER: 4,
};

/** Enforce a minimum role; throws 403 Response when the caller is below it. */
export function requireRole(ctx: WorkspaceContext, minRole: string) {
  const have = ROLE_RANK[ctx.role] ?? -1;
  const need = ROLE_RANK[minRole] ?? 99;
  if (have < need) {
    // Distinct code from WORKSPACE_FORBIDDEN so clients never mistake a
    // genuine role denial for a stale workspace selection.
    throw Response.json(
      { error: "Forbidden: insufficient role", code: "INSUFFICIENT_ROLE" },
      { status: 403 }
    );
  }
}
