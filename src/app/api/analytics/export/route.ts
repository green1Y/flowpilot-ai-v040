import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { analyticsExportQuerySchema } from "@/lib/validation-stage4a";
import { expandRangeBound } from "@/lib/analytics/queries";
import { parseJson } from "@/lib/serialize";

const DAY_MS = 86_400_000;
const MAX_ROWS = 10_000;

/** CSV-escape a cell (handles quotes, commas, newlines).
 *  v0.4.0: neutralize formula injection (see contacts/export) — a cell
 *  starting with = + - @ | % gets a leading single quote. */
function cell(v: unknown): string {
  const s = v == null ? "" : String(v);
  const neutralized = /^[ \t]*[=+\-@|%]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

function resolveRange(fromRaw: string | undefined, toRaw: string | undefined): { from: Date; to: Date } {
  const now = new Date();
  // Date-only bounds cover whole days (UTC) so an export "to 2026-10-20"
  // includes all of Oct 20 instead of stopping at midnight.
  const to = toRaw ? expandRangeBound(toRaw, true) : now;
  const from = fromRaw ? expandRangeBound(fromRaw, false) : new Date(now.getTime() - 30 * DAY_MS);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) {
    throw err("Invalid from/to — provide ISO dates", 422);
  }
  if (from > to) throw err("Invalid range: from must be before to", 422);
  return { from, to };
}

async function fetchRows(
  metric: "messages" | "campaigns" | "leads",
  workspaceId: string,
  from: Date,
  to: Date,
  channel?: string
): Promise<{ header: string[]; rows: string[][]; truncated: boolean }> {
  const rows: string[][] = [];
  let truncated = false;

  if (metric === "messages") {
    let cursor: string | undefined;
    const header = ["date", "message_id", "conversation_id", "contact_name", "channel", "direction", "body", "ai_generated", "mocked", "internal_note"];
    for (let page = 0; page < Math.ceil(MAX_ROWS / 1000) + 1; page++) {
      const batch = await db.message.findMany({
        where: {
          createdAt: { gte: from, lte: to },
          conversation: {
            workspaceId,
            ...(channel ? { channel } : {}),
          },
        },
        include: { conversation: { select: { channel: true, contact: { select: { name: true } } } } },
        orderBy: { id: "asc" },
        take: 1000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;
      for (const m of batch) {
        if (rows.length >= MAX_ROWS) {
          truncated = true;
          break;
        }
        rows.push([
          m.createdAt.toISOString(),
          m.id,
          m.conversationId,
          m.conversation.contact.name,
          m.conversation.channel,
          m.direction,
          m.body,
          String(m.aiGenerated),
          String(m.mocked),
          String(m.internalNote),
        ]);
      }
      if (batch.length < 1000 || truncated) break;
      cursor = batch[batch.length - 1].id;
    }
    return { header, rows, truncated };
  }

  if (metric === "campaigns") {
    let cursor: string | undefined;
    const header = ["campaign_id", "campaign_name", "channel", "campaign_status", "contact_name", "recipient_status", "sent_at", "replied_at", "mocked", "error"];
    for (let page = 0; page < Math.ceil(MAX_ROWS / 1000) + 1; page++) {
      const batch = await db.campaignRecipient.findMany({
        where: {
          campaign: {
            workspaceId,
            ...(channel ? { channel } : {}),
          },
        },
        include: {
          campaign: { select: { id: true, name: true, channel: true, status: true } },
          contact: { select: { name: true } },
        },
        orderBy: { id: "asc" },
        take: 1000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;
      for (const r of batch) {
        if (rows.length >= MAX_ROWS) {
          truncated = true;
          break;
        }
        rows.push([
          r.campaign.id,
          r.campaign.name,
          r.campaign.channel,
          r.campaign.status,
          r.contact.name,
          r.status,
          r.sentAt ? r.sentAt.toISOString() : "",
          r.repliedAt ? r.repliedAt.toISOString() : "",
          String(r.mocked ?? ""),
          r.error ?? "",
        ]);
      }
      if (batch.length < 1000 || truncated) break;
      cursor = batch[batch.length - 1].id;
    }
    return { header, rows, truncated };
  }

  // metric === "leads"
  let cursor: string | undefined;
  const header = ["contact_id", "name", "email", "phone", "channel", "lead_status", "lead_score", "tags", "first_seen_at"];
  for (let page = 0; page < Math.ceil(MAX_ROWS / 1000) + 1; page++) {
    const batch = await db.contact.findMany({
      where: {
        workspaceId,
        firstSeenAt: { gte: from, lte: to },
        ...(channel ? { channel } : {}),
      },
      orderBy: { id: "asc" },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) break;
    for (const c of batch) {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
      rows.push([
        c.id,
        c.name,
        c.email ?? "",
        c.phone ?? "",
        c.channel,
        c.leadStatus,
        String(c.leadScore),
        parseJson<string[]>(c.tags, []).join(";"),
        c.firstSeenAt.toISOString(),
      ]);
    }
    if (batch.length < 1000 || truncated) break;
    cursor = batch[batch.length - 1].id;
  }
  return { header, rows, truncated };
}

/**
 * GET /api/analytics/export?metric=messages|campaigns|leads&from&to&channel
 *
 * CSV download of workspace activity. Tenant-scoped, date-filtered, capped at
 * 10,000 rows — truncation is reported honestly via the `x-truncated`
 * response header (never silently dropped).
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Exports can carry up to 10k rows including message bodies — gate them
  // like the billing read (MANAGER+), not open to every workspace member.
  requireRole(ctx, "MANAGER");
  const sp = new URL(req.url).searchParams;
  const q = analyticsExportQuerySchema.safeParse({
    metric: sp.get("metric") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    channel: sp.get("channel") ?? undefined,
  });
  if (!q.success) throw err("Invalid query parameters: metric must be messages | campaigns | leads", 422);

  const { from, to } = resolveRange(q.data.from, q.data.to);
  // "all" is a UI-only value meaning "no channel filter" — never a literal
  // channel name (matches resolveAnalyticsQuery in the analytics routes).
  const channel =
    q.data.channel && q.data.channel !== "all" ? q.data.channel : undefined;
  const { header, rows, truncated } = await fetchRows(
    q.data.metric,
    ctx.workspaceId,
    from,
    to,
    channel
  );

  const csv = [header.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
  const filename = `flowpilot-${q.data.metric}-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "x-truncated": String(truncated),
      "x-demo": String(process.env.DEMO_MODE === "true"),
      "x-rows": String(rows.length),
    },
  });
});
