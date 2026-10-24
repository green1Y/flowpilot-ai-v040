/**
 * Messaging eligibility checker — PURE, no database access.
 *
 * Encodes the platform messaging restrictions documented in AUDIT.md §2–3:
 *  - Suppressed/opted-out contacts are never eligible, for any message type.
 *  - Freeform (IG / Messenger / WhatsApp): eligible only within 24h of the
 *    contact's last inbound message/comment, per channel-identity contact.
 *  - Instagram private reply (to a comment): comment must be ≤ 7 days old AND
 *    no prior private reply may exist for that comment (Meta: one reply per
 *    comment, error 551 outside the window).
 *  - WhatsApp template: eligible regardless of the 24h window (the template
 *    itself must be Meta-approved; approval is Meta-side, not tracked here).
 *
 * All date comparisons use `now` (default: new Date()) so tests can inject
 * deterministic time. Callers feed `lastInboundAt` / `commentCreatedAt` from
 * Contact.lastInboundAt / Comment.commentedAt.
 */

export type EligibilityChannel = "instagram" | "facebook" | "whatsapp";
export type EligibilityMessageType = "freeform" | "template" | "private_reply";

export interface EligibilityInput {
  channel: EligibilityChannel;
  messageType: EligibilityMessageType;
  /** Last inbound message/comment on this channel-identity contact. */
  lastInboundAt?: Date | null;
  /** When the comment was created (private_reply only). */
  commentCreatedAt?: Date | null;
  /** When a private reply was already sent for this comment (private_reply). */
  privateRepliedAt?: Date | null;
  /** True when the contact has a Suppression row. */
  suppressed?: boolean;
  /** Reference time; defaults to new Date(). */
  now?: Date;
}

export interface EligibilityResult {
  eligible: boolean;
  /** All evaluated reasons (both positive and negative), most specific first. */
  reasons: string[];
  /** Only the blocking reasons (empty when eligible). */
  ineligibleReasons: string[];
  /** End of the current send window, when one applies. */
  windowEndsAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_24H_MS = DAY_MS;
const PRIVATE_REPLY_WINDOW_MS = 7 * DAY_MS;

function windowEnd(start: Date, ms: number): Date {
  return new Date(start.getTime() + ms);
}

export function checkEligibility(input: EligibilityInput): EligibilityResult {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const ineligibleReasons: string[] = [];
  let eligible = true;
  let windowEndsAt: Date | null = null;

  // --- Universal: suppression blocks everything ---
  if (input.suppressed) {
    ineligibleReasons.push("contact is suppressed/opted out");
    reasons.push("contact is suppressed/opted out");
    return {
      eligible: false,
      reasons,
      ineligibleReasons,
      windowEndsAt: null,
    };
  }

  // --- Private reply (IG/FB comments) ---
  if (input.messageType === "private_reply") {
    if (input.channel === "whatsapp") {
      ineligibleReasons.push(
        "private replies are not supported on WhatsApp"
      );
      reasons.push("private replies are not supported on WhatsApp");
      return { eligible: false, reasons, ineligibleReasons, windowEndsAt: null };
    }
    if (input.privateRepliedAt) {
      ineligibleReasons.push(
        "this comment has already received a private reply (Meta allows one per comment)"
      );
      reasons.push(
        "this comment has already received a private reply (Meta allows one per comment)"
      );
      return { eligible: false, reasons, ineligibleReasons, windowEndsAt: null };
    }
    if (!input.commentCreatedAt) {
      ineligibleReasons.push(
        "comment creation time is unknown — cannot verify the 7-day private-reply window"
      );
      reasons.push(
        "comment creation time is unknown — cannot verify the 7-day private-reply window"
      );
      return { eligible: false, reasons, ineligibleReasons, windowEndsAt: null };
    }
    const ageMs = now.getTime() - input.commentCreatedAt.getTime();
    windowEndsAt = windowEnd(input.commentCreatedAt, PRIVATE_REPLY_WINDOW_MS);
    if (ageMs < 0) {
      // Clock skew guard: a comment timestamp in the future is treated as now.
      reasons.push("comment is within the 7-day private-reply window");
      return { eligible: true, reasons, ineligibleReasons, windowEndsAt };
    }
    if (ageMs <= PRIVATE_REPLY_WINDOW_MS) {
      reasons.push(
        `comment is ${Math.floor(ageMs / DAY_MS)} day(s) old — within the 7-day private-reply window`
      );
      return { eligible: true, reasons, ineligibleReasons, windowEndsAt };
    }
    ineligibleReasons.push(
      "comment is older than 7 days — Meta private replies are rejected after the 7-day window (error 551)"
    );
    reasons.push(
      "comment is older than 7 days — Meta private replies are rejected after the 7-day window (error 551)"
    );
    return { eligible: false, reasons, ineligibleReasons, windowEndsAt };
  }

  // --- WhatsApp template: always eligible outside the 24h window ---
  if (input.messageType === "template") {
    if (input.channel !== "whatsapp") {
      ineligibleReasons.push(
        `templates are only supported on WhatsApp in this checker (got ${input.channel})`
      );
      reasons.push(
        `templates are only supported on WhatsApp in this checker (got ${input.channel})`
      );
      return { eligible: false, reasons, ineligibleReasons, windowEndsAt: null };
    }
    reasons.push(
      "WhatsApp template messages are eligible outside the 24-hour window (template must be approved in Meta — approval is Meta-side)"
    );
    return { eligible: true, reasons, ineligibleReasons, windowEndsAt: null };
  }

  // --- Freeform on any channel: 24h window from last inbound ---
  const lastInbound = input.lastInboundAt ?? null;
  if (!lastInbound) {
    ineligibleReasons.push(
      "no inbound message from this contact in the last 24 hours — freeform is not allowed"
    );
    if (input.channel === "whatsapp") {
      ineligibleReasons.push(
        "suggestion: send an approved WhatsApp template instead"
      );
      reasons.push(
        "suggestion: send an approved WhatsApp template instead"
      );
    } else {
      ineligibleReasons.push(
        "suggestion: use a utility template or a one-time-notification opt-in (message tags are deprecated)"
      );
      reasons.push(
        "suggestion: use a utility template or a one-time-notification opt-in (message tags are deprecated)"
      );
    }
    reasons.push(
      "no inbound message from this contact in the last 24 hours — freeform is not allowed"
    );
    return { eligible: false, reasons, ineligibleReasons, windowEndsAt: null };
  }

  const ageMs = now.getTime() - lastInbound.getTime();
  windowEndsAt = windowEnd(lastInbound, WINDOW_24H_MS);
  if (ageMs >= 0 && ageMs <= WINDOW_24H_MS) {
    reasons.push(
      `last inbound message ${Math.floor(ageMs / (60 * 60 * 1000))}h ago — inside the 24-hour messaging window`
    );
    return { eligible: true, reasons, ineligibleReasons, windowEndsAt };
  }

  ineligibleReasons.push(
    "the 24-hour messaging window has expired (last inbound is older than 24h)"
  );
  if (input.channel === "whatsapp") {
    ineligibleReasons.push(
      "suggestion: send an approved WhatsApp template instead"
    );
    reasons.push("suggestion: send an approved WhatsApp template instead");
  } else {
    ineligibleReasons.push(
      "suggestion: use a utility template or a one-time-notification opt-in (message tags are deprecated)"
    );
    reasons.push(
      "suggestion: use a utility template or a one-time-notification opt-in (message tags are deprecated)"
    );
  }
  reasons.push(
    "the 24-hour messaging window has expired (last inbound is older than 24h)"
  );
  return { eligible: false, reasons, ineligibleReasons, windowEndsAt };
}
