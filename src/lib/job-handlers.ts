/**
 * Durable-job handler registrations (v0.4.0, Wave 2B).
 *
 * Import this module for its side effect wherever jobs are processed
 * (src/app/api/jobs/process-due/route.ts does so). To add a handler for
 * a new job type, call registerJobHandler() here (or in the feature's
 * own module, imported from here) — handlers are keyed by type string
 * and receive the job's parsed payload.
 *
 * Handlers shipped here:
 * - "import_confirm": the durable async path for the import-batch flow.
 *   Payload: { batchId, workspaceId, resolutions }. It runs the same
 *   applyImportResolutions() the synchronous confirm route uses, so a
 *   batch confirmed through either path ends up identical — and a
 *   second application is a no-op success (batch already CONFIRMED),
 *   which keeps redelivered jobs from double-importing rows.
 *
 * The synchronous confirm route (contacts/imports/[id]/confirm) is the
 * primary path for the UI because it returns the import report inline;
 * this handler exists for large batches and retries, where a durable
 * job (rather than a held-open request) is the right shape.
 */

import { registerJobHandler } from "./jobs";
import { applyImportResolutions, type ResolutionInput } from "./imports";

export function ensureJobHandlersRegistered(): void {
  // registerJobHandler overwrites silently, so re-registering is always
  // safe — and REQUIRED after clearJobHandlers() (used by tests): a
  // module-level "already registered" guard would leave the registry
  // empty after a clear, and jobs would fail with "no handler registered".
  registerJobHandler("import_confirm", async ({ payload }) => {
    const batchId = payload.batchId as string | undefined;
    const workspaceId = payload.workspaceId as string | undefined;
    const resolutions = (payload.resolutions ?? {}) as Record<string, ResolutionInput>;
    if (!batchId || !workspaceId) {
      throw new Error('import_confirm payload requires "batchId" and "workspaceId"');
    }
    try {
      return await applyImportResolutions(workspaceId, batchId, resolutions);
    } catch (e) {
      // Already confirmed = the work is done; a redelivery must succeed,
      // not dead-letter a job whose batch is already imported.
      if (e instanceof Error && e.message === "Import batch already confirmed") {
        return { batchId, alreadyConfirmed: true };
      }
      throw e;
    }
  });
}

// Register on import so route handlers only need `import "@/lib/job-handlers"`.
ensureJobHandlersRegistered();
