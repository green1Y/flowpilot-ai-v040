/**
 * Email sender tests (Workstream A).
 * - getEmailSender(): null when unconfigured (honest state), sender when set.
 * - Resend adapter: correct endpoint/auth/body, timeout errors surface.
 * - sendGuardedEmail(): 503 EMAIL_NOT_CONFIGURED when unconfigured;
 *   403 when the workspace is a demo workspace; sends otherwise.
 * - assertEmailSendAllowedForUser(): enforces the guard across memberships,
 *   and the global DEMO_MODE check even with no memberships.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db } from "@/lib/db";
import { getEmailSender } from "./sender";
import { ResendEmailSender } from "./resend";
import { sendGuardedEmail, assertEmailSendAllowedForUser } from "./send";

const OLD_ENV = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
};

function setEmailEnv(configured: boolean) {
  if (configured) {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "FlowPilot <noreply@example.com>";
  } else {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  }
}

afterEach(() => {
  if (OLD_ENV.RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = OLD_ENV.RESEND_API_KEY;
  if (OLD_ENV.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = OLD_ENV.EMAIL_FROM;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function catchResponse(p: Promise<unknown>): Promise<Response> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Response);
    return e as Response;
  }
  throw new Error("expected a thrown Response");
}

describe("getEmailSender", () => {
  it("returns null when RESEND_API_KEY is unset", () => {
    setEmailEnv(false);
    expect(getEmailSender()).toBeNull();
  });

  it("returns null when EMAIL_FROM is unset", () => {
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.EMAIL_FROM;
    expect(getEmailSender()).toBeNull();
  });

  it("returns a sender when both are set", () => {
    setEmailEnv(true);
    expect(getEmailSender()).not.toBeNull();
  });
});

describe("ResendEmailSender", () => {
  it("POSTs to the Resend API with bearer auth and the from/to/subject/html body", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ id: "msg_123" }, { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const sender = new ResendEmailSender("re_test_key", "FlowPilot <noreply@example.com>");
    const result = await sender.send("user@example.com", "Subject", "<p>Hi</p>");

    expect(result).toEqual({ ok: true, messageId: "msg_123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer re_test_key"
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: "FlowPilot <noreply@example.com>",
      to: ["user@example.com"],
      subject: "Subject",
      html: "<p>Hi</p>",
    });
  });

  it("throws a descriptive error on provider failure (never a fake success)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad key", { status: 401 }))
    );
    const sender = new ResendEmailSender("bad", "x@y.z");
    await expect(sender.send("a@b.c", "s", "h")).rejects.toThrow(
      /Resend send failed \(HTTP 401\)/
    );
  });

  it("throws on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hangup");
      })
    );
    const sender = new ResendEmailSender("k", "x@y.z");
    await expect(sender.send("a@b.c", "s", "h")).rejects.toThrow(
      /Resend request failed/
    );
  });
});

describe("sendGuardedEmail", () => {
  beforeEach(() => setEmailEnv(false));

  it("throws an honest 503 EMAIL_NOT_CONFIGURED when unconfigured", async () => {
    const res = await catchResponse(
      sendGuardedEmail("any-workspace", "a@b.c", "s", "h")
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: "Email not configured",
      code: "EMAIL_NOT_CONFIGURED",
    });
  });

  it("throws 403 for a demo workspace even when configured (guard runs BEFORE send)", async () => {
    setEmailEnv(true);
    const fetchMock = vi.fn(async () => Response.json({ id: "x" }));
    vi.stubGlobal("fetch", fetchMock);

    const org = await db.organization.create({ data: { name: "Email Demo Org" } });
    const ws = await db.workspace.create({
      data: { orgId: org.id, name: "Email Demo WS", slug: `email-demo-${Date.now()}`, isDemo: true },
    });
    try {
      const res = await catchResponse(
        sendGuardedEmail(ws.id, "a@b.c", "s", "h")
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: "DEMO_WORKSPACE_SEND_BLOCKED",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await db.workspace.delete({ where: { id: ws.id } });
      await db.organization.delete({ where: { id: org.id } });
    }
  });

  it("sends when configured and the workspace is not a demo workspace", async () => {
    setEmailEnv(true);
    const fetchMock = vi.fn(async () => Response.json({ id: "msg_ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const org = await db.organization.create({ data: { name: "Email Live Org" } });
    const ws = await db.workspace.create({
      data: { orgId: org.id, name: "Email Live WS", slug: `email-live-${Date.now()}` },
    });
    try {
      const result = await sendGuardedEmail(ws.id, "a@b.c", "s", "h");
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await db.workspace.delete({ where: { id: ws.id } });
      await db.organization.delete({ where: { id: org.id } });
    }
  });
});

describe("assertEmailSendAllowedForUser", () => {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  it("passes for a user with no memberships when DEMO_MODE is off", async () => {
    const user = await db.user.create({
      data: { email: `noguard-${suffix}@example.com`, name: "No Guard", passwordHash: "x" },
    });
    try {
      await expect(assertEmailSendAllowedForUser(user.id)).resolves.toBeUndefined();
    } finally {
      await db.user.delete({ where: { id: user.id } });
    }
  });

  it("throws 403 when any of the user's workspaces is a demo workspace", async () => {
    const user = await db.user.create({
      data: { email: `demoguard-${suffix}@example.com`, name: "Demo Guard", passwordHash: "x" },
    });
    const org = await db.organization.create({ data: { name: `Demo Guard Org ${suffix}` } });
    const ws = await db.workspace.create({
      data: { orgId: org.id, name: `Demo Guard WS ${suffix}`, slug: `demo-guard-${suffix}`, isDemo: true },
    });
    await db.membership.create({ data: { userId: user.id, workspaceId: ws.id, role: "OWNER" } });
    try {
      const res = await catchResponse(assertEmailSendAllowedForUser(user.id));
      expect(res.status).toBe(403);
    } finally {
      await db.membership.deleteMany({ where: { userId: user.id } });
      await db.workspace.delete({ where: { id: ws.id } });
      await db.organization.delete({ where: { id: org.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
});
