import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { decryptCredentials } from "@/lib/integrations/meta";
import { listInstagramMedia } from "@/lib/comment-dm/media";
import {
  blocked,
  findWorkspaceInstagramAccount,
  serializeAccount,
} from "../helpers";

/**
 * GET /api/comment-dm/media (MANAGER+).
 *
 * Without ?integrationId=: lists the workspace's connected Instagram
 * accounts so the UI picker can be populated (no other wave owns a
 * per-account list endpoint).
 *
 * With ?integrationId=: lists that account's eligible posts/Reels via
 * the official GET /{ig-user-id}/media edge. On ANY missing
 * prerequisite — no account, wrong provider, not CONNECTED, no stored
 * credentials, no Instagram user id — returns an honest BLOCKED
 * response naming the prerequisite. Media is NEVER fabricated.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const sp = new URL(req.url).searchParams;
  const integrationId = sp.get("integrationId");

  if (!integrationId) {
    const accounts = await db.integration.findMany({
      where: { workspaceId: ctx.workspaceId, provider: "instagram" },
      orderBy: { createdAt: "asc" },
    });
    return ok({ accounts: accounts.map(serializeAccount) });
  }

  const row = await findWorkspaceInstagramAccount(ctx.workspaceId, integrationId);
  if (row.status !== "CONNECTED") {
    return blocked(
      `Instagram account "${row.accountName ?? integrationId}" is ${row.status}, not CONNECTED — connect it (Integrations page) before listing its posts.`
    );
  }
  if (!row.encryptedCredentials) {
    return blocked(
      `Instagram account "${row.accountName ?? integrationId}" has no stored credentials — reconnect it before listing its posts.`
    );
  }
  let creds;
  try {
    creds = decryptCredentials(row.encryptedCredentials);
  } catch {
    return blocked(
      `Stored credentials for "${row.accountName ?? integrationId}" could not be decrypted — reconnect the account.`
    );
  }
  if (!creds.igUserId) {
    return blocked(
      `Instagram account "${row.accountName ?? integrationId}" has no stored Instagram user id — reconnect it via Instagram Business Login so its posts can be listed.`
    );
  }
  const { items, paging } = await listInstagramMedia({
    igUserId: creds.igUserId,
    accessToken: creds.accessToken,
  });
  return ok({ items, paging });
});
