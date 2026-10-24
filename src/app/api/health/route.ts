import { db } from "@/lib/db";
import pkg from "../../../../package.json";

const version: string = pkg.version;

/**
 * GET /api/health — public liveness/readiness probe (Phase 4).
 *
 * Returns { ok, version, db, uptime }.
 * - `db`: "up" when a trivial SELECT 1 succeeds, "down" otherwise (ok=false then).
 * - No authentication (standard for load-balancer probes), no secrets in the response.
 * - Never include credentials, tokens, or internal paths here.
 */
export async function GET() {
  let dbStatus: "up" | "down" = "up";
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = "down";
  }
  const ok = dbStatus === "up";
  return Response.json(
    {
      ok,
      version,
      db: dbStatus,
      uptime: Math.floor(process.uptime()),
    },
    { status: ok ? 200 : 503 }
  );
}
