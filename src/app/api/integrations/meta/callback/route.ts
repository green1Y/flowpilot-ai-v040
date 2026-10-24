import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  metaEnv,
  verifyState,
  exchangeCodeForToken,
  exchangeForLongLived,
  getMe,
  encryptCredentials,
  MetaApiError,
  type MetaProvider,
} from "@/lib/integrations/meta";
import {
  buildInstagramLoginUrl,
  exchangeInstagramCode,
  exchangeInstagramLongLived,
  getInstagramLoginUser,
  instagramLoginCallbackUrl,
  subscribeInstagramWebhooks,
} from "@/lib/integrations/instagram-login";

import {
  STATUS_DETAIL_CODES,
  makeStatusDetail,
} from "@/lib/integrations/connection-state";
import {
  findAccountRow,
  upsertAccountRow,
  ensureDefaultAccount,
} from "@/lib/integrations/accounts";
import { withConnectedAccountSlot } from "@/lib/billing/usage";

/**
 * GET /api/integrations/meta/callback?code=...&state=...
 *
 * Meta OAuth redirect target. On success the integration row is upserted with
 * status NEEDS_ATTENTION (page selection still pending) and the user is
 * redirected to /app/integrations?meta_connected=<provider>.
 * On any failure the user is redirected to
 * /app/integrations?meta_error=<url-encoded message> — never 500 to the
 * browser, and never any token in the URL.
 */

function redirectTo(path: string, status = 302): NextResponse {
  const { publicUrl } = metaEnv();
  return NextResponse.redirect(`${publicUrl}${path}`, { status });
}

function errorRedirect(
  message: string,
  provider?: string,
  status = 302
): NextResponse {
  const qp = new URLSearchParams({ meta_error: message });
  if (provider) qp.set("meta_provider", provider);
  return redirectTo(`/app/integrations?${qp.toString()}`, status);
}

/**
 * Persist a callback-failure detail so the card shows "failed" instead of a
 * stale state. Only the placeholder row (externalAccountId = null — the
 * in-progress connect attempt) is marked: a failed attempt cannot be
 * attributed to a specific account, so identified account rows are never
 * touched. Only touches non-CONNECTED rows: a failed RECONNECT attempt
 * must not downgrade a still-valid existing connection (its credentials
 * were never replaced).
 */
async function recordCallbackFailure(
  workspaceId: string,
  provider: string,
  message: string
): Promise<void> {
  try {
    const row = await findAccountRow(workspaceId, provider, null);
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

/**
 * Instagram Business Login callback handler (separate from Facebook Login).
 *
 * Unlike Facebook Login there is no Page-selection step: the identity
 * returned by the exchange IS the Instagram Professional account, so a
 * successful exchange + identity lookup marks the row CONNECTED directly.
 * Any failure redirects with meta_error — never CONNECTED, never tokens
 * in the URL.
 */
async function handleInstagramLoginCallback(
  ctx: { workspaceId: string; userId: string },
  code: string
): Promise<NextResponse> {
  try {
    const redirectUri = instagramLoginCallbackUrl();

    const short = await exchangeInstagramCode(code, redirectUri);
    const long = await exchangeInstagramLongLived(short.access_token);
    const me = await getInstagramLoginUser(long.access_token);
    const expiresAt =
      typeof long.expires_in === "number"
        ? new Date(Date.now() + long.expires_in * 1000).toISOString()
        : null;

    // Plan limit (Batch C) is enforced transactionally around the
    // account insert below — the token exchange + identity fetch above
    // already completed, so no transaction is held across network I/O.
    // Reconnecting the same IG account consumes no slot (probed inside
    // the transaction). A thrown 402 Response is rethrown by the catch
    // below so handler() returns it as-is instead of a redirect.
    const now = new Date();
    const data = {
      status: "CONNECTED",
      statusDetail: null,
      encryptedCredentials: encryptCredentials({
        provider: "instagram",
        loginType: "instagram_login",
        accessToken: long.access_token,
        expiresAt,
        igUserId: me.id,
        igUsername: me.username,
      }),
      externalAccountId: me.id,
      accountName: me.username,
      accountAvatarUrl: me.profile_picture_url ?? null,
      verifiedAt: now,
      lastSyncAt: now,
    };
    // Keyed by the IG user id from the identity response: connecting a
    // second Instagram account creates a NEW row and never touches the
    // first account's credentials. The find-or-create runs inside the
    // connected-account slot transaction (count + insert atomic).
    const row = await withConnectedAccountSlot(
      ctx.workspaceId,
      { provider: "instagram", externalAccountId: me.id },
      async (tx) => {
        const raced = await tx.integration.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            provider: "instagram",
            externalAccountId: me.id,
          },
          orderBy: { createdAt: "asc" },
        });
        if (raced) return tx.integration.update({ where: { id: raced.id }, data });
        return tx.integration.create({
          data: { workspaceId: ctx.workspaceId, provider: "instagram", ...data },
        });
      }
    );
    await ensureDefaultAccount(ctx.workspaceId, "instagram", row.id);

    // Best-effort webhook subscription for this IG account (messages +
    // comments). A failure here does NOT fail the connection — webhooks can
    // be retried from the integrations page — but without it no inbound
    // events will arrive.
    let webhooksSubscribed = false;
    try {
      webhooksSubscribed = await subscribeInstagramWebhooks(me.id, long.access_token);
    } catch (e) {
      console.warn(
        `[instagram-login] webhook subscription failed for ${me.id}:`,
        e instanceof Error ? e.message : String(e)
      );
    }

    await auditLog(ctx.workspaceId, ctx.userId, "integration.meta_connected", {
      type: "integration",
      id: row.id,
      provider: "instagram",
      loginType: "instagram_login",
      webhooksSubscribed,
    });

    return redirectTo(`/app/integrations?meta_connected=instagram`);
  } catch (e) {
    // Thrown Responses (e.g. the 402 plan limit) pass through as-is —
    // handler() returns them unchanged, never as a redirect.
    if (e instanceof Response) throw e;
    const message =
      e instanceof MetaApiError ? e.message : "Instagram authorization failed";
    await recordCallbackFailure(ctx.workspaceId, "instagram", message);
    return errorRedirect(message, "instagram");
  }
}

export const GET = handler(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams;

  // Meta reports a denied/failed authorization via `error`.
  const error = q.get("error");
  if (error) {
    return errorRedirect(q.get("error_description") || error);
  }

  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) {
    return errorRedirect("Missing code or state in Meta callback");
  }

  let st: { workspaceId: string; provider: MetaProvider };
  try {
    st = verifyState(state);
  } catch {
    return errorRedirect("invalid_state");
  }

  // The signed state binds the flow to one workspace; the signed-in user must
  // belong to that same workspace. (Redirect status must stay 3xx — the
  // error detail travels in the URL, not the status code.)
  const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");
  if (ctx.workspaceId !== st.workspaceId) {
    await recordCallbackFailure(
      st.workspaceId,
      st.provider,
      "Workspace mismatch — please retry the connection from the same workspace"
    );
    return errorRedirect(
      "Workspace mismatch — please retry the connection from the same workspace",
      st.provider
    );
  }

  try {
    // Instagram uses Business Login (www.instagram.com) — a separate flow
    // with its own endpoints. Facebook/WhatsApp stay on Facebook Login.
    if (st.provider === "instagram") {
      return await handleInstagramLoginCallback(ctx, code);
    }

    const env = metaEnv();
    const redirectUri = `${env.publicUrl}/api/integrations/meta/callback`;

    const short = await exchangeCodeForToken(code, redirectUri);
    const long = await exchangeForLongLived(short.access_token);
    const me = await getMe(long.access_token);
    const expiresAt =
      typeof long.expires_in === "number"
        ? new Date(Date.now() + long.expires_in * 1000).toISOString()
        : null;

    const data = {
      status: "NEEDS_ATTENTION",
      statusDetail: null,
      encryptedCredentials: encryptCredentials({
        provider: st.provider,
        accessToken: long.access_token,
        expiresAt,
        metaUserId: me.id,
        metaUserName: me.name,
      }),
      lastSyncAt: new Date(),
    };
    // No provider asset identity is known yet (Facebook Page / WhatsApp
    // phone number are bound later — meta/select and whatsapp/manual), so
    // this stages the user token on the placeholder row
    // (externalAccountId = null) and never touches a connected account.
    const row = await upsertAccountRow({
      workspaceId: ctx.workspaceId,
      provider: st.provider,
      externalAccountId: null,
      update: data,
      create: {
        workspace: { connect: { id: ctx.workspaceId } },
        provider: st.provider,
        ...data,
      },
    });

    await auditLog(ctx.workspaceId, ctx.userId, "integration.meta_connected", {
      type: "integration",
      id: row.id,
      provider: st.provider,
    });

    return redirectTo(`/app/integrations?meta_connected=${st.provider}`);
  } catch (e) {
    // Thrown Responses (e.g. the 402 plan limit from the Instagram branch)
    // pass through as-is — handler() returns them unchanged.
    if (e instanceof Response) throw e;
    // Surface Meta's message (never tokens) as the redirect error.
    const message =
      e instanceof MetaApiError ? e.message : "Meta authorization failed";
    await recordCallbackFailure(ctx.workspaceId, st.provider, message);
    return errorRedirect(message, st.provider);
  }
});
