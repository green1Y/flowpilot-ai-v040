import { startWorker, type Job } from "@/lib/queue";
import { processWorkflowJob } from "./engine";

/**
 * Ensure the workflow queue worker is running. Idempotent — safe to call
 * from multiple route modules. The execute route calls this at module scope
 * so the dev server processes workflow jobs in the background.
 */
let started = false;

export function ensureWorkflowWorker(): void {
  if (started) return;
  started = true;
  startWorker(async (job: Job) => {
    if (job.type === "workflow_execution") {
      await processWorkflowJob(job);
    }
    // Unknown job types are ignored (other subsystems register own handlers).
  });
}
