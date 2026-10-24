/**
 * GET /api/email/health tests (Wave 2E).
 * - Unconfigured (key or sender unset) → configured:false + code, no fetch.
 * - 2xx domains response → configured:true + domainsCount + OK HealthCheck row.
 * - Non-2xx or network failure → reachable:false + sanitized error +
 *   FAILED HealthCheck row.
 * - The API key never appears in any response body or HealthCheck detail.
 * Tenancy is mocked (MANAGER ctx); HealthCheck rows use the real DB.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/tenancy";
import { GET } from "./route";

vi.mock("@/lib/tenancy", () => ({
  requireWorkspace: vi.fn(),
  requireRole: vi.fn(),
}));

const mockedRequireWorkspace = vi.mocked(requireWorkspace);
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const OLD_ENV = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
};

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let wsId = "";
let orgId = "";

async function fixture() {
  if (wsId) return;
  const org = await db.organization.create({
    data: { name: `Email Health Org ${suffix}` },
  });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `Email Health WS ${suffix}`, slug: `email-health-ws-${suffix}` },
  });
  orgId = org.id;
  wsId = ws.id;
}

function req(): NextRequest {
  return new NextRequest("http://localhost/api/email/health", { method: "GET" });
}

function setEmailEnv(configured: boolean) {
  if (configured) {
    process.env.RESEND_API_KEY = "re_test_key_123";
    process.env.EMAIL_FROM = "FlowPilot <noreply@example.com>";
  } else {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  }
}

beforeEach(async () => {
  await fixture();
  mockedRequireWorkspace.mockResolvedValue({
    userId: "u_1",
    workspaceId: wsId,
    role: "MANAGER",
  } as never);
  vi.clearAllMocks();
});

afterEach(() => {
  if (OLD_ENV.RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = OLD_ENV.RESEND_API_KEY;
  if (OLD_ENV.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = OLD_ENV.EMAIL_FROM;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.healthCheck.deleteMany({ where: { workspaceId: wsId } });
  await db.membership.deleteMany({ where: { workspaceId: wsId } });
  await db.workspace.deleteMany({ where: { id: wsId } });
  await db.organization.deleteMany({ where: { id: orgId } });
});

describe("GET /api/email/health", () => {
  it("reports unconfigured without probing when the key is unset", async () => {
    setEmailEnv(false);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { configured: false, code: "EMAIL_NOT_CONFIGURED" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports domainsCount and writes an OK HealthCheck row on 2xx", async () => {
    setEmailEnv(true);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "d1" }, { id: "d2" }] }),
    });
    const res = await GET(req());
    expect(await res.json()).toMatchObject({
      data: { configured: true, reachable: true, domainsCount: 2 },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/domains");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test_key_123"
    );
    const row = await db.healthCheck.findFirst({
      where: { workspaceId: wsId, integrationId: "email", probe: "config" },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.status).toBe("OK");
    expect(row?.detail).toContain("domainsCount");
    expect(row?.detail).not.toContain("re_test_key_123");
  });

  it("reports reachable:false with a FAILED row on a provider error", async () => {
    setEmailEnv(true);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: "Invalid API key" }),
    });
    const res = await GET(req());
    const body = await res.json();
    expect(body.data).toMatchObject({ configured: true, reachable: false });
    expect(body.data.error).toContain("Invalid API key");
    expect(JSON.stringify(body)).not.toContain("re_test_key_123");
    const row = await db.healthCheck.findFirst({
      where: { workspaceId: wsId, integrationId: "email", probe: "config" },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.status).toBe("FAILED");
  });

  it("reports reachable:false with a FAILED row when fetch throws", async () => {
    setEmailEnv(true);
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const res = await GET(req());
    expect(await res.json()).toMatchObject({
      data: { configured: true, reachable: false },
    });
    const row = await db.healthCheck.findFirst({
      where: { workspaceId: wsId, integrationId: "email", probe: "config" },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.status).toBe("FAILED");
  });
});
