import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { parseJson } from "@/lib/serialize";
import { csvCell } from "@/lib/csv";

/**
 * Prospect CSV export (Wave 2D, MANAGER+).
 * Cells are formula-neutralized via the shared helper in src/lib/csv.ts.
 */

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");

  const prospects = await db.prospect.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "desc" },
  });

  const lines = [
    "businessName,industry,website,email,phone,country,region,status,qualificationScore,qualificationReasons,sourceType,sourceUrl,createdAt",
  ];
  for (const p of prospects) {
    lines.push(
      [
        csvCell(p.businessName),
        csvCell(p.industry),
        csvCell(p.website),
        csvCell(p.email),
        csvCell(p.phone),
        csvCell(p.country),
        csvCell(p.region),
        csvCell(p.status),
        csvCell(p.qualificationScore),
        csvCell(parseJson<string[]>(p.qualificationReasons, []).join("; ")),
        csvCell(p.sourceType),
        csvCell(p.sourceUrl),
        csvCell(p.createdAt.toISOString()),
      ].join(",")
    );
  }

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="prospects-export.csv"',
    },
  });
});
