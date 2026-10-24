import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { CHANNELS } from "@/lib/messaging/send";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;
  const channel = sp.get("channel");

  const templates = await db.messageTemplate.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(channel ? { channel } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500, // perf: hard cap; template lists are user-managed and small
  });

  return ok({
    items: templates.map((t) => ({
      id: t.id,
      name: t.name,
      channel: t.channel,
      body: t.body,
      variables: t.variables,
      createdAt: t.createdAt.toISOString(),
    })),
  });
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  channel: z.enum(CHANNELS),
  body: z.string().min(1).max(4096),
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "AGENT");
  const parsed = await parseBody(req, createSchema);

  const name = parsed.name.trim();
  const existing = await db.messageTemplate.findFirst({
    where: { workspaceId: ctx.workspaceId, channel: parsed.channel, name },
  });
  if (existing) {
    throw err(`A template named "${name}" already exists for ${parsed.channel}`, 409);
  }

  // Extract {{variables}} so the composer can offer them.
  const variables = Array.from(
    new Set(
      Array.from(parsed.body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)).map((m) => m[1])
    )
  );

  const template = await db.messageTemplate.create({
    data: {
      workspaceId: ctx.workspaceId,
      name,
      channel: parsed.channel,
      body: parsed.body,
      variables: JSON.stringify(variables),
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "template.created", {
    type: "template", id: template.id, name, channel: parsed.channel,
  });

  return ok(
    {
      template: {
        id: template.id,
        name: template.name,
        channel: template.channel,
        body: template.body,
        variables: template.variables,
      },
    },
    { status: 201 }
  );
});
