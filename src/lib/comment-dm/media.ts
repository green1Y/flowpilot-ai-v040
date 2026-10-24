/**
 * Official Instagram media listing for the Comment-to-DM post/Reel picker.
 *
 * There was NO existing media-list helper in the codebase (grep over
 * src/lib/integrations found only identity/token/webhook helpers), so this
 * module adds one following the existing `igGraph` pattern from
 * instagram-login.ts: versioned requests against graph.instagram.com with
 * the decrypted user token, the same error mapping, and the same rule that
 * tokens are never logged (igGraph strips query params — where the token
 * travels — from every log line, and this module logs nothing itself).
 *
 * Official endpoint only: GET /{ig-user-id}/media
 *   ?fields=id,caption,media_type,permalink,timestamp,thumbnail_url
 * No scraping, no unofficial endpoints, no session cookies.
 *
 * The caller passes a DECRYPTED credential set (igUserId + accessToken, as
 * produced by decryptCredentials on the workspace's Integration row). This
 * module never reads the DB or the encrypted column itself, so tests can
 * drive it with a stubbed fetch and no credentials at all.
 */
import { igGraph } from "@/lib/integrations/instagram-login";

/** One media item as returned by the official media edge. */
export interface InstagramMediaItem {
  id: string;
  caption?: string;
  media_type?: string;
  permalink?: string;
  timestamp?: string;
  thumbnail_url?: string;
}

/** Decrypted credential set for one connected Instagram account. */
export interface InstagramMediaCredentials {
  igUserId: string;
  accessToken: string;
}

/** Fields requested for the picker (post/Reel identity + preview data). */
export const MEDIA_FIELDS =
  "id,caption,media_type,permalink,timestamp,thumbnail_url";

/**
 * List the account's media (posts + Reels) via the official API.
 * `limit` is clamped to 1–100 (Meta's page size bound); the caller pages
 * with `after` when it needs more. Returns the raw `data` array plus the
 * provider's paging cursors, or an empty array when the account has no
 * media — never fabricated items.
 */
export async function listInstagramMedia(
  creds: InstagramMediaCredentials,
  opts: { limit?: number; after?: string } = {}
): Promise<{ items: InstagramMediaItem[]; paging?: { cursors?: { after?: string; before?: string } } }> {
  if (!creds.igUserId || !creds.accessToken) {
    throw new Error(
      "Instagram media listing requires a connected account with a stored Instagram user id and access token — reconnect the account."
    );
  }
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 25)));
  const searchParams: Record<string, string> = {
    fields: MEDIA_FIELDS,
    limit: String(limit),
  };
  if (opts.after) searchParams.after = opts.after;
  const data = await igGraph<{
    data?: InstagramMediaItem[];
    paging?: { cursors?: { after?: string; before?: string } };
  }>(`/${creds.igUserId}/media`, creds.accessToken, { searchParams });
  return { items: Array.isArray(data?.data) ? data.data : [], paging: data?.paging };
}
