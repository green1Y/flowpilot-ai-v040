import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { applyImportResolutions, type ResolutionInput } from "@/lib/imports";

const resolutionSchema = z.union([
  z.enum(["create", "merge", "skip"]),
  z.object({
    action: z.enum(["create", "merge", "skip"]),
    overwriteFields: z.array(z.string()).optional(),
  }),
]);

const confirmSchema = z.object({
  resolutions: z.record(z.string(), resolutionSchema).default({}),
});

/**
 * POST /api/contacts/imports/[id]/confirm — AGENT+.
 * Applies resolutions in ONE transaction (see applyImportResolutions):
 * create → new Contact; merge → fill-empty-only unless overwriteFields
 * explicitly lists a field; skip → SKIPPED. Unresolved DUPLICATE rows
 * default to skip (never silently merged); unresolved VALID rows default
 * to create; INVALID rows can never import.
 * Returns the import report { imported, skipped, failed, errors[] }.
 */
export const POST = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const ws = await requireWorkspace(req);
    requireRole(ws, "AGENT");
    const { id } = await ctx.params;
    const body = await parseBody(req, confirmSchema);
    let report;
    try {
      report = await applyImportResolutions(
        ws.workspaceId,
        id,
        body.resolutions as Record<string, ResolutionInput>
      );
    } catch (e) {
      if (e instanceof Error && e.message === "Import batch not found") {
        throw err("Import batch not found", 404);
      }
      if (e instanceof Error && e.message === "Import batch already confirmed") {
        throw err("Import batch already confirmed", 409);
      }
      throw err(e instanceof Error ? e.message : "Confirm failed", 422);
    }
    await auditLog(ws.workspaceId, ws.userId, "contacts.import_batch_confirmed", {
      type: "import_batch",
      id,
      imported: report.imported,
      skipped: report.skipped,
      failed: report.failed,
    });
    return ok(report);
  }
);
