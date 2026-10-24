import { NextRequest } from "next/server";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { whatsappManualSchema } from "@/lib/validation";
import {
  encryptCredentials,
  getPhoneNumberInfo,
  MetaApiError,
  type PhoneNumberInfo,
} from "@/lib/integrations/meta";
import { ensureDefaultAccount } from "@/lib/integrations/accounts";
import { withConnectedAccountSlot } from "@/lib/billing/usage";

/**
 * POST /api/integrations/meta/whatsapp/manual
 * Body: { phoneNumberId, accessToken, displayName?, wabaId? }
 *
 * Manual WhatsApp Cloud API connection: validates the bearer token against
 * the real Graph API, then stores the encrypted credentials with status
 * CONNECTED. Returns: { status: "CONNECTED", accountName, accountId }
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, whatsappManualSchema);

  let info: PhoneNumberInfo;
  try {
    info = await getPhoneNumberInfo(body.phoneNumberId, body.accessToken);
  } catch (e) {
    if (e instanceof MetaApiError) throw err(e.message, 422);
    throw e;
  }

  // The account is keyed by its verified phone number id: connecting a
  // second WhatsApp number creates a NEW row and never touches the first
  // number's credentials. (The provider verification call above already
  // happened — no transaction is ever held across network I/O.)
  const phoneDisplayName = body.displayName ?? info.display_phone_number;
  const now = new Date();
  const data = {
    status: "CONNECTED",
      statusDetail: null,
    encryptedCredentials: encryptCredentials({
      provider: "whatsapp",
      accessToken: body.accessToken,
      expiresAt: null,
      phoneNumberId: body.phoneNumberId,
      phoneDisplayName,
      wabaId: body.wabaId,
    }),
    externalAccountId: body.phoneNumberId,
    accountName: phoneDisplayName,
    accountAvatarUrl: null,
    verifiedAt: now,
    lastSyncAt: now,
  };
  // Plan limit (Batch C): the account-count check and the row insert
  // run inside ONE transaction via withConnectedAccountSlot. A reconnect
  // of this same number (row already exists — probed inside the
  // transaction) consumes no slot; a genuinely new number at the cap
  // throws the honest 402.
  const row = await withConnectedAccountSlot(
    ctx.workspaceId,
    { provider: "whatsapp", externalAccountId: body.phoneNumberId },
    async (tx) => {
      const raced = await tx.integration.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          provider: "whatsapp",
          externalAccountId: body.phoneNumberId,
        },
        orderBy: { createdAt: "asc" },
      });
      if (raced) return tx.integration.update({ where: { id: raced.id }, data });
      return tx.integration.create({
        data: { workspaceId: ctx.workspaceId, provider: "whatsapp", ...data },
      });
    }
  );
  await ensureDefaultAccount(ctx.workspaceId, "whatsapp", row.id);

  await auditLog(ctx.workspaceId, ctx.userId, "integration.whatsapp_manual_connected", {
    type: "integration",
    id: row.id,
    provider: "whatsapp",
    phoneNumberId: body.phoneNumberId,
  });

  return ok({
    status: "CONNECTED",
    accountName: phoneDisplayName,
    accountId: body.phoneNumberId,
  });
});
