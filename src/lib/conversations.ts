import { db } from "./db";

/**
 * Stage 4a — typing presence. `composingBy`/`composingAt` are set when an
 * agent focuses the composer and cleared on blur/send. Presence expires
 * lazily on read: any record older than TYPING_TTL_MS is treated as stale
 * and cleared.
 */
export const TYPING_TTL_MS = 90_000;

/** True when a composingAt timestamp still counts as live presence. */
export function isComposingFresh(composingAt: Date | string | null | undefined): boolean {
  if (!composingAt) return false;
  const t = composingAt instanceof Date ? composingAt.getTime() : new Date(composingAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < TYPING_TTL_MS;
}

/** Bulk-clear stale typing presence for a workspace (call on conversation reads). */
export async function expireStaleTyping(workspaceId: string): Promise<void> {
  const cutoff = new Date(Date.now() - TYPING_TTL_MS);
  try {
    await db.conversation.updateMany({
      where: {
        workspaceId,
        composingBy: { not: null },
        composingAt: { lt: cutoff },
      },
      data: { composingBy: null, composingAt: null },
    });
  } catch (e) {
    // Presence expiry is best-effort; never break a read.
    console.error("[conversations] failed to expire stale typing", e);
  }
}

/** Clear stale presence for a single conversation; returns true if it expired. */
export async function expireStaleTypingFor(id: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - TYPING_TTL_MS);
  try {
    const res = await db.conversation.updateMany({
      where: { id, composingBy: { not: null }, composingAt: { lt: cutoff } },
      data: { composingBy: null, composingAt: null },
    });
    return res.count > 0;
  } catch (e) {
    console.error("[conversations] failed to expire stale typing", e);
    return false;
  }
}
