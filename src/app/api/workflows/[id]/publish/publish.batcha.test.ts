/**
 * Publish gate tests (Batch A item 7).
 *
 * The publish API now runs the builder readiness report server-side:
 *  - a cyclic graph is rejected with 422 (previously publishable via API),
 *  - a disabled node's invalid config no longer blocks publishing
 *    (disabled nodes skip config validation, matching validateWorkflow),
 *  - a valid acyclic workflow still publishes (control).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `pub${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsId = "";
let seq = 0;

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "x-workspace-id": wsId },
  });
}

interface N {
  key: string;
  kind: string;
  type: string;
  config?: Record<string, unknown>;
  disabled?: boolean;
}

async function makeWorkflow(nodes: N[], edges: [string, string][]): Promise<string> {
  seq += 1;
  const p = `p${seq}`;
  const idOf = (k: string) => `${p}-${k}-${suffix}`;
  const wf = await db.workflow.create({
    data: {
      workspaceId: wsId,
      name: `Publish WF ${seq} ${suffix}`,
      status: "DRAFT",
      nodes: {
        create: nodes.map((n) => ({
          id: idOf(n.key),
          kind: n.kind,
          type: n.type,
          label: n.type,
          config: JSON.stringify(n.config ?? {}),
          position: JSON.stringify({ x: 0, y: 0 }),
          disabled: n.disabled ?? false,
        })),
      },
      edges: {
        create: edges.map(([s, t], i) => ({
          id: `${p}-e${i}-${suffix}`,
          sourceId: idOf(s),
          targetId: idOf(t),
          label: "",
          condition: "{}",
        })),
      },
    },
  });
  return wf.id;
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `pub-${suffix}@example.com`, name: "Pub", passwordHash: "x" },
  });
  const org = await db.organization.create({ data: { name: `Pub Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `Pub WS ${suffix}`, slug: `pub-${suffix}` },
  });
  wsId = w.id;
  await db.membership.create({ data: { userId: user.id, workspaceId: w.id, role: "OWNER" } });
  mockedRequireUser.mockResolvedValue({
    userId: user.id,
    email: user.email,
    user: { id: user.id, name: "Pub", email: user.email },
  } as any);
});

describe("publish gate", () => {
  it("rejects a cyclic graph with 422 and leaves it DRAFT", async () => {
    const wfId = await makeWorkflow(
      [
        { key: "t", kind: "trigger", type: "trigger.new_message" },
        { key: "a", kind: "action", type: "action.add_tag", config: { tag: "x" } },
        { key: "b", kind: "action", type: "action.add_tag", config: { tag: "y" } },
      ],
      [
        ["t", "a"],
        ["a", "b"],
        ["b", "a"], // cycle a ↔ b
      ]
    );
    const res = await POST(req(`/api/workflows/${wfId}/publish`), {
      params: Promise.resolve({ id: wfId }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    const messages = JSON.stringify(body);
    expect(messages.toLowerCase()).toContain("cycle");
    const wf = await db.workflow.findUnique({ where: { id: wfId } });
    expect(wf!.status).toBe("DRAFT");
  });

  it("publishes a valid acyclic workflow (control)", async () => {
    const wfId = await makeWorkflow(
      [
        { key: "t", kind: "trigger", type: "trigger.new_message" },
        { key: "a", kind: "action", type: "action.add_tag", config: { tag: "x" } },
      ],
      [["t", "a"]]
    );
    const res = await POST(req(`/api/workflows/${wfId}/publish`), {
      params: Promise.resolve({ id: wfId }),
    });
    expect(res.status).toBe(200);
    const wf = await db.workflow.findUnique({ where: { id: wfId } });
    expect(wf!.status).toBe("PUBLISHED");
  });

  it("does not let a disabled node's invalid config block publishing", async () => {
    const wfId = await makeWorkflow(
      [
        { key: "t", kind: "trigger", type: "trigger.new_message" },
        // action.add_tag requires a non-empty tag — invalid config, but the
        // node is disabled so it never runs and must not block the publish.
        { key: "a", kind: "action", type: "action.add_tag", config: {}, disabled: true },
        { key: "e", kind: "flow", type: "flow.end" },
      ],
      [
        ["t", "a"],
        ["a", "e"],
      ]
    );
    const res = await POST(req(`/api/workflows/${wfId}/publish`), {
      params: Promise.resolve({ id: wfId }),
    });
    expect(res.status).toBe(200);
    const wf = await db.workflow.findUnique({ where: { id: wfId } });
    expect(wf!.status).toBe("PUBLISHED");
  });
});
