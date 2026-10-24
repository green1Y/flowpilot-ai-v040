/**
 * Stage 4c route tests: knowledge chunking on write, reindex backfill,
 * test-route grounding, escalation queue + resolve, and tenant isolation
 * across the new endpoints.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { indexDocument } from "@/lib/ai/chunks";
import { POST as knowledgePost } from "./knowledge/route";
import { PATCH as knowledgePatch } from "./knowledge/[id]/route";
import { POST as reindexPost } from "./knowledge/reindex/route";
import { POST as testPost } from "./test/route";
import { GET as escalationsGet } from "./escalations/route";
import { POST as resolvePost } from "./escalations/[id]/resolve/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  });
}

function req(url: string, workspaceId: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-workspace-id": workspaceId,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userA = { id: "", email: "" };
let wsA = "";
let wsB = "";
const orgNames: string[] = [];

beforeAll(async () => {
  const a = await db.user.create({
    data: { email: `stage4c-a-${suffix}@example.com`, name: "Stage4c A", passwordHash: "x" },
  });
  const b = await db.user.create({
    data: { email: `stage4c-b-${suffix}@example.com`, name: "Stage4c B", passwordHash: "x" },
  });
  userA = { id: a.id, email: a.email };

  const orgA = await db.organization.create({ data: { name: `Stage4c Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `Stage4c Org B ${suffix}` } });
  orgNames.push(orgA.name, orgB.name);

  const wA = await db.workspace.create({ data: { orgId: orgA.id, name: `WS A`, slug: `s4c-a-${suffix}` } });
  const wB = await db.workspace.create({ data: { orgId: orgB.id, name: `WS B`, slug: `s4c-b-${suffix}` } });
  wsA = wA.id;
  wsB = wB.id;

  await db.membership.create({ data: { userId: a.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: b.id, workspaceId: wB.id, role: "OWNER" } });

  authedAs(userA.id, userA.email);
});

afterAll(async () => {
  await db.escalation.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.knowledgeChunk.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.knowledgeDoc.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.aiConfig.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.membership.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.workspace.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await db.organization.deleteMany({ where: { name: { in: orgNames } } });
  await db.user.deleteMany({ where: { email: { contains: suffix } } });
  await db.$disconnect();
});

describe("knowledge chunking on write", () => {
  it("POST /knowledge indexes the doc and returns chunkCount", async () => {
    const res = await knowledgePost(
      req(
        "http://localhost/api/ai-config/knowledge",
        wsA,
        {
          title: "Return policy",
          content:
            "We accept returns within 30 days of purchase. Items must be unused and in original packaging. Refunds are issued to the original payment method within 5 business days.",
        }
      ),
      {} as never
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.doc.chunkCount).toBeGreaterThan(0);
    const chunks = await db.knowledgeChunk.count({ where: { docId: json.data.doc.id } });
    expect(chunks).toBe(json.data.doc.chunkCount);
  });

  it("PATCH /knowledge/:id rebuilds chunks when content changes", async () => {
    const res = await knowledgePost(
      req("http://localhost/api/ai-config/knowledge", wsA, {
        title: "Patchable doc",
        content:
          "Original content line one. Original content line two. Original content line three. Original content line four. Original content line five.",
      }),
      {} as never
    );
    const docId = (await res.json()).data.doc.id;

    const patched = await knowledgePatch(
      req(`http://localhost/api/ai-config/knowledge/${docId}`, wsA, {
        content: "Completely rewritten short text.",
      }),
      { params: { id: docId } }
    );
    expect(patched.status).toBe(200);
    const json = await patched.json();
    expect(json.data.doc.chunkCount).toBe(1);
    const chunks = await db.knowledgeChunk.findMany({ where: { docId } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("Completely rewritten short text.");

    // Title-only update keeps the existing chunks.
    const titleOnly = await knowledgePatch(
      req(`http://localhost/api/ai-config/knowledge/${docId}`, wsA, { title: "Renamed doc" }),
      { params: { id: docId } }
    );
    expect(titleOnly.status).toBe(200);
    expect((await titleOnly.json()).data.doc.chunkCount).toBe(1);
  });

  it("POST /knowledge/reindex backfills chunks for pre-existing docs", async () => {
    const doc = await db.knowledgeDoc.create({
      data: {
        workspaceId: wsA,
        title: "Legacy doc",
        content: "An old document created before chunking existed. It still needs to be searchable.",
      },
    });
    expect(await db.knowledgeChunk.count({ where: { docId: doc.id } })).toBe(0);

    const res = await reindexPost(req("http://localhost/api/ai-config/knowledge/reindex", wsA, {}), {} as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    const entry = json.data.docs.find((d: { id: string }) => d.id === doc.id);
    expect(entry.chunkCount).toBeGreaterThan(0);
  });
});

describe("test route grounding", () => {
  it("returns sources + snippets for a question matching a doc", async () => {
    const doc = await db.knowledgeDoc.create({
      data: {
        workspaceId: wsA,
        title: "Shipping policy",
        content: "Standard shipping takes 3 to 5 business days. Express shipping is available at checkout.",
      },
    });
    await indexDocument(doc.id);

    const res = await testPost(
      req("http://localhost/api/ai-config/test", wsA, { question: "How long does shipping take?" }),
      {} as never
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.sources).toContain("Shipping policy");
    expect(json.data.snippets.length).toBeGreaterThan(0);
    expect(json.data.sourcesUsed.length).toBeGreaterThan(0);
    // Honest: no invented answer — mock reply is labeled.
    expect(json.data.mocked).toBe(true);
  });
});

describe("escalation queue", () => {
  it("lists and resolves escalations", async () => {
    const esc = await db.escalation.create({
      data: { workspaceId: wsA, reason: "low confidence 0.42 < 0.70" },
    });

    const list = await escalationsGet(req("http://localhost/api/ai-config/escalations?status=OPEN", wsA), {} as never);
    const listJson = await list.json();
    expect(listJson.data.escalations.some((e: { id: string }) => e.id === esc.id)).toBe(true);

    const resolved = await resolvePost(
      req(`http://localhost/api/ai-config/escalations/${esc.id}/resolve`, wsA, {}),
      { params: { id: esc.id } }
    );
    expect(resolved.status).toBe(200);

    const row = await db.escalation.findUnique({ where: { id: esc.id } });
    expect(row?.status).toBe("RESOLVED");
    expect(row?.resolvedAt).toBeTruthy();
    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: wsA, action: "ai.escalation.resolved" },
    });
    expect(audit).toBeTruthy();

    // Resolving twice → 404.
    const again = await resolvePost(
      req(`http://localhost/api/ai-config/escalations/${esc.id}/resolve`, wsA, {}),
      { params: { id: esc.id } }
    );
    expect(again.status).toBe(404);
  });
});

describe("tenant isolation on the new routes", () => {
  it("rejects cross-tenant access to the other workspace's queue and reindex", async () => {
    authedAs(userA.id, userA.email); // member of wsA only

    const other = await db.escalation.create({
      data: { workspaceId: wsB, reason: "human approval required" },
    });

    const list = await escalationsGet(req("http://localhost/api/ai-config/escalations?status=ALL", wsA), {} as never);
    const listJson = await list.json();
    expect(listJson.data.escalations.some((e: { id: string }) => e.id === other.id)).toBe(false);

    const resolve = await resolvePost(
      req(`http://localhost/api/ai-config/escalations/${other.id}/resolve`, wsA, {}),
      { params: { id: other.id } }
    );
    expect(resolve.status).toBe(404); // not visible from wsA

    const reindex = await reindexPost(req("http://localhost/api/ai-config/knowledge/reindex", wsB, {}), {} as never);
    expect(reindex.status).toBe(403); // not a member of wsB

    await db.escalation.delete({ where: { id: other.id } });
  });
});
