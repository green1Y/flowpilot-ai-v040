import { NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/api";
import { requireWorkspace, setWorkspaceCookie } from "@/lib/tenancy";
import { workspaceCreateSchema } from "@/lib/validation";
import { auditLog } from "@/lib/audit";

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
  return `${base}-${Date.now().toString(36)}`;
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);

  const memberships = await db.membership.findMany({
    where: { userId: ctx.userId },
    include: { workspace: true },
    orderBy: { id: "asc" },
  });

  return ok({
    workspaces: memberships.map((m) => ({ ...m.workspace, role: m.role })),
  });
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const body = await parseBody(req, workspaceCreateSchema);
  const name = body.name.trim();
  const slug = await uniqueSlug(name);

  const workspace = await db.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name: `${name}'s Organization` } });
    const ws = await tx.workspace.create({
      data: {
        orgId: org.id,
        name,
        slug,
        // Demo-mode: same rule as signup — workspaces created while
        // DEMO_MODE is on are demo workspaces (sends blocked server-side).
        isDemo: process.env.DEMO_MODE === "true",
      },
    });
    await tx.membership.create({
      data: { userId: ctx.userId, workspaceId: ws.id, role: "OWNER" },
    });
    return ws;
  });

  await setWorkspaceCookie(workspace.id);
  await auditLog(workspace.id, ctx.userId, "workspace.created", {
    type: "workspace",
    id: workspace.id,
  });

  return ok({ workspace }, { status: 201 });
});
