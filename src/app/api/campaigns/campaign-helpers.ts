import { db } from "@/lib/db";
import { err } from "@/lib/api";
import { SendError } from "@/lib/messaging/send";

/** Tenant-scoped campaign lookup; 404 when missing (or not ours). */
export async function scopedCampaign(workspaceId: string, id: string) {
  const campaign = await db.campaign.findFirst({ where: { id, workspaceId } });
  if (!campaign) throw err("Campaign not found", 404);
  return campaign;
}

/** Map a lib-level SendError to an err() Response; rethrows anything else. */
export function mapSendError(e: unknown): never {
  if (e instanceof SendError) {
    throw err(e.message, e.status, e.extra as Record<string, unknown> | undefined);
  }
  throw e;
}
