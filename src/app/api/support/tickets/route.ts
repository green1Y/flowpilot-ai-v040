import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";

const ticketSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(5000),
  })
  .strict();

function toPublic(ticket: {
  id: string;
  subject: string;
  message: string;
  status: string;
  createdAt: Date;
}) {
  return {
    id: ticket.id,
    subject: ticket.subject,
    message: ticket.message,
    status: ticket.status,
    createdAt: ticket.createdAt,
  };
}

/**
 * POST /api/support/tickets — file a support ticket.
 *
 * Requires auth + workspace membership (requireWorkspace). The 201
 * confirmation is returned ONLY after the row is stored — the response
 * body carries the persisted ticket.
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const body = await parseBody(req, ticketSchema);

  const ticket = await db.supportTicket.create({
    data: {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      subject: body.subject,
      message: body.message,
    },
  });

  return ok({ ticket: toPublic(ticket) }, { status: 201 });
});

/**
 * GET /api/support/tickets — list the caller's workspace tickets,
 * newest first. Tenant-scoped by requireWorkspace; cross-workspace
 * reads are denied with 403.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);

  const tickets = await db.supportTicket.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      subject: true,
      message: true,
      status: true,
      createdAt: true,
    },
  });

  return ok({ tickets: tickets.map(toPublic) });
});
