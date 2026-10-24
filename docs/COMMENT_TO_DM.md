# Instagram Comment-to-DM

Automate the classic "comment LINK and I'll DM it to you" flow inside
FlowPilot, through Meta's **official API only**. When someone comments a
keyword on a tracked post or Reel, FlowPilot can post a public reply and
send them a private message — automatically, once per comment, and only
while Meta allows it.

> Live checks are blocked in this environment (no Meta credentials):
> every provider interaction in this module is tested with stubbed
> fetch / stubbed send paths, labeled as such in the tests. Connect a
> real Instagram account and watch the event history to verify live
> behavior.

## Setup

1. **Connect an Instagram account** on the Integrations page via
   Instagram Business Login (a Professional account; the
   `instagram_business_manage_comments` permission is required).
2. Open **Comment to DM**, pick the connected account, then pick the
   post or Reel to watch. The picker lists media via the official
   `GET /{ig-user-id}/media` edge
   (`id, caption, media_type, permalink, timestamp, thumbnail_url`).
   If anything is missing — no account, account not `CONNECTED`, no
   stored credentials, no Instagram user id — the media endpoint
   returns an honest `BLOCKED` response naming the prerequisite instead
   of fake media.
3. **Create a rule** for that post: name, keywords, match mode, optional
   public comment reply, optional DM template.
4. **Start in dry-run mode.** New rules are created with dry-run ON.
   Matching comments then record `DRY_RUN` events (visible in the rule's
   history) without sending anything. Turn dry run off only after the
   matching looks right.
5. Rules fire on **new comments only**, via the webhook ingest path
   (`src/lib/integrations/ingest.ts` calls the processor after a
   `Comment` row is created). Past comments are never reprocessed.

## Rule semantics

- One rule targets **one post/Reel on one connected account**
  (`workspaceId + integrationId + mediaId`). Many rules may target the
  same post with different keywords or messages.
- Only **enabled** rules are evaluated.
- A rule with neither a comment reply nor a DM template records a
  `SKIPPED` event ("nothing to send") — it never sends.
- Sends always go through the **rule's exact account** (pinned
  `integrationId`). A missing, disconnected, or unusable account fails
  honestly as a `FAILED` event; a send is never silently re-routed
  through a different account, and never through a mock adapter.
- Demo workspaces never send (the same central demo guard as the
  workflow engine); such comments record `SKIPPED` ("demo mode").

## Matching modes

| Mode | Meaning | Example (keyword `link`) |
|---|---|---|
| `contains` (default) | Keyword appears anywhere in the comment | "please send link" ✓ |
| `exact` | Whole comment (trimmed) equals the keyword | "link" ✓, "link please" ✗ |
| `startsWith` | Comment (leading whitespace trimmed) begins with the keyword | "link please!" ✓ |

- Matching is **case-insensitive by default**; enable *Case sensitive*
  for exact-case matching.
- Empty keywords never match (and rule validation rejects them).
- The **first matching keyword in rule order** is recorded on the event
  and used for `{{keyword}}` personalization.

## Eligibility windows (Meta's rules, enforced here)

- **One private reply per comment.** After a private reply is sent,
  `Comment.privateRepliedAt` is stamped; any later processing of the
  same comment for any rule records `SKIPPED` ("already replied").
  Note: the per-rule dedupe below also blocks a second attempt for the
  same rule.
- **7-day window.** A private reply is allowed only while
  `privateReplyEligibleUntil` (= comment time + 7 days) is in the
  future. After expiry, Meta returns error 551; this module checks the
  window *before* sending and records `SKIPPED` ("window expired")
  instead of attempting a doomed call.
- The public comment reply uses the official
  `POST /{comment-id}/replies` endpoint; the DM uses the official
  `POST /{comment-id}/private_replies` endpoint — the same path the
  workflow engine's `action.reply_comment` uses. (Implementation note:
  the engine's reply path *is* the private-reply path, so it is reused
  for the DM only — reusing it for the public reply as well would send
  two private replies and violate the one-reply rule.)

## Dedupe guarantees

- `CommentDmEvent @@unique([workspaceId, ruleId, commentId])`: one event
  row per comment per rule, ever.
- Before sending, the processor checks for an existing event for the
  triple; if one exists, the redelivery is suppressed (`duplicate: true`,
  no second send) and the suppression is noted on the original event's
  actions JSON (this is what per-rule analytics counts as
  `duplicatesPrevented`).
- The unique constraint is the backstop for truly concurrent
  double-delivery: a violation is caught and reported as a duplicate,
  never as an error to the webhook.
- Non-matching comments produce **no event** — the history stays a
  record of actions taken, not noise from every comment on a post.
  (Per-rule analytics therefore defines `comments` as matched comments
  processed; see below.)
- A matcher failure never breaks webhook ingestion: the ingest hook
  wraps the processor call in try/catch and continues.

## Dry-run mode

- `dryRun: true` rules record a `DRY_RUN` event per matching comment
  and call no provider endpoint.
- Dry-run events still obey dedupe (a redelivered comment does not
  create a second `DRY_RUN` event).
- Toggle per rule from the UI or via `PATCH /api/comment-dm/rules/[id]`
  (`{ dryRun: true|false }`); `enabled` toggles the same way.

## Personalization — and what is never invented

DM and comment-reply templates support exactly two variables:

- `{{name}}` — the name from the **verified Contact record** linked to
  the comment. If no Contact record exists, it renders as empty — the
  module never invents a name from a username guess or any other source.
- `{{keyword}}` — the matched keyword, in the form stored on the rule.

Any other `{{placeholder}}` is left untouched in the outgoing text.
Nothing else from the comment, the profile, or anywhere else is
injected into a message.

## Event history & analytics

- `GET /api/comment-dm/rules/[id]/events` — per-rule history
  (`DRY_RUN | SENT | FAILED | SKIPPED`), newest first, with the
  `actions` JSON (`comment_reply` / `private_reply` / `dry_run` /
  `skipped` / `duplicate_suppressed` steps) and the sanitized provider
  error on failures. Provider errors are passed through
  `sanitizeMetaResponseForLog` before storage — **tokens never land in
  event records or logs**.
- `GET /api/comment-dm/analytics` — per-rule breakdown:
  `{ comments, matches, sent, failed, dryRuns, skipped,
  duplicatesPrevented, replyRate }`, where `replyRate = sent / comments
  × 100` (null when no comments). The existing
  `/api/analytics/comment-to-dm` route is untouched.

## API

| Route | Access | Purpose |
|---|---|---|
| `GET /api/comment-dm/rules?integrationId=` | Member | List rules (workspace-scoped, optional account filter) |
| `POST /api/comment-dm/rules` | MANAGER+ | Create a rule |
| `GET /api/comment-dm/rules/[id]` | Member | One rule |
| `PATCH /api/comment-dm/rules/[id]` | MANAGER+ | Edit / enable / dry-run toggles |
| `DELETE /api/comment-dm/rules/[id]` | MANAGER+ | Delete (events cascade) |
| `GET /api/comment-dm/rules/[id]/events` | Member | Execution history |
| `GET /api/comment-dm/media?integrationId=` | MANAGER+ | Post/Reel picker; no param → account list |
| `GET /api/comment-dm/analytics` | Member | Per-rule breakdown |

## What the official API does NOT permit

- **Unrestricted DMs.** You cannot DM arbitrary users. A private reply
  is only allowed as a reply to a comment on your own media, once, and
  within 7 days. This module cannot — and does not try to — message
  anyone outside that window.
- **Repeated replies.** One private reply per comment, enforced by the
  `privateRepliedAt` stamp and the per-rule dedupe.
- **Replies after expiry.** After 7 days the window is closed; the
  module records `SKIPPED` instead of calling the API.
- **Scraping or unofficial access.** No scraping, no browser
  automation, no unofficial endpoints, no session cookies anywhere in
  this module — only the documented Graph endpoints above, with the
  account's official OAuth token.

## Files

- `src/lib/comment-dm/rules.ts` — Zod validation + serialization
- `src/lib/comment-dm/match.ts` — pure keyword matcher
- `src/lib/comment-dm/media.ts` — official media listing (no prior
  helper existed; this adds one on the `igGraph` pattern)
- `src/lib/comment-dm/process.ts` — rule evaluation, eligibility,
  sends, dedupe, event recording
- `src/app/api/comment-dm/**` — rules, events, media, analytics routes
- `src/app/app/comment-to-dm/page.tsx` — module UI
- `src/lib/analytics/queries.ts` — appended `commentDmRuleAnalytics`
  only (existing functions untouched)
- `src/lib/integrations/ingest.ts` — one guarded call after Comment
  creation (the only shared-file change)
