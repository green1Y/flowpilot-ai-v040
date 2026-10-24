import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { buildImportBatch, MAPPABLE_FIELDS } from "@/lib/imports";

/**
 * Import batches (v0.4.0, Wave 2B). The legacy direct import
 * (/api/contacts/import) is unchanged; this is the preview -> confirm
 * flow: POST creates a PREVIEW batch, then
 * POST /api/contacts/imports/[id]/confirm applies resolutions.
 *
 * GET (Member): ?id=… returns one batch with its rows; otherwise lists
 * batches for the workspace, newest first.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;
  const id = sp.get("id");
  if (id) {
    const batch = await db.importBatch.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      include: { rows: { orderBy: { rowIndex: "asc" } } },
    });
    if (!batch) throw err("Import batch not found", 404);
    return ok({
      batch: {
        id: batch.id,
        filename: batch.filename,
        status: batch.status,
        totalRows: batch.totalRows,
        importedCount: batch.importedCount,
        skippedCount: batch.skippedCount,
        failedCount: batch.failedCount,
        createdAt: batch.createdAt.toISOString(),
      },
      rows: batch.rows.map((r) => ({
        id: r.id,
        rowIndex: r.rowIndex,
        raw: JSON.parse(r.raw) as Record<string, string>,
        mapped: JSON.parse(r.mapped) as Record<string, unknown>,
        status: r.status,
        errors: JSON.parse(r.errors) as string[],
        resolution: r.resolution,
        contactId: r.contactId,
      })),
    });
  }
  const batches = await db.importBatch.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { _count: { select: { rows: true } } },
  });
  return ok({
    items: batches.map((b) => ({
      id: b.id,
      filename: b.filename,
      status: b.status,
      totalRows: b.totalRows,
      importedCount: b.importedCount,
      skippedCount: b.skippedCount,
      failedCount: b.failedCount,
      createdAt: b.createdAt.toISOString(),
    })),
  });
});

const createSchema = z.object({
  filename: z.string().min(1).max(255),
  csv: z.string().min(1).max(2_000_000),
  mapping: z.record(z.string(), z.string()).optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, createSchema);
  if (body.mapping) {
    for (const value of Object.values(body.mapping)) {
      if (!(MAPPABLE_FIELDS as readonly string[]).includes(value)) {
        throw err(`Unknown contact field in mapping: "${value}"`, 422);
      }
    }
  }
  let built;
  try {
    built = await buildImportBatch(ctx.workspaceId, body.filename, body.csv, body.mapping);
  } catch (e) {
    throw err(e instanceof Error ? e.message : "Import failed", 422);
  }
  await auditLog(ctx.workspaceId, ctx.userId, "contacts.import_batch_created", {
    type: "import_batch",
    id: built.batchId,
    filename: built.filename,
    totalRows: built.counts.total,
  });
  return ok({
    batchId: built.batchId,
    filename: built.filename,
    counts: built.counts,
    rows: built.rows.map((r) => ({
      id: r.id,
      rowIndex: r.rowIndex,
      raw: r.raw,
      mapped: r.mapped,
      status: r.status,
      errors: r.errors,
      matchedContactId: r.matchedContactId,
      diff: r.diff,
      duplicateInBatch: r.duplicateInBatch,
    })),
  });
});
