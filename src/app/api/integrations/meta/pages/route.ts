import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { metaPagesQuerySchema } from "@/lib/validation";
import {
  decryptCredentials,
  encryptCredentials,
  getValidAccessToken,
  getPages,
  getInstagramAccount,
  MetaApiError,
  MetaTokenExpiredError,
} from "@/lib/integrations/meta";

/**
 * GET /api/integrations/meta/pages?provider=instagram|facebook
 * Returns: { pages: [{ id, name, hasInstagram }] }
 *
 * Lists the Facebook Pages the connected Meta user manages. For the
 * `instagram` provider each page is also checked for a linked Instagram
 * Professional account (best-effort; per-page failures → hasInstagram=false).
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");

  const parsed = metaPagesQuerySchema.safeParse({
    provider: new URL(req.url).searchParams.get("provider") ?? undefined,
  });
  const provider = parsed.success ? parsed.data.provider : undefined;
  if (provider !== "instagram" && provider !== "facebook") {
    throw err("Query param 'provider' must be instagram or facebook", 422);
  }

  const row = await db.integration.findFirst({
    where: { workspaceId: ctx.workspaceId, provider },
  });
  if (!row || !row.encryptedCredentials) {
    throw err("Complete the Meta authorization step first", 404);
  }

  let creds;
  try {
    creds = decryptCredentials(row.encryptedCredentials);
  } catch {
    throw err("Stored Meta credentials are invalid — please reconnect", 422);
  }

  // Use a fresh token when the stored one is near/past expiry, and persist it.
  let token = creds.accessToken;
  try {
    const valid = await getValidAccessToken(creds);
    token = valid.token;
    if (valid.refreshed) {
      creds = {
        ...creds,
        accessToken: valid.token,
        expiresAt: valid.newExpiresAt,
      };
      await db.integration.update({
        where: { id: row.id },
        data: { encryptedCredentials: encryptCredentials(creds) },
      });
    }
  } catch (e) {
    if (e instanceof MetaTokenExpiredError) {
      throw err("Token expired — please reconnect", 401);
    }
    if (e instanceof MetaApiError) throw err(e.message, 422);
    throw err("Failed to refresh the Meta token", 500);
  }

  let pages;
  try {
    pages = await getPages(token);
  } catch (e) {
    if (e instanceof MetaTokenExpiredError) {
      throw err("Token expired — please reconnect", 401);
    }
    if (e instanceof MetaApiError) throw err(e.message, 422);
    throw err("Failed to list Meta pages", 500);
  }

  const out: Array<{ id: string; name: string; hasInstagram: boolean }> = [];
  for (const p of pages) {
    let hasInstagram = false;
    if (provider === "instagram") {
      try {
        const ig = await getInstagramAccount(p.id, p.access_token ?? token);
        hasInstagram = ig !== null;
      } catch {
        // Best-effort: a page that fails the check is reported as unlinked.
        hasInstagram = false;
      }
    }
    out.push({ id: p.id, name: p.name, hasInstagram });
  }

  return ok({ pages: out });
});
