/**
 * Batch C — Workflow version snapshots + pinned execution tests.
 *
 * Covers:
 *  (a) publish writes an immutable snapshot whose graph matches the
 *      published nodes/edges; re-publish at the same version does not
 *      overwrite it (even when the live graph was tampered with).
 *  (b) PINNING PROOF: an execution enqueued at v1 still runs the v1
 *      snapshot after the live graph is edited + republished as v2;
 *      a new execution runs the v2 graph.
 *  (c) execution rows carry workflowVersion; the versions API lists
 *      snapshots newest-first and 403/404s cross-workspace callers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { executeWorkflow, processWorkflowJob } from "./engine";
import { drainQueue, resetQueue } from "@/lib/queue";
import { POST as publishPOST } from "@/app/api/workflows/[id]/publish/route";
import { GET as versionsGET } from "@/app/api/workflows/[id]/versions/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `ver${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let seq = 0;

interface TestUser {
  id: string;
  email: string;
}

function setAuth(user: TestUser) {
  mockedRequireUser.mockResolvedValue({
    userId: user.id,
    email: user.email,
    user: { id: user.id, name: "Ver", email: user.email },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function makeUser(label: string): Promise<TestUser> {
  seq += 1;
  const user = await db.user.create({
    data: { email: `ver-${label}-${seq}-${suffix}@example.com`, name: `Ver ${label}`, passwordHash: "x" },
  });
  return { id: user.id, email: user.email };
}

async function makeWorkspace(user: TestUser): Promise<string> {
  seq += 1;
  const org = await db.organization.create({ data: { name: `Ver Org ${seq} ${suffix}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `Ver WS ${seq}`, slug: `ver-ws-${seq}-${suffix}` },
  });
  await db.membership.create({ data: { userId: user.id, workspaceId: ws.id, role: "OWNER" } });
  return ws.id;
}

/** Workflow: trigger.new_message -> action.add_tag(tag). Version defaults to 1. */
async function makeWorkflow(workspaceId: string, tag: string): Promise<{ wfId: string; triggerId: string; actionId: string }> {
  seq += 1;
  const triggerId = `ver-t-${seq}-${suffix}`;
  const actionId = `ver-a-${seq}-${suffix}`;
  const wf = await db.workflow.create({
    data: {
      workspaceId,
      name: `Ver WF ${seq} ${suffix}`,
      status: "DRAFT",
      nodes: {
        create: [
          {
            id: triggerId,
            kind: "trigger",
            type: "trigger.new_message",
            label: "New message",
            config: "{}",
            position: JSON.stringify({ x: 0, y: 0 }),
          },
          {
            id: actionId,
            kind: "action",
            type: "action.add_tag",
            label: "Add tag",
            config: JSON.stringify({ tag }),
            position: JSON.stringify({ x: 100, y: 0 }),
          },
        ],
      },
      edges: {
        create: [
          {
            id: `ver-e-${seq}-${suffix}`,
            sourceId: triggerId,
            targetId: actionId,
            label: "",
            condition: "{}",
          },
        ],
      },
    },
  });
  return { wfId: wf.id, triggerId, actionId };
}

function publishReq(wfId: string, wsId: string): NextRequest {
  return new NextRequest(`http://localhost/api/workflows/${wfId}/publish`, {
    method: "POST",
    headers: { "x-workspace-id": wsId },
  });
}

async function publish(wfId: string, wsId: string) {
  const res = await publishPOST(publishReq(wfId, wsId), { params: Promise.resolve({ id: wfId }) });
  expect(res.status).toBe(200);
  return res;
}

function versionsReq(wfId: string, wsId: string): NextRequest {
  return new NextRequest(`http://localhost/api/workflows/${wfId}/versions`, {
    method: "GET",
    headers: { "x-workspace-id": wsId },
  });
}

beforeEach(() => {
  resetQueue();
});

describe("workflow versioning", () => {
  it("(a) publish writes a snapshot matching the published graph; re-publish does not overwrite it", async () => {
    const user = await makeUser("a");
    setAuth(user);
    const wsId = await makeWorkspace(user);
    const { wfId, actionId } = await makeWorkflow(wsId, "original");

    await publish(wfId, wsId);

    const snap = await db.workflowVersion.findFirst({ where: { workflowId: wfId, version: 1 } });
    expect(snap).not.toBeNull();
    expect(snap!.createdBy).toBe(user.id);
    const graph = JSON.parse(snap!.graph) as {
      nodes: Array<{ id: string; config: Record<string, unknown> }>;
      edges: Array<{ sourceId: string; targetId: string }>;
    };
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].targetId).toBe(actionId);
    const actionNode = graph.nodes.find((n) => n.id === actionId);
    expect(actionNode?.config).toMatchObject({ tag: "original" });

    // Tamper with the live graph WITHOUT bumping the version, then
    // re-publish: the existing v1 snapshot must stay exactly as first
    // written (immutability), and no second snapshot may appear.
    await db.workflowNode.update({
      where: { id: actionId },
      data: { config: JSON.stringify({ tag: "tampered" }) },
    });
    await publish(wfId, wsId);

    const after = await db.workflowVersion.findFirst({ where: { workflowId: wfId, version: 1 } });
    expect(after!.graph).toBe(snap!.graph);
    expect(JSON.parse(after!.graph).nodes.find((n: { id: string }) => n.id === actionId).config).toMatchObject({
      tag: "original",
    });
    const count = await db.workflowVersion.count({ where: { workflowId: wfId } });
    expect(count).toBe(1);
  });

  it("(b)+(c) pinned execution runs the old snapshot after a live edit; new execution runs the new graph; rows carry workflowVersion", async () => {
    const user = await makeUser("b");
    setAuth(user);
    const wsId = await makeWorkspace(user);
    const { wfId, actionId } = await makeWorkflow(wsId, "v1-tag");
    const contact = await db.contact.create({
      data: { workspaceId: wsId, name: `Ver Contact ${suffix}`, tags: "[]" },
    });

    await publish(wfId, wsId);

    // Enqueue at v1 — do NOT drain yet.
    const first = await executeWorkflow({
      workflowId: wfId,
      workspaceId: wsId,
      event: { type: "new_message", contactId: contact.id, text: "hi" },
      idempotencyKey: `ver-pin-1-${suffix}`,
    });
    expect(first.duplicate).toBe(false);
    const exec1 = await db.workflowExecution.findUnique({ where: { id: first.executionId } });
    expect(exec1?.workflowVersion).toBe(1);

    // Edit the live graph and bump the version, then publish v2.
    await db.workflowNode.update({
      where: { id: actionId },
      data: { config: JSON.stringify({ tag: "v2-tag" }) },
    });
    await db.workflow.update({ where: { id: wfId }, data: { version: 2 } });
    await publish(wfId, wsId);
    const snap2 = await db.workflowVersion.findFirst({ where: { workflowId: wfId, version: 2 } });
    expect(snap2).not.toBeNull();

    // Now process the queued v1 job: it must follow the OLD snapshot.
    await drainQueue(processWorkflowJob);
    const exec1After = await db.workflowExecution.findUnique({ where: { id: first.executionId } });
    expect(exec1After?.status).toBe("SUCCEEDED");
    let updatedContact = await db.contact.findUnique({ where: { id: contact.id } });
    let tags = JSON.parse(updatedContact!.tags) as string[];
    expect(tags).toContain("v1-tag");
    expect(tags).not.toContain("v2-tag");

    // A new execution is pinned to v2 and follows the NEW graph.
    const second = await executeWorkflow({
      workflowId: wfId,
      workspaceId: wsId,
      event: { type: "new_message", contactId: contact.id, text: "hi again" },
      idempotencyKey: `ver-pin-2-${suffix}`,
    });
    const exec2 = await db.workflowExecution.findUnique({ where: { id: second.executionId } });
    expect(exec2?.workflowVersion).toBe(2);
    await drainQueue(processWorkflowJob);
    updatedContact = await db.contact.findUnique({ where: { id: contact.id } });
    tags = JSON.parse(updatedContact!.tags) as string[];
    expect(tags).toContain("v2-tag");
  });

  it("(c) versions API lists snapshots newest-first and blocks cross-workspace callers", async () => {
    const user = await makeUser("c");
    setAuth(user);
    const wsId = await makeWorkspace(user);
    const { wfId } = await makeWorkflow(wsId, "api-tag");

    await publish(wfId, wsId);
    await db.workflow.update({ where: { id: wfId }, data: { version: 2 } });
    await publish(wfId, wsId);

    const res = await versionsGET(versionsReq(wfId, wsId), { params: Promise.resolve({ id: wfId }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Array<{ version: number; createdBy: string | null; nodeCount: number; edgeCount: number; createdAt: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.map((v) => v.version)).toEqual([2, 1]);
    expect(body.data[0].nodeCount).toBe(2);
    expect(body.data[0].edgeCount).toBe(1);
    expect(body.data[0].createdBy).toBe(user.id);
    expect(body.data[0].createdAt).toBeTruthy();

    // Cross-workspace: another user with their own workspace asks for
    // this workflow's versions under their own workspace scope -> 404
    // (workflow not in their workspace), consistent with sibling reads.
    const other = await makeUser("other");
    const otherWsId = await makeWorkspace(other);
    setAuth(other);
    const crossRes = await versionsGET(versionsReq(wfId, otherWsId), {
      params: Promise.resolve({ id: wfId }),
    });
    expect([403, 404]).toContain(crossRes.status);
    expect(crossRes.status).toBe(404);

    // And selecting the owner's workspace directly -> 403 from
    // requireWorkspace (exists, but caller is not a member).
    const forbiddenRes = await versionsGET(versionsReq(wfId, wsId), {
      params: Promise.resolve({ id: wfId }),
    });
    expect(forbiddenRes.status).toBe(403);

    setAuth(user);
  });

  it("fallback: execution without a snapshot still runs the live graph", async () => {
    const user = await makeUser("fallback");
    setAuth(user);
    const wsId = await makeWorkspace(user);
    // Published directly in DB (no publish route -> no snapshot).
    const { wfId } = await makeWorkflow(wsId, "live-tag");
    await db.workflow.update({ where: { id: wfId }, data: { status: "PUBLISHED" } });
    const contact = await db.contact.create({
      data: { workspaceId: wsId, name: `Ver Fallback ${suffix}`, tags: "[]" },
    });
    const { executionId } = await executeWorkflow({
      workflowId: wfId,
      workspaceId: wsId,
      event: { type: "new_message", contactId: contact.id, text: "hi" },
      idempotencyKey: `ver-fallback-${suffix}`,
    });
    await drainQueue(processWorkflowJob);
    const exec = await db.workflowExecution.findUnique({ where: { id: executionId } });
    expect(exec?.status).toBe("SUCCEEDED");
    const updated = await db.contact.findUnique({ where: { id: contact.id } });
    expect(JSON.parse(updated!.tags) as string[]).toContain("live-tag");
  });
});
