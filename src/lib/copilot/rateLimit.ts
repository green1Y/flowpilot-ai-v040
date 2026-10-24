/**
 * Per-workspace rate limit for copilot AI calls.
 *
 * Same in-memory sliding-window pattern as src/lib/rate-limit.ts
 * (deliberate fit for single-server deployment; move to Redis for
 * multi-server). Never stores prompts — only timestamps.
 */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;

export const COPILOT_RATE_LIMIT = { windowMs: WINDOW_MS, maxRequests: MAX_REQUESTS } as const;

const hits = new Map<string, number[]>();

function prune(key: string, now: number): number[] {
  const kept = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length === 0) hits.delete(key);
  else hits.set(key, kept);
  return kept;
}

/** True when the workspace has exhausted its copilot budget. */
export function isCopilotBlocked(workspaceId: string): boolean {
  return prune(workspaceId, Date.now()).length >= MAX_REQUESTS;
}

/** Record a copilot request; returns requests inside the window (incl. this one). */
export function recordCopilotRequest(workspaceId: string): number {
  const arr = prune(workspaceId, Date.now());
  arr.push(Date.now());
  hits.set(workspaceId, arr);
  return arr.length;
}

/** Test-only: reset copilot rate-limit state. */
export function resetCopilotRateLimit(): void {
  hits.clear();
}
