import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { parseJson } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";
import {
  SEARCH_PROVIDER_NOT_CONFIGURED,
  SEARCH_PROVIDER_PREREQUISITE,
  searchProspects,
} from "@/lib/prospecting/providers";

/**
 * Prospect searches (Wave 2D). No search provider is configured in v0.4.0,
 * so POST always creates a row in BLOCKED_NO_SOURCE with the prerequisite —
 * it never returns fabricated prospects. When a provider is configured in a
 * future release, searchProspects() will run it and the status will reflect
 * the real outcome.
 */

function serializeSearch(s: any) {
  return {
    ...s,
    icp: parseJson<Record<string, unknown>>(s.icp, {}),
    keywords: parseJson<string[]>(s.keywords, []),
    exclusions: parseJson<string[]>(s.exclusions, []),
  };
}

const searchCreateSchema = z.object({
  industry: z.string().trim().min(1, "industry is required"),
  country: z.string().trim().optional().nullable(),
  region: z.string().trim().optional().nullable(),
  businessType: z.string().trim().optional().nullable(),
  icp: z.record(z.string(), z.unknown()).optional(),
  keywords: z.array(z.string()).optional(),
  exclusions: z.array(z.string()).optional(),
  targetCount: z.number().int().min(1).max(500).optional(),
});

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const searches = await db.prospectSearch.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok({ searches: searches.map(serializeSearch), total: searches.length });
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Search creation is a data-acquisition action: MANAGER+.
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, searchCreateSchema);

  const outcome = await searchProspects({
    industry: body.industry,
    country: body.country ?? null,
    region: body.region ?? null,
    businessType: body.businessType ?? null,
    icp: body.icp ?? {},
    keywords: body.keywords ?? [],
    exclusions: body.exclusions ?? [],
    targetCount: body.targetCount ?? 25,
  });

  // v0.4.0: outcome is always blocked. The row records the attempt honestly.
  const search = await db.prospectSearch.create({
    data: {
      workspaceId: ctx.workspaceId,
      industry: body.industry,
      country: body.country ?? null,
      region: body.region ?? null,
      businessType: body.businessType ?? null,
      icp: JSON.stringify(body.icp ?? {}),
      keywords: JSON.stringify(body.keywords ?? []),
      exclusions: JSON.stringify(body.exclusions ?? []),
      targetCount: body.targetCount ?? 25,
      status: outcome.blocked ? "BLOCKED_NO_SOURCE" : "COMPLETED",
      provider: outcome.blocked ? null : outcome.provider,
      error: outcome.blocked ? SEARCH_PROVIDER_PREREQUISITE : null,
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "prospect_search.created", {
    type: "prospect_search",
    id: search.id,
    status: search.status,
  });

  return ok(
    {
      search: serializeSearch(search),
      blocked: outcome.blocked,
      code: outcome.blocked ? SEARCH_PROVIDER_NOT_CONFIGURED : undefined,
      prerequisite: outcome.blocked ? SEARCH_PROVIDER_PREREQUISITE : undefined,
    },
    { status: 201 }
  );
});
