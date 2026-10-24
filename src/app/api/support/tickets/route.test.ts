/**
 * /api/support/tickets tests (Workstream A).
 * - POST stores the ticket and returns 201 with the persisted row
 *   (confirmation ONLY after storage).
 * - POST rejects invalid bodies (422) without creating rows.
 * - GET lists the caller's workspace tickets newest-first.
 * - Cross-workspace access is denied (403); other workspaces' tickets
 *   never leak into the list.
 * Tenancy is stubbed at the boundary (same pattern as the onboarding tests).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/tenancy";
import { GET, POST } from "./route";

vi.mock("@/lib/tenancy", () => ({ requireWorkspace: vi.fn() }));
const mockedRequireWorkspace = vi.mocked(requireWorkspace);

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let userA = "", wsA = "", userB = "", wsB = "";

async function mk(tag: string) {
  const u = await db.user.create({
    data: {
      email: `ticket-${tag}-${suffix}@example.com`,
      name: `Ticket ${tag}`,
      passwordHash: "x",
    },
  });
  const org = await db.organization.create({
    data: { name: `Ticket Org ${tag} ${suffix}` },
  });
  const ws = await db.workspace.create({
    data: {
      orgId: org.id,
      name: `Ticket WS ${tag} ${suffix}`,
      slug: `ticket-ws-${tag}-${suffix}`,
    },
  });
  await db.membership.create({
    data: { userId: u.id, workspaceId: ws.id, role: "AGENT" },
  });
  return { userId: u.id, wsId: ws.id };
}

function authed(userId: string, workspaceId: string) {
  mockedRequireWorkspace.mockResolvedValue({
    userId,
    workspaceId,
    role: "AGENT",
  });
}

function denied() {
  mockedRequireWorkspace.mockRejectedValue(
    Response.json({ error: "Forbidden" }, { status: 403 })
  );
}

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/support/tickets", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function cleanup() {
  await db.supportTicket.deleteMany({
    where: { workspaceId: { in: [wsA, wsB] } },
  });
  for (const uid of [userA, userB]) {
    const ms = await db.membership.findMany({ where: { userId: uid } });
    await db.membership.deleteMany({ where: { userId: uid } });
    await db.workspace.deleteMany({
      where: { id: { in: ms.map((m) => m.workspaceId) } },
    });
    await db.user.deleteMany({ where: { id: uid } });
  }
  // Orgs left behind are harmless in the scratch test DB; workspaces cascade.
}
afterAll(cleanup);

describe("support tickets", () => {
  beforeAll(async () => {
    ({ userId: userA, wsId: wsA } = await mk("a"));
    ({ userId: userB, wsId: wsB } = await mk("b"));
  });

  it("POST stores the ticket and returns 201 with the persisted row", async () => {
    authed(userA, wsA);
    const res = await POST(
      req("POST", { subject: "Login broken", message: "I cannot log in since Tuesday." })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { ticket: Record<string, unknown> };
    };
    const t = body.data.ticket;
    expect(t.subject).toBe("Login broken");
    expect(t.message).toBe("I cannot log in since Tuesday.");
    expect(t.status).toBe("OPEN");
    expect(typeof t.id).toBe("string");
    expect(t.createdAt).toBeTruthy();

    // Confirmation came from the stored row.
    const stored = await db.supportTicket.findUniqueOrThrow({
      where: { id: t.id as string },
    });
    expect(stored.workspaceId).toBe(wsA);
    expect(stored.userId).toBe(userA);
    expect(stored.subject).toBe("Login broken");
  });

  it("POST rejects invalid bodies with 422 and stores nothing", async () => {
    authed(userA, wsA);
    const before = await db.supportTicket.count({ where: { workspaceId: wsA } });

    expect((await POST(req("POST", { subject: "", message: "x" }))).status).toBe(422);
    expect(
      (await POST(req("POST", { subject: "   ", message: "x" }))).status
    ).toBe(422);
    expect(
      (await POST(req("POST", { subject: "s" }))).status
    ).toBe(422); // missing message
    expect(
      (await POST(req("POST", { subject: "s", message: "x".repeat(5001) }))).status
    ).toBe(422);
    expect(
      (await POST(req("POST", { subject: "s", message: "m", extra: 1 }))).status
    ).toBe(422); // strict

    expect(await db.supportTicket.count({ where: { workspaceId: wsA } })).toBe(
      before
    );
  });

  it("GET lists the workspace tickets newest-first", async () => {
    authed(userA, wsA);
    await db.supportTicket.deleteMany({ where: { workspaceId: wsA } });
    const older = await db.supportTicket.create({
      data: {
        workspaceId: wsA,
        userId: userA,
        subject: "older",
        message: "older message",
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const newer = await db.supportTicket.create({
      data: {
        workspaceId: wsA,
        userId: userA,
        subject: "newer",
        message: "newer message",
        createdAt: new Date(),
      },
    });

    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tickets: { id: string; subject: string }[] };
    };
    expect(body.data.tickets.map((t) => t.id)).toEqual([newer.id, older.id]);
  });

  it("denies cross-workspace access (403) and never leaks other tickets", async () => {
    // Ticket filed in workspace B.
    authed(userB, wsB);
    const created = await POST(
      req("POST", { subject: "B secret", message: "workspace B only" })
    );
    expect(created.status).toBe(201);

    // Caller authenticated but not a member of the requested workspace.
    denied();
    expect((await POST(req("POST", { subject: "s", message: "m" }))).status).toBe(403);
    expect((await GET(req("GET"))).status).toBe(403);

    // Workspace A's list contains no workspace-B tickets.
    authed(userA, wsA);
    const res = await GET(req("GET"));
    const body = (await res.json()) as {
      data: { tickets: { subject: string }[] };
    };
    expect(
      body.data.tickets.some((t) => t.subject === "B secret")
    ).toBe(false);
  });
});
