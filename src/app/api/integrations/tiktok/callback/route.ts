import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { PROVIDERS } from "@/lib/integrations/providers";
import {
  tiktokEnv,
  tiktokRedirectUri,
  verifyTikTokState,
  exchangeTikTokCode,
  getTikTokUserInfo,
  encryptTikTokCredentials,
  TikTokApiError,
  TikTokTokenExpiredError,
} from "@/lib/integrations/tiktok";
import {
  STATUS_DETAIL_CODES,
  makeStatusDetail,
} from "@/lib/integrations/connection-state";
import {
  findAccountRow,
  ensureDefaultAccount,
} from "@/lib/integrations/accounts";
import { withConnectedAccountSlot } from "@/lib/billing/usage";

/**
 * GET /api/integrations/tiktok/callback?code=…&state=…
 *
 * TikTok Login Kit redirect target. NEVER marks the provider connected
 * merely because the callback was reached — CONNECTED is written only
 * after token exchange AND identity fetch AND encrypted persistence all
 * succeed. On any failure the user is redirected to
 * /app/integrations?tiktok_error=<url-encoded message> (never a 500 to the
 * browser, never any token in the URL or logs).
 */

function redirectTo(path: string, status = 302): NextResponse {
  const { publicUrl } = tiktokEnv();
  return NextResponse.redirect(`${publicUrl}${path}`, { status });
}

function errorRedirect(message: string): NextResponse {
  return redirectTo(`/app/integrations?tiktok_error=${encodeURIComponent(message)}`);
}

/**
 * Persist a callback-failure detail so the card shows "failed" instead of a
 * stale "connecting". Only the placeholder row (externalAccountId = null —
 * the in-progress connect attempt) is marked: a failed attempt cannot be
 * attributed to a specific account, so identified rows are never touched.
 * Never touches a CONNECTED row — a failed RECONNECT must not downgrade a
 * still-valid connection.
 */
async function recordCallbackFailure(workspaceId: string, message: string): Promise<void> {
  try {
    const row = await findAccountRow(workspaceId, "tiktok", null);
    if (row && row.status !== "CONNECTED") {
      await db.integration.update({
        where: { id: row.id },
        data: {
          statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.callbackFailed, message),
        },
      });
    }
  } catch {
    // Never block the error redirect on a bookkeeping failure.
  }
}

/** Fail the callback: record the detail, then redirect with the safe message. */
async function fail(workspaceId: string, message: string): Promise<NextResponse> {
  await recordCallbackFailure(workspaceId, message);
  return errorRedirect(message);
}

export const GET = handler(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams;

  // TikTok reports a denied/failed authorization via `error`.
  const denied = q.get("error");
  if (denied) {
    return errorRedirect(q.get("error_description") || "TikTok authorization was denied");
  }

  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) {
    return errorRedirect("Missing code or state in TikTok callback");
  }

  let st: { workspaceId: string };
  try {
    st = verifyTikTokState(state);
  } catch {
    return errorRedirect("invalid_state");
  }

  // The signed state binds the flow to one workspace; the signed-in user must
  // belong to that same workspace.
  const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");
  if (ctx.workspaceId !== st.workspaceId) {
    return fail(
      st.workspaceId,
      "Workspace mismatch — please retry the connection from the same workspace"
    );
  }

  // 1) Exchange the code for tokens. Failure here must NOT mark connected.
  let tokens;
  try {
    tokens = await exchangeTikTokCode(code, tiktokRedirectUri());
  } catch (e) {
    if (e instanceof TikTokTokenExpiredError) {
      return fail(st.workspaceId, "TikTok rejected the authorization code — please try again");
    }
    if (e instanceof TikTokApiError) return fail(st.workspaceId, `TikTok error: ${e.message}`);
    return fail(st.workspaceId, "TikTok token exchange failed — please try again");
  }

  // 2) Fetch the account identity through the documented user.info.basic API.
  //    Never guess or hardcode identity.
  let identity;
  try {
    identity = await getTikTokUserInfo(tokens.access_token);
  } catch (e) {
    if (e instanceof TikTokTokenExpiredError) {
      return fail(st.workspaceId, "TikTok rejected the new token — please try again");
    }
    if (e instanceof TikTokApiError) return fail(st.workspaceId, `TikTok error: ${e.message}`);
    return fail(st.workspaceId, "Could not read the TikTok account — please try again");
  }

  // 3) Persist encrypted credentials + identity. CONNECTED is written only
  //    when this write succeeds; a persistence failure leaves the previous
  //    status untouched and reports an error instead of a fake success.
  //    The account row is keyed by the TikTok open id from the token
  //    response: connecting a second TikTok account creates a NEW row and
  //    never touches the first account's credentials.
  const expiresAt =
    typeof tokens.expires_in === "number"
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;
  const accountName = identity.displayName || identity.username || null;
  const info = PROVIDERS.find((p) => p.provider === "tiktok");

  // Plan limit (Batch C) is enforced transactionally around the account
  // insert below — token exchange + identity fetch already completed,
  // so no transaction is held across network I/O. Reconnecting the same
  // open id consumes no slot (probed inside the transaction); a thrown
  // 402 Response is rethrown from the persistence catch so it reaches
  // the client as-is instead of being converted into a redirect.
  const data = {
    status: "CONNECTED",
    statusDetail: null,
    encryptedCredentials: encryptTikTokCredentials({
      provider: "tiktok",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      openId: tokens.open_id,
    }),
    externalAccountId: tokens.open_id,
    accountName,
    accountAvatarUrl: identity.avatarUrl ?? null,
    verifiedAt: new Date(),
    lastSyncAt: new Date(),
    capabilities: JSON.stringify(info?.capabilities ?? []),
    limitations: JSON.stringify(info?.limitations ?? []),
    requiredPermissions: JSON.stringify(info?.requiredPermissions ?? []),
  };
  let row;
  try {
    row = await withConnectedAccountSlot(
      ctx.workspaceId,
      { provider: "tiktok", externalAccountId: tokens.open_id },
      async (tx) => {
        const raced = await tx.integration.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            provider: "tiktok",
            externalAccountId: tokens.open_id,
          },
          orderBy: { createdAt: "asc" },
        });
        if (raced) return tx.integration.update({ where: { id: raced.id }, data });
        return tx.integration.create({
          data: { workspaceId: ctx.workspaceId, provider: "tiktok", ...data },
        });
      }
    );
  } catch (e) {
    // The 402 plan-limit Response passes through as-is (handler()
    // returns it unchanged); only genuine persistence failures become
    // the honest redirect.
    if (e instanceof Response) throw e;
    return fail(st.workspaceId, "Could not save the TikTok connection — please try again");
  }
  await ensureDefaultAccount(ctx.workspaceId, "tiktok", row.id);

  await auditLog(ctx.workspaceId, ctx.userId, "integration.tiktok_connected", {
    type: "integration",
    provider: "tiktok",
    openId: tokens.open_id,
  });

  return redirectTo(`/app/integrations?tiktok_connected=1`);
});
