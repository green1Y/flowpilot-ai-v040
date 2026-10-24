import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";

/**
 * GET /api/activity — workspace Activity / Error Center feed (Batch C §7.21).
 *
 * Aggregates the failure signals that already exist in the workspace —
 * failed workflow executions, failed outbound sends, and integrations
 * needing attention — into one newest-first list (cap 50). Read-only for
 * any workspace member (requireWorkspace, matching sibling read routes).
 * Nothing is fabricated: an empty workspace returns an empty list.
 */

export type ActivityKind = "workflow_execution" | "outbound_send" | "integration";

export interface ActivityItem {
  kind: ActivityKind;
  title: string;
  detail: string;
  /** ISO timestamp the feed is sorted by. */
  at: string;
  href: string;
}

const PER_SOURCE_LIMIT = 25;
const TOTAL_LIMIT = 50;
const DETAIL_MAX = 300;

/** statusDetail codes that mark an integration as error-ish (see schema). */
const ERROR_DETAIL_CODES = new Set([
  "permission_missing",
  "token_expired",
  "callback_failed",
  "test_failed",
  "verify_failed",
]);

function truncate(value: string | null | undefined): string {
  if (!value) return "";
  const s = value.trim();
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s;
}

interface StatusDetail {
  code?: string;
  message?: string;
  at?: string;
}

/** statusDetail is a JSON string { code, message, at } — parse defensively. */
function parseStatusDetail(raw: string | null): StatusDetail | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    return {
      code: typeof rec.code === "string" ? rec.code : undefined,
      message: typeof rec.message === "string" ? rec.message : undefined,
      at: typeof rec.at === "string" ? rec.at : undefined,
    };
  } catch {
    return null;
  }
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const workspaceId = ctx.workspaceId;

  const [executions, sends, integrations] = await Promise.all([
    db.workflowExecution.findMany({
      where: {
        workflow: { workspaceId },
        status: { in: ["FAILED", "DEAD_LETTER"] },
      },
      orderBy: { startedAt: "desc" },
      take: PER_SOURCE_LIMIT,
      include: { workflow: { select: { id: true, name: true } } },
    }),
    db.outboundSend.findMany({
      where: { workspaceId, status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: PER_SOURCE_LIMIT,
    }),
    // Candidates: an attention status, or a statusDetail that may carry an
    // error code (JSON content can't be filtered in the query — done below).
    db.integration.findMany({
      where: {
        workspaceId,
        OR: [{ status: { in: ["NEEDS_ATTENTION", "EXPIRED"] } }, { statusDetail: { not: null } }],
      },
      take: 50,
    }),
  ]);

  const items: ActivityItem[] = [];

  for (const ex of executions) {
    const at = ex.finishedAt ?? ex.startedAt;
    items.push({
      kind: "workflow_execution",
      title: `${ex.workflow.name} execution failed`,
      detail: truncate(ex.error),
      at: at.toISOString(),
      href: `/app/automations/${ex.workflow.id}/executions`,
    });
  }

  for (const send of sends) {
    items.push({
      kind: "outbound_send",
      title: `Outbound send failed (${send.channel})`,
      detail: truncate(send.error),
      at: send.createdAt.toISOString(),
      href: "/app/inbox",
    });
  }

  for (const integration of integrations) {
    const detail = parseStatusDetail(integration.statusDetail);
    const needsAttention =
      integration.status === "NEEDS_ATTENTION" || integration.status === "EXPIRED";
    const errorish = detail?.code != null && ERROR_DETAIL_CODES.has(detail.code);
    if (!needsAttention && !errorish) continue;

    const account = integration.accountName?.trim() || "account";
    const detailAt = detail?.at ? new Date(detail.at) : null;
    const at =
      integration.lastErrorAt ??
      (detailAt && !Number.isNaN(detailAt.getTime()) ? detailAt : null) ??
      integration.lastSyncAt ??
      integration.createdAt;
    items.push({
      kind: "integration",
      title: `${integration.provider} · ${account} needs attention`,
      detail: truncate(integration.lastError ?? detail?.message),
      at: at.toISOString(),
      href: "/app/integrations",
    });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const sliced = items.slice(0, TOTAL_LIMIT);

  // `data.items` follows the standard ok() envelope the api client unwraps;
  // the top-level `items` mirrors the Batch C spec's literal response shape.
  return Response.json({ ok: true, data: { items: sliced }, items: sliced });
});
