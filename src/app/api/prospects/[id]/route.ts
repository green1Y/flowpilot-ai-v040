import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { findDuplicates } from "@/lib/prospecting/dedupe";
import { serializeProspect } from "@/lib/prospecting/serialize";

/** Workspace-scoped prospect lookup; 404 when missing (or not ours). */
async function scopedProspect(workspaceId: string, id: string) {
  const prospect = await db.prospect.findFirst({ where: { id, workspaceId } });
  if (!prospect) throw err("Prospect not found", 404);
  return prospect;
}

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  const prospect = await scopedProspect(ctx.workspaceId, (await params).id);
  return ok({ prospect: serializeProspect(prospect) });
});

const prospectPatchSchema = z.object({
  businessName: z.string().trim().min(1).optional(),
  industry: z.string().trim().optional().nullable(),
  website: z.string().trim().optional().nullable(),
  email: z.string().trim().email().optional().nullable().or(z.literal("")),
  phone: z.string().trim().optional().nullable(),
  socials: z.record(z.string(), z.string()).optional(),
  country: z.string().trim().optional().nullable(),
  region: z.string().trim().optional().nullable(),
  description: z.string().optional().nullable(),
  sourceUrl: z.string().trim().url().optional().nullable().or(z.literal("")),
  sourceType: z.enum(["manual", "import", "search"]).optional(),
  status: z.enum(["NEW", "QUALIFIED", "REJECTED", "CONTACTED"]).optional(),
  notes: z.string().optional(),
  qualificationScore: z.number().int().min(0).max(100).optional().nullable(),
  qualificationReasons: z.array(z.string()).optional(),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().nullable(),
});

function emptyToNull(v: string | null | undefined): string | null {
  return v && v.trim() ? v.trim() : null;
}

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "AGENT");
  const id = (await params).id;
  const prospect = await scopedProspect(ctx.workspaceId, id);
  const body = await parseBody(req, prospectPatchSchema);

  // Re-run the dedupe check when identity fields change (excluding self).
  if (body.businessName !== undefined || body.website !== undefined || body.country !== undefined) {
    const next = {
      businessName: body.businessName ?? prospect.businessName,
      website: body.website !== undefined ? emptyToNull(body.website) : prospect.website,
      country: body.country !== undefined ? emptyToNull(body.country) : prospect.country,
    };
    const others = await db.prospect.findMany({
      where: { workspaceId: ctx.workspaceId, id: { not: id } },
      select: { id: true, businessName: true, website: true, country: true },
      take: 5000,
    });
    const dupes = findDuplicates(others, next);
    if (dupes.length > 0) {
      throw err("Duplicate prospect", 409, {
        code: "DUPLICATE_PROSPECT",
        existingId: dupes[0].id,
        existingIds: dupes.map((d) => d.id),
      });
    }
  }

  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "socials") data.socials = JSON.stringify(v);
    else if (k === "qualificationReasons") data.qualificationReasons = JSON.stringify(v);
    // notes is non-nullable: an empty string is a legitimate clear.
    else if (k === "notes") data.notes = v;
    else if (typeof v === "string") data[k] = emptyToNull(v);
    else data[k] = v;
  }
  const updated = await db.prospect.update({ where: { id }, data: data as any });
  await auditLog(ctx.workspaceId, ctx.userId, "prospect.updated", { type: "prospect", id });
  return ok({ prospect: serializeProspect(updated) });
});

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "AGENT");
  const id = (await params).id;
  await scopedProspect(ctx.workspaceId, id);
  await db.prospect.delete({ where: { id } });
  await auditLog(ctx.workspaceId, ctx.userId, "prospect.deleted", { type: "prospect", id });
  return ok({ deleted: true, id });
});
