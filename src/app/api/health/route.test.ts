/**
 * Health endpoint tests (Phase 4).
 * GET /api/health is a public probe: no auth, no secrets, returns
 * { ok, version, db, uptime }. DB is the fresh test.db, so db === "up".
 */
import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns 200 with ok, version, db status, and uptime", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.db).toBe("up");
    expect(typeof body.version).toBe("string");
    expect((body.version as string).length).toBeGreaterThan(0);
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime as number).toBeGreaterThanOrEqual(0);
  });

  it("exposes no secrets in the response", async () => {
    const res = await GET();
    const raw = await res.text();
    expect(raw).not.toMatch(/token|secret|password|credential/i);
  });
});
