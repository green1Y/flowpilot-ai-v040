import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { metaSelectSchema } from "@/lib/validation";
import {
  decryptCredentials,
  encryptCredentials,
  getValidAccessToken,
  getPageToken,
  verifyPage,
  getInstagramAccount,
  MetaApiError,
  MetaTokenExpiredError,
} from "@/lib/integrations/meta";
import {
  findAccountRow,
  ensureDefaultAccount,
} from "@/lib/integrations/accounts";
import { withConnectedAccountSlot } from "@/lib/billing/usage";

/**
 * POST /api/integrations/meta/select
 * Body: { provider: "instagram" | "facebook", pageId }
 *
 * Binds the authorized Meta user token to one Facebook Page: fetches the
 * page access token, verifies it, and (for instagram) requires a linked
 * Instagram Professional account. Marks the integration CONNECTED.
 * Returns: { status: "CONNECTED", accountName, accountId }
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, metaSelectSchema);

  // The pending authorization lives on the placeholder row
  // (externalAccountId = null) staged by the Meta callback; fall back to
  // any existing row for this provider (legacy single-row workspaces).
  // This row only lends its user token — the picked Page's credentials
  // are written to the Page's own account row below, so a previously
  // connected DIFFERENT Page is never overwritten here.
  const row =
    (await findAccountRow(ctx.workspaceId, body.provider, null)) ??
    (await db.integration.findFirst({
      where: { workspaceId: ctx.workspaceId, provider: body.provider },
    }));
  if (!row || !row.encryptedCredentials) {
    throw err("Complete the Meta authorization step first", 404);
  }

  let creds;
  try {
    creds = decryptCredentials(row.encryptedCredentials);
  } catch {
    throw err("Stored Meta credentials are invalid — please reconnect", 422);
  }

  // Instagram Business Login has no Page-selection step — the IG account is
  // already bound and verified at callback time. Reject Page selection for it.
  if (body.provider === "instagram" && creds.loginType === "instagram_login") {
    throw err(
      "This Instagram account uses Business Login — no Page selection is needed",
      422
    );
  }

  let userToken = creds.accessToken;
  try {
    const valid = await getValidAccessToken(creds);
    userToken = valid.token;
    if (valid.refreshed) {
      creds = {
        ...creds,
        accessToken: valid.token,
        expiresAt: valid.newExpiresAt,
      };
    }
  } catch (e) {
    if (e instanceof MetaTokenExpiredError) {
      throw err("Token expired — please reconnect", 401);
    }
    if (e instanceof MetaApiError) throw err(e.message, 422);
    throw err("Failed to refresh the Meta token", 500);
  }

  let page: { access_token: string; name: string };
  try {
    page = await getPageToken(body.pageId, userToken);
  } catch (e) {
    if (e instanceof MetaTokenExpiredError) {
      throw err("Token expired — please reconnect", 401);
    }
    if (e instanceof MetaApiError) throw err(e.message, 422);
    throw err("Failed to fetch the page token", 500);
  }

  try {
    await verifyPage(body.pageId, page.access_token);
  } catch (e) {
    if (e instanceof MetaTokenExpiredError) {
      throw err("Token expired — please reconnect", 401);
    }
    if (e instanceof MetaApiError) throw err(e.message, 422);
    throw err("Page verification failed", 500);
  }

  let ig: { id: string; username: string } | null = null;
  if (body.provider === "instagram") {
    try {
      ig = await getInstagramAccount(body.pageId, page.access_token);
    } catch (e) {
      if (e instanceof MetaApiError) throw err(e.message, 422);
      throw err("Failed to check the linked Instagram account", 500);
    }
    if (!ig) {
      throw err(
        "No Instagram Professional account is linked to this Facebook Page",
        422
      );
    }
  }

  // Plan limit (Batch C) is enforced transactionally around the account
  // insert below — all provider calls above already completed, so no
  // transaction is held across network I/O. Re-selecting an
  // already-connected Page consumes no slot (probed inside the tx).
  const now = new Date();
  const data = {
    status: "CONNECTED",
    statusDetail: null,
    encryptedCredentials: encryptCredentials({
      ...creds,
      pageId: body.pageId,
      pageName: page.name,
      pageAccessToken: page.access_token,
      igUserId: ig?.id,
      igUsername: ig?.username,
    }),
    externalAccountId: body.pageId,
    // Visible account identity (never guessed): IG username when linked,
    // otherwise the Page name. No avatar is retrievable without extra
    // permissions, so it stays null.
    accountName: ig?.username ?? page.name,
    accountAvatarUrl: null,
    verifiedAt: now,
    lastSyncAt: now,
  };
  // Find-or-create the picked Page's own account row, keyed by
  // (workspace, provider, pageId), and land the credentials on it —
  // inside the connected-account slot transaction: the count check and
  // the insert are atomic, so concurrent selects of different new Pages
  // cannot race past the plan cap. At the cap the slot helper throws the
  // honest 402 Response, which handler() returns as-is.
  const updated = await withConnectedAccountSlot(
    ctx.workspaceId,
    { provider: body.provider, externalAccountId: body.pageId },
    async (tx) => {
      const raced = await tx.integration.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          provider: body.provider,
          externalAccountId: body.pageId,
        },
        orderBy: { createdAt: "asc" },
      });
      if (raced) return tx.integration.update({ where: { id: raced.id }, data });
      return tx.integration.create({
        data: { workspaceId: ctx.workspaceId, provider: body.provider, ...data },
      });
    }
  );
  await ensureDefaultAccount(ctx.workspaceId, body.provider, updated.id);

  await auditLog(ctx.workspaceId, ctx.userId, "integration.meta_page_selected", {
    type: "integration",
    id: updated.id,
    provider: body.provider,
    pageId: body.pageId,
  });

  return ok({
    status: "CONNECTED",
    accountName: ig?.username ?? page.name,
    accountId: ig?.id ?? body.pageId,
  });
});
