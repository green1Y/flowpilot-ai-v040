/**
 * POST /api/workspaces/[id]/demo/reset route tests.
 *
 * - 401/403: unauthenticated, non-member, cross-workspace id, below-MANAGER role.
 * - The workspace id always comes from the URL — a client-supplied id in the
 *   body is ignored.
 * - MANAGER+ success deletes the URL workspace's demo data and audit-logs.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string) {
  mockedRequireUser.mockResolvedValue({ userId, email: `${userId}@example.com` } as any);
}

function postReq(id: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${id}/demo/reset`, {
    method: "POST",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json" },
  });
}

function call(id: string, body?: unknown) {
  return POST(postReq(id, body), { params: Promise.resolve({ id }) });
}

const suffix = `rreset${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsA = "";
let wsB = "";
let ownerA = "";
let agentA = "";
let ownerB = "";
let stranger = "";

async function seedDemoContact(workspaceId: string, name: string) {
  const contact = await db.contact.create({
    data: { workspaceId, name, channel: "facebook", tags: JSON.stringify(["demo"]) },
  });
  const convo = await db.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "facebook", tags: JSON.stringify(["demo"]) },
  });
  return { contact, convo };
}

beforeAll(async () => {
  const mkUser = (email: string) =>
    db.user.create({ data: { email, name: email, passwordHash: "x" } });
  ownerA = (await mkUser(`rreset-owner-a-${suffix}@example.com`)).id;
  agentA = (await mkUser(`rreset-agent-a-${suffix}@example.com`)).id;
  ownerB = (await mkUser(`rreset-owner-b-${suffix}@example.com`)).id;
  stranger = (await mkUser(`rreset-stranger-${suffix}@example.com`)).id;

  const org = await db.organization.create({ data: { name: `RReset Org ${suffix}` } });
  wsA = (
    await db.workspace.create({
      data: { orgId: org.id, name: `RReset A ${suffix}`, slug: `rreset-a-${suffix}`, isDemo: true },
    })
  ).id;
  wsB = (
    await db.workspace.create({
      data: { orgId: org.id, name: `RReset B ${suffix}`, slug: `rreset-b-${suffix}`, isDemo: true },
    })
  ).id;
  await db.membership.createMany({
    data: [
      { userId: ownerA, workspaceId: wsA, role: "OWNER" },
      { userId: agentA, workspaceId: wsA, role: "AGENT" },
      { userId: ownerB, workspaceId: wsB, role: "OWNER" },
    ],
  });
  await seedDemoContact(wsA, "Demo A");
  await seedDemoContact(wsB, "Demo B");
});

describe("POST /api/workspaces/[id]/demo/reset", () => {
  it("403 for a non-member (no membership anywhere)", async () => {
    authedAs(stranger);
    const res = await call(wsA);
    expect(res.status).toBe(403);
  });

  it("403 for a cross-workspace id (member of B calls A's id)", async () => {
    authedAs(ownerB);
    const res = await call(wsA);
    expect(res.status).toBe(403);
    // A's demo data untouched.
    expect(await db.contact.count({ where: { workspaceId: wsA } })).toBe(1);
  });

  it("403 for a below-MANAGER role (AGENT)", async () => {
    authedAs(agentA);
    const res = await call(wsA);
    expect(res.status).toBe(403);
    expect(await db.contact.count({ where: { workspaceId: wsA } })).toBe(1);
  });

  it("MANAGER+ success: resets the URL workspace, ignores a client-supplied id in the body", async () => {
    authedAs(ownerA);
    // Attacker-style body claiming a different workspace — must be ignored.
    const res = await call(wsA, { workspaceId: wsB, id: wsB });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.data.workspaceId).toBe(wsA);
    expect(json.data.deleted.contacts).toBe(1);

    // URL workspace's demo data is gone…
    expect(await db.contact.count({ where: { workspaceId: wsA } })).toBe(0);
    expect(await db.conversation.count({ where: { workspaceId: wsA } })).toBe(0);
    // …the body-claimed workspace is untouched.
    expect(await db.contact.count({ where: { workspaceId: wsB } })).toBe(1);
    expect(await db.conversation.count({ where: { workspaceId: wsB } })).toBe(1);
    // Audit-logged.
    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: wsA, action: "workspace.demo_reset" },
    });
    expect(audit?.actorId).toBe(ownerA);
  });
});
