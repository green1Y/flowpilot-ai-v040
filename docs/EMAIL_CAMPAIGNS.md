# Email Campaigns (Wave 2E)

Email is a campaign channel alongside Instagram, Facebook, and WhatsApp —
with one deliberate difference in how it is processed (see "Processing
route" below).

## Prerequisites (Resend)

Email sending and the health probe require both of these environment
variables:

- `RESEND_API_KEY` — a Resend API key.
- `EMAIL_FROM` — the sender identity, e.g. `FlowPilot <noreply@yourdomain.com>`.

Resend requires the sender domain to be verified in your Resend account
before it will accept mail from it. If either variable is unset, every
email send fails honestly with code `EMAIL_NOT_CONFIGURED` — nothing is
ever reported as sent when no provider is configured, and no fake
success is ever recorded.

Related env vars (shared with the rest of the app):

- `ENCRYPTION_KEY` — also signs unsubscribe tokens (see below). Keep it
  stable: rotating it invalidates every unsubscribe link already sent.
- `NEXT_PUBLIC_SITE_URL` (fallback `NEXT_PUBLIC_APP_URL`) — the public
  origin used to build unsubscribe links in outgoing mail.

## Creating an email campaign

Create a campaign with `channel: "email"` (the campaign schema accepts
any channel string; there is no zod channel enum to extend). The message
body comes from:

1. The linked `MessageTemplate` body when `templateId` is set (the row
   must exist in the same workspace, else processing fails with 422), or
2. The campaign `message` JSON `{ text, subject? }` otherwise.

`subject` in the message JSON wins when set; otherwise the campaign
name is the subject.

> **Known gap (not covered by this wave):** the shared recipient
> builder (`buildRecipients`, used by the recipients route) only accepts
> the Meta messaging channels, so an email campaign's recipient list
> cannot currently be built through that route. The process route below
> handles any `PENDING` recipient rows that exist; wiring an email
> branch into the shared builder is follow-up work for the coordinator
> (it touches the shared campaign engine).

## Processing route

Email campaigns are processed by a dedicated route, not the shared one:

```
POST /api/campaigns/[id]/process-email   (MANAGER+)
Body: { "batchSize": 25 }                (optional, 1–200, default 25)
```

Why separate: the shared `/process` route delegates to
`processCampaign()`, whose channel gate only accepts instagram /
facebook / whatsapp and whose eligibility engine is built around the
24h messaging window and Meta identities. Widening that engine for
email would change behavior for the messaging channels, so this route
implements the same batch semantics for email only: MANAGER+ role,
campaign must be `RUNNING`, `PENDING` recipients oldest-first, rate cap
`sleep(1000 / ratePerSecond)` between sends, one bad recipient never
stops the batch, campaign completes when no `PENDING` recipients
remain, and the same `campaign.batch_processed` / `campaign.completed`
audit events as the shared route.

The shared `/process` route is untouched: its instagram / facebook /
whatsapp branches behave byte-identically to before.

## Sending: `src/lib/email/campaign.ts`

`sendCampaignEmail({ workspaceId, campaign, recipient, templateBody,
variables, subject?, baseUrl? })` runs, in order:

1. **Suppression check.** A `Suppression` row for channel `"email"` or
   for all channels (`channel: null`) returns `{ skipped: true, reason }`
   and no provider call is made. A suppression for another channel does
   not block email.
2. **Address check.** A contact with no email address is `SKIPPED`
   ("contact has no email address"), never sent.
3. **Demo-mode guard.** `assertLiveSendAllowed(workspaceId)` runs before
   any provider call; its 403 `Response` propagates so a policy block
   stops the batch loudly instead of recording fake failures.
4. **Template rendering** (see below) + unsubscribe footer.
5. **Resend send** via the existing `getEmailSender()` / Resend adapter.
   Returns `{ accepted: true, providerMessageId }` or
   `{ accepted: false, error }` (with `code: "EMAIL_NOT_CONFIGURED"`
   when unconfigured).

### Template variables

Only verified contact fields are substituted — never invented data:

| Variable | Source |
|---|---|
| `{{name}}` | Contact name |
| `{{firstName}}` | First token of the name |
| `{{company}}` | Contact company (`customFields.company` when a string) |
| `{{email}}` | Contact email |

A missing field renders as an empty string. Unknown `{{variables}}` are
left untouched so typos stay visible instead of silently disappearing.
Rendered values are HTML-escaped before being placed in the email, so a
contact name can never inject markup.

The `variables` argument is accepted for forward compatibility but is
restricted to the allowlist above — caller-supplied values for other
keys are ignored.

### Accepted vs. delivered — read this before reporting

**An email accepted by Resend's API is ACCEPTED, never "delivered".**
A `SENT` recipient row means Resend returned success for the send
request. It says nothing about inbox placement, opens, or clicks.
No delivery or open tracking is claimed anywhere in this wave, and **no
Resend webhooks are implemented** — do not accept unverified webhooks
as delivery evidence.

## Unsubscribe: suppression that actually suppresses

Every campaign email ends with an unsubscribe footer linking to:

```
GET /api/unsubscribe?token=<signed token>
```

Tokens (`src/lib/email/unsubscribe.ts`) are
`base64url(payload).base64url(HMAC-SHA256(payload))` over
`{ workspaceId, contactId, channel: "email" }`, signed with
`ENCRYPTION_KEY` — no new secret env var. Verification uses a
timing-safe comparison; any invalid token (malformed, tampered, wrong
channel) gets the same generic 400 page, with no detail leaked.

On a valid token the route (no login required — the token is the
authorization, and it grants exactly one thing):

- Upserts a `Suppression` row (`channel: "email"`, reason "unsubscribed
  via email link"), and
- Writes one `OPTED_OUT` `ConsentRecord` (`source: "unsubscribe"`,
  deduped so repeat clicks add no duplicate rows).

Because the campaign sender checks suppression before every send, an
unsubscribed contact is excluded from all later email campaigns — the
unsubscribe is enforced by the send path, not just recorded. A valid
token for a contact that no longer exists still returns the
confirmation page (nothing is left to email, and the page must not
oracle contact existence).

## Resend health probe

```
GET /api/email/health   (MANAGER+)
```

- Unconfigured (`RESEND_API_KEY` or `EMAIL_FROM` unset) →
  `{ configured: false, code: "EMAIL_NOT_CONFIGURED" }`.
- Otherwise a safe read-only check: `GET https://api.resend.com/domains`
  with the Bearer key and a 20s timeout. Listing domains validates the
  key without sending anything.
  - 2xx → `{ configured: true, reachable: true, domainsCount }` and a
    `HealthCheck` row (`probe: "config"`, status `OK`,
    `integrationId: "email"`).
  - Failure → `{ configured: true, reachable: false, error }` (sanitized
    provider message, bounded to 300 chars) and a `HealthCheck` row with
    status `FAILED`.

The key is never logged and never returned, and `HealthCheck.detail`
contains only sanitized fields. This probe covers configuration and
reachability only — never delivery or open tracking.

## Tests

Colocated `*.test.ts` files (run by the coordinator's serial suite;
not run in this wave because parallel waves share `test.db`):

- `src/lib/email/campaign.test.ts` — suppression (email / all-channel /
  other-channel), missing address, unconfigured honesty, provider
  failure, template rendering, footer token verification.
- `src/lib/email/unsubscribe.test.ts` — token round-trip, tamper
  rejection, garbage input, URL construction.
- `src/app/api/unsubscribe/route.test.ts` — valid token suppresses +
  idempotent repeat click; invalid/missing token → generic 400.
- `src/app/api/email/health/route.test.ts` — unconfigured, 2xx, provider
  error, network failure; key never in responses or HealthCheck rows.
- `src/app/api/campaigns/[id]/process-email/route.test.ts` — per-recipient
  SENT/SKIPPED/FAILED mapping, completion, batchSize, 422 guards.
