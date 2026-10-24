import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  decryptCredentials,
  encryptCredentials,
  getValidAccessToken,
} from "@/lib/integrations/meta";
import { subscribeInstagramWebhooks } from "@/lib/integrations/instagram-login";

/**
 * Wave 2A (D6) — POST /api/integrations/[id]/resubscribe-webhooks
 * (MANAGER+).
 *
 * Instagram Business-Login rows: re-subscribes the account to the
 * messages + comments webhook fields via POST subscribed_apps and, on
 * success, persists webhookSubscribedAt + webhookSubscriptionDetail
 * (sanitized JSON only: fields + checkedAt — never tokens).
 *
 * Facebook / WhatsApp rows: webhook subscription for those products is
 * managed in the Meta app dashboard, not via an API this app may call on
 * the user's behalf — return an honest BLOCKED response (HTTP 200 with
 * blocked:true, so the Health Center can render a BLOCKED badge instead
 * of an error toast). Nothing is faked: no subscription timestamp is
 * written for blocked rows.
 *
 * Any other provider: 422, resubscribe is not supported for it.
 */
export const POST = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    requireRole(ctx, "MANAGER");

    const integration = await db.integration.findFirst({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
    });
    if (!integration) throw err("Integration not found", 404);

    if (integration.provider === "facebook" || integration.provider === "whatsapp") {
      return Response.json(
        {
          ok: false,
          blocked: true,
          reason:
            "Webhook subscription for this provider is managed in the Meta app dashboard — subscribe the app to the messages field there. FlowPilot cannot confirm or change that subscription via API, so nothing was changed.",
        },
        { status: 200 }
      );
    }

    if (integration.provider !== "instagram") {
      throw err(
        `Webhook resubscribe is not supported for provider "${integration.provider}"`,
        422
      );
    }

    if (!integration.encryptedCredentials) {
      throw err("No Instagram credentials stored — complete the connection flow first", 422);
    }
    let creds;
    try {
      creds = decryptCredentials(integration.encryptedCredentials);
    } catch {
      throw err("Stored Instagram credentials are invalid — please reconnect", 422);
    }
    if (creds.loginType !== "instagram_login") {
      // Legacy Page-linked Instagram rows subscribe via the Page in the
      // Meta dashboard, same as facebook above.
      return Response.json(
        {
          ok: false,
          blocked: true,
          reason:
            "This Instagram account is Page-linked (legacy Facebook Login) — its webhook subscription is managed in the Meta app dashboard. FlowPilot cannot confirm or change that subscription via API, so nothing was changed.",
        },
        { status: 200 }
      );
    }

    const igUserId = creds.igUserId ?? integration.externalAccountId ?? undefined;
    if (!igUserId) {
      throw err("No Instagram user id stored — reconnect Instagram", 422);
    }

    // Refresh the user token first so the subscribe call uses a live token.
    let token = creds.accessToken;
    try {
      const valid = await getValidAccessToken(creds);
      token = valid.token;
      if (valid.refreshed) {
        await db.integration.update({
          where: { id: integration.id },
          data: {
            encryptedCredentials: encryptCredentials({
              ...creds,
              accessToken: valid.token,
              expiresAt: valid.newExpiresAt,
            }),
          },
        });
      }
    } catch (e) {
      if (e instanceof Response) throw e;
      throw err(
        e instanceof Error ? `Token refresh failed: ${e.message}` : "Token refresh failed",
        422
      );
    }

    const fields = ["messages", "comments"];
    let subscribed: boolean;
    try {
      subscribed = await subscribeInstagramWebhooks(igUserId, token, fields);
    } catch (e) {
      throw err(
        e instanceof Error ? `Webhook resubscribe failed: ${e.message}` : "Webhook resubscribe failed",
        422
      );
    }
    if (!subscribed) {
      throw err("Instagram did not confirm the webhook subscription", 422);
    }

    const now = new Date();
    const detail = JSON.stringify({ fields, subscribed: true, checkedAt: now.toISOString() });
    const updated = await db.integration.update({
      where: { id: integration.id },
      data: { webhookSubscribedAt: now, webhookSubscriptionDetail: detail },
    });
    await auditLog(ctx.workspaceId, ctx.userId, "integration.webhooks_resubscribed", {
      type: "integration",
      id: updated.id,
      provider: updated.provider,
      fields,
    });
    return ok({
      subscribed: true,
      webhookSubscribedAt: updated.webhookSubscribedAt,
      fields,
    });
  }
);
