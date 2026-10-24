/**
 * Wave 2A (D6) — health probes (stubbed HTTP only, no real Meta traffic).
 *
 * Proves, with a stubbed fetch layer:
 *  - an Instagram Business-Login row gets token OK + identity OK (IG user)
 *    + webhook OK (subscribed_apps read returns apps), one HealthCheck row
 *    per probe, and no credential material in any stored detail;
 *  - a facebook/whatsapp row gets webhook BLOCKED (dashboard-side, manual),
 *    never a faked pass;
 *  - a simulated provider (telegram) gets SIMULATED for every probe.
 *
 * DB is the fresh test.db per run; rows are cleaned up per test.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import { encryptCredentials } from "./meta";
import { runHealthProbes } from "./health";

process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-app-secret";
process.env.META_VERIFY_TOKEN = "test-verify-token";
process.env.APP_PUBLIC_URL = "https://example.test";

const suffix = `hp${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsId = "";

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

/** Stub fetch: IG identity + subscribed_apps reads; page verify fallback. */
function stubMetaFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/subscribed_apps")) {
        return jsonRes({ data: [{ id: "app-1" }] });
      }
      if (u.pathname.endsWith("/me")) {
        return jsonRes({ id: `ig-${suffix}`, username: "biz_account" });
      }
      // Page verify: /v21.0/{pageId}?fields=id,name
      return jsonRes({ id: `page-${suffix}`, name: "Test Page" });
    })
  );
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `Health Org ${suffix}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `Health WS ${suffix}`, slug: `hp-${suffix}` },
  });
  wsId = ws.id;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.healthCheck.deleteMany({ where: { workspaceId: wsId } });
  await db.integration.deleteMany({ where: { workspaceId: wsId } });
});

async function rowsFor(integrationId: string) {
  return db.healthCheck.findMany({
    where: { workspaceId: wsId, integrationId },
    orderBy: { createdAt: "asc" },
  });
}

describe("runHealthProbes", () => {
  it("instagram Business Login: token + identity + webhook OK, one row per probe, no secrets stored", async () => {
    stubMetaFetch();
    const secretToken = `ig-secret-token-${suffix}`;
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "instagram",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "instagram",
          loginType: "instagram_login",
          accessToken: secretToken,
          expiresAt: null,
          igUserId: `ig-${suffix}`,
          igUsername: "biz_account",
        }),
      },
    });
    const run = await runHealthProbes(row.id);
    expect(run.simulated).toBe(false);
    expect(run.probes.map((p) => p.probe)).toEqual(["token", "identity", "webhook"]);
    expect(run.probes.map((p) => p.status)).toEqual(["OK", "OK", "OK"]);

    const stored = await rowsFor(row.id);
    expect(stored).toHaveLength(3);
    for (const r of stored) {
      expect(r.detail).not.toContain(secretToken);
      expect(r.detail).not.toContain("access_token");
    }
    const identity = stored.find((r) => r.probe === "identity")!;
    expect(identity.detail).toContain("biz_account");
  });

  it("facebook: webhook probe is BLOCKED (dashboard-side, manual), never faked", async () => {
    stubMetaFetch();
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "facebook",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "facebook",
          accessToken: `fb-token-${suffix}`,
          expiresAt: null,
          pageId: `page-${suffix}`,
          pageAccessToken: `page-token-${suffix}`,
        }),
      },
    });
    const run = await runHealthProbes(row.id);
    const webhook = run.probes.find((p) => p.probe === "webhook")!;
    expect(webhook.status).toBe("BLOCKED");
    expect(String(webhook.detail.reason)).toMatch(/dashboard/i);
    expect(run.probes.find((p) => p.probe === "identity")!.status).toBe("OK");
    expect((await rowsFor(row.id)).length).toBe(3);
  });

  it("simulated providers return SIMULATED for every probe, never a live pass", async () => {
    const row = await db.integration.create({
      data: { workspaceId: wsId, provider: "telegram", status: "DEMO" },
    });
    const run = await runHealthProbes(row.id);
    expect(run.simulated).toBe(true);
    expect(run.probes.every((p) => p.status === "SIMULATED")).toBe(true);
    expect((await rowsFor(row.id)).length).toBe(3);
  });

  it("throws for an unknown integration id", async () => {
    await expect(runHealthProbes("missing-id")).rejects.toThrow(/not found/i);
  });
});
