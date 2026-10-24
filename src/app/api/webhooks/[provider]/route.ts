import { NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { PROVIDERS } from "@/lib/integrations/providers";
import { auditLog } from "@/lib/audit";

// Replay protection: in-memory set of seen event ids. Best-effort only — it
// resets on restart and is per-process (fine for dev; use Redis in prod).
const seenEventIds = new Set<string>();

/** Constant-time string comparison (safe against length-mismatch throws). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const POST = handler(
  async (req: NextRequest, { params }: { params: Promise<{ provider: string }> }) => {
    const provider = (await params).provider;
    if (!PROVIDERS.some((p) => p.provider === provider)) {
      throw err(`Unknown provider: ${provider}`, 404);
    }

    const raw = await req.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      // Never crash on bad JSON.
      throw err("Invalid JSON body", 400);
    }

    const signature = req.headers.get("x-signature") ?? "";
    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
      // HMAC-SHA256 over the raw body, compared in constant time.
      const expected = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
      if (!safeEqual(expected, signature)) throw err("Invalid webhook signature", 401);
    } else {
      // v0.4.0: fail closed. The previous fallback delegated to the
      // adapter's check, and the mock adapter trusts every signature —
      // so with no WEBHOOK_SECRET configured this endpoint accepted any
      // payload unauthenticated. Set WEBHOOK_SECRET to use this route.
      throw err("Webhook secret not configured — set WEBHOOK_SECRET", 503, {
        code: "WEBHOOK_NOT_CONFIGURED",
      });
    }

    // Replay protection on the event id (providers use `id` or `event_id`).
    const eventId =
      typeof payload.id === "string"
        ? payload.id
        : typeof payload.event_id === "string"
          ? payload.event_id
          : null;
    let deduped = false;
    if (eventId) {
      const key = `${provider}:${eventId}`;
      deduped = seenEventIds.has(key);
      if (!deduped) {
        if (seenEventIds.size > 10_000) seenEventIds.clear(); // bound memory
        seenEventIds.add(key);
      }
    }

    // Best-effort audit: webhooks are unauthenticated, so only audit when the
    // caller identifies a workspace we can verify.
    try {
      const wsId =
        req.headers.get("x-workspace-id") ??
        new URL(req.url).searchParams.get("workspace");
      if (wsId) {
        const ws = await db.workspace.findUnique({
          where: { id: wsId },
          select: { id: true },
        });
        if (ws) {
          await auditLog(ws.id, null, "webhook.received", {
            type: "webhook",
            provider,
            eventId,
            deduped,
          });
        }
      }
    } catch {
      // Audit must never break webhook ingestion.
    }

    return ok({ received: true, deduped, mocked: true });
  }
);
