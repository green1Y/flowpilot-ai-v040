/**
 * Batch C — atomic plan enforcement tests.
 *
 * Covers the transactional slot helpers (withWorkflowSlot / withSeatSlot /
 * withConnectedAccountSlot) and their route wiring:
 *
 *  - Concurrency: N parallel POST /api/workflows creates against K free
 *    defined-workflow slots → exactly K succeed (201), the rest get the
 *    honest 402 PLAN_LIMIT_EXCEEDED, and the final Workflow row count is
 *    exactly the plan limit. Same design for seats via POST /api/team
 *    and for connected accounts at the lib level (parallel
 *    withConnectedAccountSlot calls inserting distinct Integration rows).
 *  - WhatsApp manual connect route: sequential connects hit the
 *    connected-account cap with a 402, and reconnecting an already
 *    connected number stays exempt (no slot consumed).
 *  - Duplicate route consumes a defined-workflow slot too.
 *  - Downgrade safety: a workspace holding MORE workflows / members /
 *    accounts than a newly assigned lower plan allows keeps every row
 *    (GET endpoints still return them); only NEW creations return 402.
 *  - Billing API: assignment.source is "demo" for a demo workspace and
 *    "manual" otherwise (no payment provider exists).
 *
 * Provider HTTP is stubbed (the Meta module is mocked); this is mocked
 * verification only — nothing here is a live WhatsApp/Meta test.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  checkLimit,
  countConnectedAccounts,
  withConnectedAccountSlot,
} from "@/lib/billing/usage";
import { GET as workflowsGET, POST as workflowsPOST } from "@/app/api/workflows/route";
import { POST as duplicatePOST } from "@/app/api/workflows/[id]/duplicate/route";
import { GET as teamGET, POST as teamPOST } from "@/app/api/team/route";
import { GET as billingGET } from "@/app/api/billing/route";
import { POST as whatsappManualPOST } from "@/app/api/integrations/meta/whatsapp/manual/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/integrations/meta", () => {
  class MetaApiError extends Error {}
  return {
    MetaApiError,
    encryptCredentials: (creds: unknown) => `enc:${JSON.stringify(creds)}`,
    getPhoneNumberInfo: vi.fn(async (phoneNumberId: string) => ({
      id: phoneNumberId,
      display_phone_number: `+1 555 ${phoneNumberId.slice(-4)}`,
      verified_name: "Atomic Test Co",
    })),
  };
});
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Atomic Tester", email },
  } as any);
}

function req(url: string, workspaceId: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { "x-workspace-id": workspaceId, "content-type": "application/json" },
  });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

const suffix = `ac${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userSeq = 0;

async function mkUser(tag: string) {
  userSeq += 1;
  return db.user.create({
    data: {
      email: `ac-${tag}-${userSeq}-${suffix}@example.com`,
      name: `AC ${tag}`,
      passwordHash: "x",
    },
  });
}

async function mkWorkspace(
  tag: string,
  limits: { workflowLimit: number; seatLimit: number; connectedAccountLimit: number },
  opts?: { isDemo?: boolean }
) {
  const plan = await db.plan.create({
    data: {
      name: `AC Plan ${tag} ${suffix}`,
      monthlyMessageLimit: 100000,
      workflowLimit: limits.workflowLimit,
      seatLimit: limits.seatLimit,
      connectedAccountLimit: limits.connectedAccountLimit,
      features: "[]",
    },
  });
  const org = await db.organization.create({ data: { name: `AC Org ${tag} ${suffix}` } });
  const ws = await db.workspace.create({
    data: {
      orgId: org.id,
      name: `AC WS ${tag} ${suffix}`,
      slug: `ac-${tag}-${suffix}`,
      planId: plan.id,
      isDemo: opts?.isDemo ?? false,
    },
  });
  const owner = await mkUser(`${tag}-owner`);
  await db.membership.create({
    data: { userId: owner.id, workspaceId: ws.id, role: "OWNER" },
  });
  return { wsId: ws.id, planId: plan.id, owner };
}

beforeAll(() => {
  // Auth is stubbed per-test via authedAs(); a benign default so helpers
  // that resolve the session outside a test body never see a mock gap.
  authedAs("nobody", "nobody@example.com");
});

describe("workflow slots — concurrency via POST /api/workflows", () => {
  it("N parallel creates with K free slots → exactly K × 201, rest 402, final count == limit", async () => {
    const { wsId, owner } = await mkWorkspace("wconc", {
      workflowLimit: 3,
      seatLimit: 10,
      connectedAccountLimit: 10,
    });
    authedAs(owner.id, owner.email);

    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        workflowsPOST(
          req("http://x/api/workflows", wsId, {
            method: "POST",
            body: { name: `AC concurrent wf ${i}`, nodes: [], edges: [] },
          })
        ).then((r) => r.status)
      )
    );
    expect(results.filter((s) => s === 201)).toHaveLength(3);
    expect(results.filter((s) => s === 402)).toHaveLength(N - 3);
    expect(await db.workflow.count({ where: { workspaceId: wsId } })).toBe(3);

    // The rejection body carries the honest shape.
    const blocked = await jsonBody(
      await workflowsPOST(
        req("http://x/api/workflows", wsId, {
          method: "POST",
          body: { name: "AC one too many", nodes: [], edges: [] },
        })
      )
    );
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(blocked.body.used).toBe(3);
    expect(blocked.body.limit).toBe(3);
  });

  it("duplicate route consumes a defined-workflow slot", async () => {
    const { wsId, owner } = await mkWorkspace("wdup", {
      workflowLimit: 2,
      seatLimit: 10,
      connectedAccountLimit: 10,
    });
    authedAs(owner.id, owner.email);

    const created = await jsonBody(
      await workflowsPOST(
        req("http://x/api/workflows", wsId, {
          method: "POST",
          body: { name: "AC original", nodes: [], edges: [] },
        })
      )
    );
    expect(created.status).toBe(201);
    const originalId = created.body.data.id;

    const dup = (id: string) =>
      duplicatePOST(req(`http://x/api/workflows/${id}/duplicate`, wsId, { method: "POST" }), {
        params: { id },
      } as any);

    const first = await dup(originalId);
    expect(first.status).toBe(201);
    expect(await db.workflow.count({ where: { workspaceId: wsId } })).toBe(2);

    const second = await jsonBody(await dup(originalId));
    expect(second.status).toBe(402);
    expect(second.body.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(await db.workflow.count({ where: { workspaceId: wsId } })).toBe(2);
  });
});

describe("seat slots — concurrency via POST /api/team", () => {
  it("parallel invites race for the remaining seats: exactly the free seats succeed", async () => {
    // seatLimit 3, owner already occupies 1 → exactly 2 free seats.
    const { wsId, owner } = await mkWorkspace("sconc", {
      workflowLimit: 10,
      seatLimit: 3,
      connectedAccountLimit: 10,
    });
    authedAs(owner.id, owner.email);

    const invitees = await Promise.all(
      Array.from({ length: 5 }, (_, i) => mkUser(`sconc-invitee-${i}`))
    );
    const results = await Promise.all(
      invitees.map((u) =>
        teamPOST(
          req("http://x/api/team", wsId, {
            method: "POST",
            body: { email: u.email, role: "AGENT" },
          })
        ).then((r) => r.status)
      )
    );
    expect(results.filter((s) => s === 201)).toHaveLength(2);
    expect(results.filter((s) => s === 402)).toHaveLength(3);
    expect(await db.membership.count({ where: { workspaceId: wsId } })).toBe(3);
  });

  it("sequential invite past the cap returns the honest 402 shape", async () => {
    const { wsId, owner } = await mkWorkspace("sfull", {
      workflowLimit: 10,
      seatLimit: 1, // owner alone fills the plan
      connectedAccountLimit: 10,
    });
    authedAs(owner.id, owner.email);
    const invitee = await mkUser("sfull-invitee");
    const res = await jsonBody(
      await teamPOST(
        req("http://x/api/team", wsId, {
          method: "POST",
          body: { email: invitee.email, role: "AGENT" },
        })
      )
    );
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(res.body.used).toBe(1);
    expect(res.body.limit).toBe(1);
  });
});

describe("connected-account slots — lib-level concurrency", () => {
  it("parallel withConnectedAccountSlot calls inserting distinct accounts stop exactly at the limit", async () => {
    const { wsId } = await mkWorkspace("aconc", {
      workflowLimit: 10,
      seatLimit: 10,
      connectedAccountLimit: 3,
    });

    const N = 8;
    const outcomes = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const extId = `ac-ext-${i}-${suffix}`;
        return withConnectedAccountSlot(
          wsId,
          { provider: "whatsapp", externalAccountId: extId },
          async (tx) => {
            const raced = await tx.integration.findFirst({
              where: { workspaceId: wsId, provider: "whatsapp", externalAccountId: extId },
            });
            if (raced) return raced;
            return tx.integration.create({
              data: {
                workspaceId: wsId,
                provider: "whatsapp",
                status: "CONNECTED",
                externalAccountId: extId,
                accountName: `WA ${i}`,
                verifiedAt: new Date(),
              },
            });
          }
        ).then(
          () => "ok" as const,
          (e: unknown) => e
        );
      })
    );
    const okCount = outcomes.filter((o) => o === "ok").length;
    const rejected = outcomes.filter((o) => o instanceof Response) as Response[];
    expect(okCount).toBe(3);
    expect(rejected).toHaveLength(N - 3);
    for (const r of rejected) {
      expect(r.status).toBe(402);
      const payload = await r.clone().json();
      expect(payload.code).toBe("PLAN_LIMIT_EXCEEDED");
      expect(payload.limit).toBe(3);
    }
    expect(await countConnectedAccounts(wsId)).toBe(3);
  });

  it("an existing account's reconnect consumes no slot even at the cap", async () => {
    const { wsId } = await mkWorkspace("arecon", {
      workflowLimit: 10,
      seatLimit: 10,
      connectedAccountLimit: 1,
    });
    const extId = `ac-recon-${suffix}`;
    const first = await withConnectedAccountSlot(
      wsId,
      { provider: "whatsapp", externalAccountId: extId },
      async (tx) =>
        tx.integration.create({
          data: {
            workspaceId: wsId,
            provider: "whatsapp",
            status: "CONNECTED",
            externalAccountId: extId,
            accountName: "Original",
            verifiedAt: new Date(),
          },
        })
    );
    expect(await countConnectedAccounts(wsId)).toBe(1);

    // Workspace is AT the cap — reconnecting the same account must pass.
    const again = await withConnectedAccountSlot(
      wsId,
      { provider: "whatsapp", externalAccountId: extId },
      async (tx) => {
        const raced = await tx.integration.findFirst({
          where: { workspaceId: wsId, provider: "whatsapp", externalAccountId: extId },
        });
        if (raced) {
          return tx.integration.update({
            where: { id: raced.id },
            data: { accountName: "Rotated token" },
          });
        }
        return tx.integration.create({
          data: { workspaceId: wsId, provider: "whatsapp", externalAccountId: extId },
        });
      }
    );
    expect(again.id).toBe(first.id);
    expect(again.accountName).toBe("Rotated token");
    expect(await countConnectedAccounts(wsId)).toBe(1);
  });
});

describe("WhatsApp manual connect route — cap + reconnect exemption (mocked provider)", () => {
  it("second distinct number at cap 1 → 402; reconnecting the first number still succeeds", async () => {
    const { wsId, owner } = await mkWorkspace("waman", {
      workflowLimit: 10,
      seatLimit: 10,
      connectedAccountLimit: 1,
    });
    authedAs(owner.id, owner.email);

    const connect = (phoneNumberId: string) =>
      whatsappManualPOST(
        req("http://x/api/integrations/meta/whatsapp/manual", wsId, {
          method: "POST",
          body: { phoneNumberId, accessToken: "fake-token" },
        })
      );

    const first = await jsonBody(await connect("111000111"));
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe("CONNECTED");

    const second = await jsonBody(await connect("222000222"));
    expect(second.status).toBe(402);
    expect(second.body.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(await countConnectedAccounts(wsId)).toBe(1);

    // Reconnect of the SAME number: exempt from the cap.
    const recon = await jsonBody(await connect("111000111"));
    expect(recon.status).toBe(200);
    expect(await countConnectedAccounts(wsId)).toBe(1);
  });
});

describe("downgrade safety — over-limit workspaces keep everything", () => {
  it("rows survive a downgrade and stay readable; only new creations block", async () => {
    const high = { workflowLimit: 10, seatLimit: 10, connectedAccountLimit: 10 };
    const { wsId, owner } = await mkWorkspace("down", high);
    authedAs(owner.id, owner.email);

    // Build up state ABOVE the low plan's limits (direct rows — this is
    // pre-existing data, e.g. created while on the higher plan).
    for (let i = 0; i < 4; i++) {
      await db.workflow.create({ data: { workspaceId: wsId, name: `AC legacy wf ${i}` } });
    }
    for (let i = 0; i < 3; i++) {
      const u = await mkUser(`down-member-${i}`);
      await db.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "AGENT" } });
    }
    for (let i = 0; i < 4; i++) {
      await db.integration.create({
        data: {
          workspaceId: wsId,
          provider: "whatsapp",
          status: "CONNECTED",
          externalAccountId: `ac-down-${i}-${suffix}`,
          verifiedAt: new Date(),
        },
      });
    }
    // 4 workflows, 4 memberships (owner + 3), 4 accounts.

    // Downgrade: limits now 2 across the board.
    const lowPlan = await db.plan.create({
      data: {
        name: `AC Plan down-low ${suffix}`,
        monthlyMessageLimit: 100000,
        workflowLimit: 2,
        seatLimit: 2,
        connectedAccountLimit: 2,
        features: "[]",
      },
    });
    await db.workspace.update({ where: { id: wsId }, data: { planId: lowPlan.id } });

    // Everything still exists and is returned by the GET endpoints.
    const wfList = await jsonBody(await workflowsGET(req("http://x/api/workflows", wsId)));
    expect(wfList.status).toBe(200);
    expect(wfList.body.data).toHaveLength(4);
    const team = await jsonBody(await teamGET(req("http://x/api/team", wsId)));
    expect(team.status).toBe(200);
    expect(team.body.data.members).toHaveLength(4);
    expect(await countConnectedAccounts(wsId)).toBe(4);
    expect(await db.workflow.count({ where: { workspaceId: wsId } })).toBe(4);

    const wfCheck = await checkLimit(wsId, "workflows");
    expect(wfCheck).toMatchObject({ allowed: false, used: 4, limit: 2 });

    // Only NEW creations block.
    const newWf = await jsonBody(
      await workflowsPOST(
        req("http://x/api/workflows", wsId, {
          method: "POST",
          body: { name: "AC post-downgrade wf", nodes: [], edges: [] },
        })
      )
    );
    expect(newWf.status).toBe(402);

    const invitee = await mkUser("down-invitee");
    const newSeat = await jsonBody(
      await teamPOST(
        req("http://x/api/team", wsId, {
          method: "POST",
          body: { email: invitee.email, role: "AGENT" },
        })
      )
    );
    expect(newSeat.status).toBe(402);

    let thrown: unknown = null;
    try {
      await withConnectedAccountSlot(
        wsId,
        { provider: "whatsapp", externalAccountId: `ac-down-new-${suffix}` },
        async (tx) =>
          tx.integration.create({
            data: {
              workspaceId: wsId,
              provider: "whatsapp",
              status: "CONNECTED",
              externalAccountId: `ac-down-new-${suffix}`,
            },
          })
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(402);

    // Counts unchanged after all three blocked creations.
    expect(await db.workflow.count({ where: { workspaceId: wsId } })).toBe(4);
    expect(await db.membership.count({ where: { workspaceId: wsId } })).toBe(4);
    expect(await countConnectedAccounts(wsId)).toBe(4);
  });
});

describe("billing assignment source", () => {
  it("demo workspace → source 'demo'; regular workspace → 'manual'", async () => {
    const demo = await mkWorkspace(
      "bdemo",
      { workflowLimit: 5, seatLimit: 5, connectedAccountLimit: 5 },
      { isDemo: true }
    );
    authedAs(demo.owner.id, demo.owner.email);
    const demoRes = await jsonBody(await billingGET(req("http://x/api/billing", demo.wsId)));
    expect(demoRes.status).toBe(200);
    expect(demoRes.body.data.assignment.source).toBe("demo");
    expect(demoRes.body.data.plan.workflowLimitMeaning).toBe("defined_workflows");

    const plain = await mkWorkspace("bplain", {
      workflowLimit: 5,
      seatLimit: 5,
      connectedAccountLimit: 5,
    });
    authedAs(plain.owner.id, plain.owner.email);
    const plainRes = await jsonBody(await billingGET(req("http://x/api/billing", plain.wsId)));
    expect(plainRes.status).toBe(200);
    expect(plainRes.body.data.assignment.source).toBe("manual");
  });
});
