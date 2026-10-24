# Retargeting Center — Setup Guide

Phase B of FlowPilot AI. The Retargeting Center lives at **Retargeting** in the
sidebar (`/app/retargeting`) and covers five campaign types. Four of them run
inside FlowPilot; the fifth (`paid_ad`) is an honest export workflow because
FlowPilot does **not** create ads or audiences in Meta.

## The five campaign types

| Type | What it does | Delivery reality |
|---|---|---|
| `dm_reengagement` | DM win-back via Instagram / Facebook / WhatsApp | Real send pipeline (`sendFollowUp`). Without CONNECTED provider credentials the adapter is mock-backed — sends are labeled **mocked**, never presented as delivered. |
| `comment_to_dm` | Private reply to recent commenters | Instagram/Facebook only. Meta rule: one private reply per comment, within 7 days (error 551 after). Enforced by `checkEligibility`. |
| `email` | Re-engage by email | **SIMULATED.** No email delivery provider is wired in this platform. Eligible recipients (email + marketing consent, not suppressed) are *logged*, never delivered. Do not report these as sent. |
| `crm_sequence` | Owner-worked follow-up tasks | No automatic send. Each step is recorded as a CRM task (`campaign_interaction` event). |
| `paid_ad` | Build a Meta Custom Audience | **Export only.** Launch returns the Meta setup checklist + a consent-flagged CSV for manual import into Ads Manager. No ads, audiences, or ad IDs are ever created or fabricated here. |

## Per-type requirements

**All types**
- An **audience segment** (Retargeting → Audiences). Conditions evaluate
  against real data: contact tags/channel/leadStatus, inbound message history,
  suppression list, ContactOrder rows, and contact custom fields.
- **Suppression is universal**: opted-out contacts are excluded from every
  type, always.
- **Frequency cap** (default 1 send/contact/day, configurable per campaign)
  counts all FlowPilot outbound in the trailing 24h.
- **Explicit confirmation**: launching requires `{ confirmed: true }`, plus
  the in-UI confirmation checkbox. MANAGER role or higher.

**`dm_reengagement`**
- Channel contact identity must exist (PSID / IGSID / WhatsApp number).
- Freeform DMs require an inbound message within the last 24h
  (per Meta's messaging window). Outside the window, use a WhatsApp
  **approved template** (`messageType: "template"`) — WhatsApp only.
- Needs a CONNECTED Instagram/Facebook/WhatsApp integration for real
  delivery; otherwise sends are mock-backed and labeled as such.

**`comment_to_dm`**
- Requires recent comments ingested via the comments webhook
  (Instagram + Facebook only — private replies don't exist on WhatsApp).
- Each comment gets at most one private reply; comments older than 7 days
  are excluded automatically.

**`email`**
- Contact needs an email address **and** recorded marketing consent
  (`consent.email` or `consent.marketing` = true).
- Simulated — wire a real email provider before treating these as delivered.

**`crm_sequence`**
- Nothing to configure. Steps are logged as tasks; owners work them manually.

**`paid_ad`**
- Contacts need an email or phone **and** marketing consent to be exported.
- Launch produces: (1) the Meta setup checklist, (2) the audience CSV.
  Import the CSV in Ads Manager → Audiences → Custom Audience → Customer list.

## Paid ads — Meta Marketing API activation checklist

FlowPilot does not call the Marketing API today. When you're ready to move
beyond CSV export, each item below must be true:

1. **Meta ad account ID** — the `act_<ID>` that will own the campaign
   (Ads Manager → Account settings).
2. **`ads_management` permission** — granted to your Meta app / system user
   on that ad account. Without it, Custom Audience API calls fail.
3. **Business verification** — Business Settings → Security Center. Meta
   won't deliver ads for unverified businesses.
4. **Billing method** — a valid payment method on the ad account.
5. **Custom Audience terms** — accepted in Ads Manager (Audiences) before
   uploading customer lists.
6. **Consent basis** — FlowPilot only exports consenting, non-suppressed
   contacts. Keep your own proof-of-consent records.
7. **Pixel / Conversions API** (recommended) — required later to report real
   conversions and ROAS back into FlowPilot. Without it, the report shows
   spend/ROAS as **not tracked** — revenue is never invented.

## Reporting honesty

Every report metric carries a source label:

- `measured` — read from real rows (attempts, failures, attributed clicks/conversions).
- `estimated` — heuristic (replies = inbound messages from campaign contacts
  after launch; approximate, not provably caused by the campaign).
- `not_tracked` — no data source exists. **Spend and ROAS are always
  "not tracked"** until a Meta Marketing API / Conversions API integration
  lands. Check Ads Manager for real spend.

## Dry runs

Tick **Dry run** in the wizard (recommended for first launches). Launch +
process rehearse the entire flow — recipient building, eligibility,
scheduling, reporting — without calling any adapter. Dry-run activity is
labeled `simulated` in events and the report.
