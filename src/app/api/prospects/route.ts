import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { findDuplicates } from "@/lib/prospecting/dedupe";
import { scoreProspect, type QualificationCriteria } from "@/lib/prospecting/qualify";

/**
 * Prospects (Wave 2D). Every field here comes from user input or an import —
 * the system never invents an email, phone, revenue figure, or company fact.
 * A prospect without a sourceUrl is user-entered and unverified; the UI must
 * label it "unverified — user-entered".
 */
import { serializeProspect } from "@/lib/prospecting/serialize";

const PROSPECT_STATUSES = ["NEW", "QUALIFIED", "REJECTED", "CONTACTED"] as const;

const criteriaSchema = z.object({
  requiredFields: z.array(z.string()).optional(),
  keywordBonuses: z.record(z.string(), z.number()).optional(),
  regionMatches: z.array(z.string()).optional(),
  industryMatches: z.array(z.string()).optional(),
});

const prospectCreateSchema = z.object({
  businessName: z.string().trim().min(1, "businessName is required"),
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
  searchId: z.string().optional().nullable(),
  status: z.enum(PROSPECT_STATUSES).optional(),
  notes: z.string().optional(),
  criteria: criteriaSchema.optional(),
  qualificationScore: z.number().int().min(0).max(100).optional().nullable(),
  qualificationReasons: z.array(z.string()).optional(),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().nullable(),
});

function emptyToNull(v: string | null | undefined): string | null {
  return v && v.trim() ? v.trim() : null;
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;
  const where: Prisma.ProspectWhereInput = { workspaceId: ctx.workspaceId };
  if (sp.get("status")) where.status = sp.get("status")!;
  if (sp.get("industry")) where.industry = sp.get("industry")!;
  if (sp.get("country")) where.country = sp.get("country")!;
  const search = sp.get("search");
  if (search) where.businessName = { contains: search };
  const minScore = sp.get("minScore");
  if (minScore !== null) {
    const n = parseInt(minScore, 10);
    if (!Number.isNaN(n)) where.qualificationScore = { gte: n };
  }
  const prospects = await db.prospect.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return ok({ prospects: prospects.map(serializeProspect), total: prospects.length });
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Manual prospect creation: AGENT+.
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, prospectCreateSchema);

  // Dedupe before insert: normalized domain OR (normalized name + country).
  const existing = await db.prospect.findMany({
    where: { workspaceId: ctx.workspaceId },
    select: { id: true, businessName: true, website: true, country: true },
    take: 5000,
  });
  const dupes = findDuplicates(existing, {
    businessName: body.businessName,
    website: emptyToNull(body.website),
    country: emptyToNull(body.country),
  });
  if (dupes.length > 0) {
    throw err("Duplicate prospect", 409, {
      code: "DUPLICATE_PROSPECT",
      existingId: dupes[0].id,
      existingIds: dupes.map((d) => d.id),
    });
  }

  let score = body.qualificationScore ?? null;
  let reasons = body.qualificationReasons ?? [];
  if (body.criteria) {
    const scored = scoreProspect(
      {
        businessName: body.businessName,
        industry: emptyToNull(body.industry),
        website: emptyToNull(body.website),
        email: emptyToNull(body.email),
        phone: emptyToNull(body.phone),
        country: emptyToNull(body.country),
        region: emptyToNull(body.region),
        description: body.description ?? null,
        sourceUrl: emptyToNull(body.sourceUrl),
      },
      body.criteria as QualificationCriteria
    );
    score = scored.score;
    reasons = scored.reasons;
  }

  let prospect;
  try {
    prospect = await db.prospect.create({
      data: {
        workspaceId: ctx.workspaceId,
        searchId: body.searchId ?? null,
        businessName: body.businessName,
        industry: emptyToNull(body.industry),
        website: emptyToNull(body.website),
        email: emptyToNull(body.email),
        phone: emptyToNull(body.phone),
        socials: JSON.stringify(body.socials ?? {}),
        country: emptyToNull(body.country),
        region: emptyToNull(body.region),
        description: body.description ?? null,
        sourceUrl: emptyToNull(body.sourceUrl),
        sourceType: body.sourceType ?? "manual",
        qualificationScore: score,
        qualificationReasons: JSON.stringify(reasons),
        confidence: body.confidence ?? null,
        status: body.status ?? "NEW",
        notes: body.notes ?? "",
      },
    });
  } catch (e: any) {
    // Backstop for the @@unique([workspaceId, website]) constraint.
    if (e?.code === "P2002") {
      throw err("Duplicate prospect", 409, { code: "DUPLICATE_PROSPECT" });
    }
    throw e;
  }

  await auditLog(ctx.workspaceId, ctx.userId, "prospect.created", {
    type: "prospect",
    id: prospect.id,
  });
  return ok({ prospect: serializeProspect(prospect) }, { status: 201 });
});
