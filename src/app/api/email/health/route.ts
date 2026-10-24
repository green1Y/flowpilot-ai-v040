/**
 * GET /api/email/health — Resend health probe (Wave 2E, MANAGER+).
 *
 * - RESEND_API_KEY or EMAIL_FROM unset → { configured: false, code:
 *   "EMAIL_NOT_CONFIGURED" } (no HealthCheck row: nothing was probed).
 * - Otherwise a SAFE read-only check: GET https://api.resend.com/domains
 *   with the Bearer key and a 20s timeout. Listing domains validates the
 *   key without sending anything.
 *   - 2xx → { configured: true, reachable: true, domainsCount } +
 *     HealthCheck row (probe "config", status OK, integrationId "email").
 *   - Failure → { configured: true, reachable: false, error } +
 *     HealthCheck row (status FAILED).
 * - The key is never logged and never returned: error text is bounded to
 *   300 chars and the key itself is redacted out of it if it ever appears.
 * - No Resend webhooks are implemented in this wave, so this probe covers
 *   configuration/reachability only — never delivery or open tracking.
 */
import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { db } from "@/lib/db";

const RESEND_DOMAINS_URL = "https://api.resend.com/domains";
const RESEND_TIMEOUT_MS = 20_000;

function sanitizeError(message: string, apiKey: string): string {
  return message.split(apiKey).join("[redacted]").slice(0, 300);
}

async function writeHealthCheck(
  workspaceId: string,
  status: string,
  latencyMs: number,
  detail: Record<string, unknown>
): Promise<void> {
  try {
    await db.healthCheck.create({
      data: {
        workspaceId,
        integrationId: "email",
        probe: "config",
        status,
        latencyMs,
        detail: JSON.stringify(detail),
      },
    });
  } catch (e) {
    // The probe result is the primary output; a bookkeeping-write failure
    // must not turn a healthy probe into a 500. Detail is sanitized, so
    // this log line can never contain a credential.
    console.error("[email-health] failed to write HealthCheck row", e);
  }
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    return ok({ configured: false, code: "EMAIL_NOT_CONFIGURED" });
  }

  const started = Date.now();
  try {
    const res = await fetch(RESEND_DOMAINS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const raw = (await res.text().catch(() => "")).slice(0, 300);
      let message = `Resend API returned HTTP ${res.status}`;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as Record<string, unknown>).message === "string"
        ) {
          message = (parsed as Record<string, string>).message;
        }
      } catch {
        // Non-JSON error body: keep the HTTP-status message.
      }
      const error = sanitizeError(message, apiKey);
      await writeHealthCheck(ctx.workspaceId, "FAILED", latencyMs, { error });
      return ok({ configured: true, reachable: false, error });
    }
    const data = (await res.json().catch(() => null)) as {
      data?: unknown;
    } | null;
    const domainsCount = Array.isArray(data?.data) ? data.data.length : 0;
    await writeHealthCheck(ctx.workspaceId, "OK", latencyMs, {
      configured: true,
      domainsCount,
    });
    return ok({ configured: true, reachable: true, domainsCount });
  } catch (e) {
    const latencyMs = Date.now() - started;
    const error = sanitizeError(
      e instanceof Error ? e.message : "Resend API unreachable",
      apiKey
    );
    await writeHealthCheck(ctx.workspaceId, "FAILED", latencyMs, { error });
    return ok({ configured: true, reachable: false, error });
  }
});
