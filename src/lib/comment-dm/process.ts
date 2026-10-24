/**
 * Instagram Comment-to-DM rule processor.
 *
 * Called from webhook ingestion AFTER a Comment row is created (see the
 * surgical hook in src/lib/integrations/ingest.ts), and usable standalone.
 *
 * Guarantees (see docs/COMMENT_TO_DM.md for the full contract):
 * - Official API only. The private reply reuses the workflow engine's
 *   reply path exactly: resolveWorkspaceAdapter with the pinned
 *   integrationId + adapter.replyToComment (POST /{comment-id}/
 *   private_replies). NOTE on the public reply: the engine's
 *   action.reply_comment is itself the PRIVATE-reply path, so reusing it
 *   for commentReply would send TWO private replies — and Meta permits
 *   only one private reply per comment. The public reply therefore goes
 *   through the official public endpoint POST /{comment-id}/replies with
 *   the same decrypted credentials (igGraph for Business Login accounts,
 *   graph for legacy Facebook-Login accounts).
 * - One send per comment per rule. A pre-check for an existing
 *   CommentDmEvent plus the @@unique([workspaceId, ruleId, commentId])
 *   backstop means a Meta redelivery creates NO second event and NO
 *   second send (sequential redelivery is fully prevented; a truly
 *   concurrent double-delivery can only reach the unique-violation
 *   backstop, which is caught and reported as duplicate:true).
 * - Eligibility enforced: a private reply is sent only while
 *   privateReplyEligibleUntil is in the future and privateRepliedAt is
 *   unset; otherwise a SKIPPED event records the reason.
 * - Dry-run rules record DRY_RUN events and never call a provider.
 * - Demo workspaces never send (assertLiveSendAllowed, same central
 *   contract as the workflow engine) — recorded as SKIPPED.
 * - Personalization uses ONLY {{name}} (from the verified Contact record
 *   linked to the comment, never invented) and {{keyword}} (the matched
 *   keyword). Unknown placeholders are left untouched, never guessed.
 * - Provider errors are sanitized (sanitizeMetaResponseForLog) before
 *   storage — no tokens ever land in CommentDmEvent.error.
 *
 * This function never throws for a single rule: per-rule failures become
 * FAILED events, and a failure to even load rules is reported on the
 * result. The ingest hook additionally wraps the call so a matcher
 * failure can never break webhook ingestion.
 */
import { db } from "@/lib/db";
import { matchKeywords } from "./match";
import { parseRuleKeywords } from "./rules";
import {
  igGraph,
  sanitizeMetaResponseForLog,
} from "@/lib/integrations/instagram-login";
import { decryptCredentials, graph } from "@/lib/integrations/meta";
import { resolveWorkspaceAdapter } from "@/lib/integrations/providers";
import { assertLiveSendAllowed } from "@/lib/demo/guard";

/** Meta's private-reply window: 7 days from the comment time. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ProcessCommentInput {
  workspaceId: string;
  integrationId: string;
  /** Meta comment id (Comment.externalId), NOT the internal row id. */
  commentId: string;
  mediaId: string;
  commentText: string;
  /** Comment time; used to derive the window when no Comment row exists. */
  commentedAt?: Date;
}

export type ProcessRuleStatus =
  | "NO_MATCH"
  | "DUPLICATE"
  | "DRY_RUN"
  | "SKIPPED"
  | "SENT"
  | "FAILED";

export interface ProcessCommentRuleResult {
  ruleId: string;
  matched: boolean;
  keyword: string | null;
  duplicate: boolean;
  status: ProcessRuleStatus;
  /** Human-readable reason for SKIPPED / FAILED outcomes. */
  reason?: string;
}

export interface ProcessCommentResult {
  results: ProcessCommentRuleResult[];
  /** Set only when the rule lookup itself failed (no rules processed). */
  error?: string;
}

/** Injectable send paths — production defaults hit the official API; tests stub these. */
export interface CommentDmSenders {
  sendPublicReply?: (args: {
    commentId: string;
    body: string;
  }) => Promise<{ externalId?: string | null }>;
  sendPrivateReply?: (args: {
    commentId: string;
    body: string;
  }) => Promise<{ externalId?: string | null }>;
}

export interface ProcessCommentDeps extends CommentDmSenders {
  now?: Date;
}

/** Render {{name}} / {{keyword}} only; unknown placeholders pass through untouched. */
export function renderCommentDmTemplate(
  template: string,
  vars: { name: string; keyword: string }
): string {
  return template
    .replace(/\{\{\s*name\s*\}\}/g, vars.name)
    .replace(/\{\{\s*keyword\s*\}\}/g, vars.keyword);
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "P2002";
}

function sanitizeError(e: unknown): string {
  if (e instanceof Error) return sanitizeMetaResponseForLog(e.message);
  return sanitizeMetaResponseForLog(String(e));
}

/**
 * Default public reply: official POST /{comment-id}/replies.
 * Business Login accounts go through graph.instagram.com (igGraph);
 * legacy Facebook-Login accounts through graph.facebook.com (graph).
 * Credentials come from the workspace's own Integration row, decrypted
 * in memory only — never logged, never stored.
 */
async function defaultSendPublicReply(
  workspaceId: string,
  integrationId: string,
  commentId: string,
  body: string
): Promise<{ externalId?: string | null }> {
  const row = await db.integration.findFirst({
    where: { id: integrationId, workspaceId },
  });
  if (!row) throw new Error("Integration row not found for this rule");
  if (!row.encryptedCredentials) {
    throw new Error("Integration has no stored credentials — reconnect the account");
  }
  const creds = decryptCredentials(row.encryptedCredentials);
  if (creds.loginType === "instagram_login") {
    const data = await igGraph<{ id?: string }>(`/${commentId}/replies`, creds.accessToken, {
      method: "POST",
      body: { message: body },
    });
    return { externalId: data.id ?? null };
  }
  const data = await graph<{ id?: string }>(`/${commentId}/replies`, {
    token: creds.accessToken,
    method: "POST",
    body: { message: body },
  });
  return { externalId: data.id ?? null };
}

/**
 * Default private reply: the workflow engine's reply path, pinned to the
 * rule's exact account. resolveWorkspaceAdapter with an explicit id
 * THROWS (never silently re-routes or falls back to a mock) when the
 * account is missing, disconnected, or unusable — that error becomes a
 * FAILED event, never a fake send.
 */
async function defaultSendPrivateReply(
  workspaceId: string,
  integrationId: string,
  commentId: string,
  body: string
): Promise<{ externalId?: string | null }> {
  const resolved = await resolveWorkspaceAdapter(workspaceId, "instagram", {
    integrationId,
  });
  if (!resolved.adapter.replyToComment) {
    throw new Error("Resolved account adapter has no private-reply path");
  }
  const result = await resolved.adapter.replyToComment({ commentId, body });
  if (!result.ok) throw new Error(result.error ?? "Private reply was not accepted");
  return { externalId: result.externalId ?? null };
}

interface EventAction {
  type: string;
  status: string;
  detail?: string;
}

async function createEvent(args: {
  workspaceId: string;
  ruleId: string;
  commentId: string;
  keyword: string | null;
  actions: EventAction[];
  status: string;
  error?: string;
}): Promise<{ duplicate: boolean }> {
  try {
    await db.commentDmEvent.create({
      data: {
        workspaceId: args.workspaceId,
        ruleId: args.ruleId,
        commentId: args.commentId,
        matched: true,
        keyword: args.keyword,
        actions: JSON.stringify(args.actions),
        status: args.status,
        error: args.error ?? null,
      },
    });
    return { duplicate: false };
  } catch (e) {
    if (isUniqueViolation(e)) return { duplicate: true };
    throw e;
  }
}

/**
 * Best-effort duplicate bookkeeping: when a redelivery is suppressed,
 * note it on the ORIGINAL event's actions JSON so per-rule analytics can
 * count duplicatesPrevented honestly. Never throws; capped so the array
 * cannot grow without bound.
 */
async function noteDuplicateSuppressed(eventId: string): Promise<void> {
  try {
    const existing = await db.commentDmEvent.findUnique({
      where: { id: eventId },
      select: { actions: true },
    });
    if (!existing) return;
    let actions: EventAction[] = [];
    try {
      const parsed: unknown = JSON.parse(existing.actions || "[]");
      if (Array.isArray(parsed)) actions = parsed as EventAction[];
    } catch {
      actions = [];
    }
    if (actions.length >= 100) return;
    actions.push({
      type: "duplicate_suppressed",
      status: "suppressed",
      detail: `redelivery suppressed at ${new Date().toISOString()}`,
    });
    await db.commentDmEvent.update({
      where: { id: eventId },
      data: { actions: JSON.stringify(actions) },
    });
  } catch {
    // Bookkeeping only — suppression itself already succeeded.
  }
}

export async function processCommentForRules(
  input: ProcessCommentInput,
  deps: ProcessCommentDeps = {}
): Promise<ProcessCommentResult> {
  const now = deps.now ?? new Date();
  let rules;
  try {
    rules = await db.commentDmRule.findMany({
      where: {
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
        mediaId: input.mediaId,
        enabled: true,
      },
      orderBy: { createdAt: "asc" },
    });
  } catch (e) {
    return { results: [], error: sanitizeError(e) };
  }

  const results: ProcessCommentRuleResult[] = [];
  for (const rule of rules) {
    const keywords = parseRuleKeywords(rule.keywords);
    const keyword = matchKeywords(
      input.commentText,
      keywords,
      rule.matchMode === "exact" || rule.matchMode === "startsWith"
        ? rule.matchMode
        : "contains",
      rule.caseSensitive
    );
    if (!keyword) {
      // Non-matching comments produce NO event: the history stays a record
      // of actions taken, not noise from every comment on a tracked post.
      results.push({ ruleId: rule.id, matched: false, keyword: null, duplicate: false, status: "NO_MATCH" });
      continue;
    }

    // Dedupe pre-check: a redelivery after completed processing must not
    // send again. (The unique constraint below is the race backstop.)
    try {
      const existing = await db.commentDmEvent.findFirst({
        where: {
          workspaceId: input.workspaceId,
          ruleId: rule.id,
          commentId: input.commentId,
        },
        select: { id: true },
      });
      if (existing) {
        await noteDuplicateSuppressed(existing.id);
        results.push({ ruleId: rule.id, matched: true, keyword, duplicate: true, status: "DUPLICATE", reason: "comment already processed for this rule" });
        continue;
      }
    } catch (e) {
      results.push({ ruleId: rule.id, matched: true, keyword, duplicate: false, status: "FAILED", reason: sanitizeError(e) });
      continue;
    }

    // Dry-run: record, never send.
    if (rule.dryRun) {
      try {
        const created = await createEvent({
          workspaceId: input.workspaceId,
          ruleId: rule.id,
          commentId: input.commentId,
          keyword,
          actions: [{ type: "dry_run", status: "recorded", detail: `would match keyword "${keyword}"` }],
          status: "DRY_RUN",
        });
        results.push({ ruleId: rule.id, matched: true, keyword, duplicate: created.duplicate, status: created.duplicate ? "DUPLICATE" : "DRY_RUN" });
      } catch (e) {
        results.push({ ruleId: rule.id, matched: true, keyword, duplicate: false, status: "FAILED", reason: sanitizeError(e) });
      }
      continue;
    }

    // Eligibility: Comment row first, commentedAt-derived window as fallback.
    let commentRow: { id: string; workspaceId: string; contactId: string | null; privateRepliedAt: Date | null; privateReplyEligibleUntil: Date } | null = null;
    try {
      commentRow = await db.comment.findUnique({
        where: { externalId: input.commentId },
        select: { id: true, workspaceId: true, contactId: true, privateRepliedAt: true, privateReplyEligibleUntil: true },
      });
    } catch {
      commentRow = null;
    }
    if (commentRow && commentRow.workspaceId !== input.workspaceId) commentRow = null;
    const eligibleUntil = commentRow
      ? commentRow.privateReplyEligibleUntil
      : input.commentedAt
        ? new Date(input.commentedAt.getTime() + PRIVATE_REPLY_WINDOW_MS)
        : null;

    const skip = async (reason: string): Promise<void> => {
      try {
        const created = await createEvent({
          workspaceId: input.workspaceId,
          ruleId: rule.id,
          commentId: input.commentId,
          keyword,
          actions: [{ type: "skipped", status: "skipped", detail: reason }],
          status: "SKIPPED",
        });
        results.push({ ruleId: rule.id, matched: true, keyword, duplicate: created.duplicate, status: created.duplicate ? "DUPLICATE" : "SKIPPED", reason });
      } catch (e) {
        results.push({ ruleId: rule.id, matched: true, keyword, duplicate: false, status: "FAILED", reason: sanitizeError(e) });
      }
    };

    if (!eligibleUntil) {
      await skip("comment record not found and no comment time supplied — cannot verify the private-reply window");
      continue;
    }
    if (commentRow?.privateRepliedAt) {
      await skip("comment already has a private reply (one reply per comment)");
      continue;
    }
    if (eligibleUntil.getTime() <= now.getTime()) {
      await skip("private-reply window expired (7 days after the comment)");
      continue;
    }
    if (!rule.commentReply && !rule.dmTemplate) {
      await skip("rule has no comment reply or DM template configured — nothing to send");
      continue;
    }

    // Demo guard: same central contract as the workflow engine.
    try {
      await assertLiveSendAllowed(input.workspaceId);
    } catch {
      await skip("live sends blocked for this workspace (demo mode)");
      continue;
    }

    // Personalization data: verified Contact record only, never invented.
    let contactName = "";
    if (commentRow?.contactId) {
      try {
        const contact = await db.contact.findUnique({
          where: { id: commentRow.contactId },
          select: { name: true, workspaceId: true },
        });
        if (contact && contact.workspaceId === input.workspaceId) contactName = contact.name ?? "";
      } catch {
        contactName = "";
      }
    }

    const actions: EventAction[] = [];
    let privateFailed: string | null = null;
    const sendPublic = deps.sendPublicReply ??
      ((a: { commentId: string; body: string }) =>
        defaultSendPublicReply(input.workspaceId, input.integrationId, a.commentId, a.body));
    const sendPrivate = deps.sendPrivateReply ??
      ((a: { commentId: string; body: string }) =>
        defaultSendPrivateReply(input.workspaceId, input.integrationId, a.commentId, a.body));

    // Public reply first (optional garnish — its failure never blocks the DM).
    if (rule.commentReply) {
      try {
        const res = await sendPublic({
          commentId: input.commentId,
          body: renderCommentDmTemplate(rule.commentReply, { name: contactName, keyword }),
        });
        actions.push({ type: "comment_reply", status: "sent", detail: res.externalId ?? undefined });
      } catch (e) {
        actions.push({ type: "comment_reply", status: "failed", detail: sanitizeError(e) });
      }
    }

    // Private reply: the core send. Exactly one per comment (Meta rule).
    if (rule.dmTemplate) {
      try {
        const res = await sendPrivate({
          commentId: input.commentId,
          body: renderCommentDmTemplate(rule.dmTemplate, { name: contactName, keyword }),
        });
        actions.push({ type: "private_reply", status: "sent", detail: res.externalId ?? undefined });
        if (commentRow) {
          await db.comment
            .update({ where: { id: commentRow.id }, data: { privateRepliedAt: now } })
            .catch(() => undefined);
        }
      } catch (e) {
        privateFailed = sanitizeError(e);
        actions.push({ type: "private_reply", status: "failed", detail: privateFailed });
      }
    }

    try {
      if (privateFailed) {
        const created = await createEvent({
          workspaceId: input.workspaceId,
          ruleId: rule.id,
          commentId: input.commentId,
          keyword,
          actions,
          status: "FAILED",
          error: privateFailed,
        });
        results.push({ ruleId: rule.id, matched: true, keyword, duplicate: created.duplicate, status: created.duplicate ? "DUPLICATE" : "FAILED", reason: privateFailed });
      } else {
        const created = await createEvent({
          workspaceId: input.workspaceId,
          ruleId: rule.id,
          commentId: input.commentId,
          keyword,
          actions,
          status: "SENT",
        });
        results.push({ ruleId: rule.id, matched: true, keyword, duplicate: created.duplicate, status: created.duplicate ? "DUPLICATE" : "SENT" });
      }
    } catch (e) {
      results.push({ ruleId: rule.id, matched: true, keyword, duplicate: false, status: "FAILED", reason: sanitizeError(e) });
    }
  }
  return { results };
}
