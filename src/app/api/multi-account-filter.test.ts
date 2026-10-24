/**
 * Batch B — account filtering at the API boundary (acceptance criteria
 * 2 + 6): the inbox conversation list and the analytics channels
 * breakdown honor an `integrationId` filter, results are scoped to the
 * exact account, and an integrationId belonging to ANOTHER workspace is
 * refused (403) rather than returning that tenant's data.
 *
 * Auth is mocked at the session boundary (same technique as
 * authz-conversations.test.ts); tenancy itself is the real code path.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

import { GET as listConversations } from "./conversations/route";
import { GET as channelsAnalytics } from "./analytics/channels/route";

const suffix = `maf${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const pnidA = `pnid-fa-${suffix}`;
const pnidB = `pnid-fb-${suffix}`;

let userId = "";
let ws = "";
let wsForeign = "";
let acctA = "";
let acctB = "";
let foreignAcct = "";
let convoA = "";
let convoB = "";

function req(path: string, workspaceId: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "GET",
    headers: { "x-workspace-id": workspaceId },
  });
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `maf-${suffix}@example.com`, name: "MAF", passwordHash: "x" },
  });
  userId = user.id;
  mockedRequireUser.mockResolvedValue({
    userId,
    email: user.email,
    user: { id: userId, name: "MAF", email: user.email },
  } as any);

  const org = await db.organization.create({ data: { name: `MAF Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `MAF WS ${suffix}`, slug: `maf-${suffix}` },
  });
  ws = w.id;
  await db.membership.create({ data: { userId, workspaceId: ws, role: "OWNER" } });

  const org2 = await db.organization.create({ data: { name: `MAF Org2 ${suffix}` } });
  const w2 = await db.workspace.create({
    data: { orgId: org2.id, name: `MAF WS2 ${suffix}`, slug: `maf2-${suffix}` },
  });
  wsForeign = w2.id;

  const mkAccount = async (workspaceId: string, pnid: string, name: string) =>
    db.integration.create({
      data: {
        workspaceId,
        provider: "whatsapp",
        status: "CONNECTED",
        externalAccountId: pnid,
        accountName: name,
        verifiedAt: new Date(),
      },
    });
  acctA = (await mkAccount(ws, pnidA, "Number A")).id;
  acctB = (await mkAccount(ws, pnidB, "Number B")).id;
  foreignAcct = (await mkAccount(wsForeign, `pnid-foreign-${suffix}`, "Foreign")).id;

  const contact = await db.contact.create({
    data: { workspaceId: ws, name: "Filter Fran", channel: "whatsapp" },
  });
  const cA = await db.conversation.create({
    data: { workspaceId: ws, contactId: contact.id, channel: "whatsapp", integrationId: acctA, status: "OPEN" },
  });
  const cB = await db.conversation.create({
    data: { workspaceId: ws, contactId: contact.id, channel: "whatsapp", integrationId: acctB, status: "OPEN" },
  });
  convoA = cA.id;
  convoB = cB.id;
  await db.message.create({
    data: { conversationId: cA.id, direction: "INBOUND", body: "hi via A" },
  });
  await db.message.create({
    data: { conversationId: cB.id, direction: "INBOUND", body: "hi via B" },
  });
});

describe("inbox conversation list — account filter", () => {
  it("returns only the selected account's conversations", async () => {
    const resB = await listConversations(req(`/api/conversations?integrationId=${acctB}`, ws));
    expect(resB.status).toBe(200);
    const bodyB = await resB.json();
    expect(bodyB.data.total).toBe(1);
    expect(bodyB.data.items[0].id).toBe(convoB);
    expect(bodyB.data.items[0].integrationId).toBe(acctB);

    const resAll = await listConversations(req(`/api/conversations`, ws));
    const bodyAll = await resAll.json();
    expect(bodyAll.data.total).toBe(2);
  });

  it("refuses a foreign workspace's integrationId with 403", async () => {
    const res = await listConversations(req(`/api/conversations?integrationId=${foreignAcct}`, ws));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

describe("analytics channels — per-account rows + filter", () => {
  it("returns one row per connected account with that account's counts", async () => {
    const res = await channelsAnalytics(req(`/api/analytics/channels?range=30d`, ws));
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = body.data.metrics.channels as Array<Record<string, unknown>>;
    const rowA = rows.find((r) => r.integrationId === acctA);
    const rowB = rows.find((r) => r.integrationId === acctB);
    expect(rowA).toBeTruthy();
    expect(rowB).toBeTruthy();
    expect(rowA!.conversations).toBe(1);
    expect(rowB!.conversations).toBe(1);
    expect(rowA!.messagesIn).toBe(1);
    expect(rowB!.accountName).toBe("Number B");
    // No generic per-channel whatsapp row remains once accounts exist.
    expect(rows.some((r) => r.channel === "whatsapp" && !r.integrationId)).toBe(false);
  });

  it("narrows to the single selected account and refuses foreign ids", async () => {
    const res = await channelsAnalytics(req(`/api/analytics/channels?range=30d&integrationId=${acctB}`, ws));
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = body.data.metrics.channels as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].integrationId).toBe(acctB);
    expect(body.data.metrics.totals.conversations).toBe(1);

    const foreign = await channelsAnalytics(
      req(`/api/analytics/channels?range=30d&integrationId=${foreignAcct}`, ws)
    );
    expect(foreign.status).toBe(403);
  });
});
