import { GuidePage, type GuideSection } from "../guide";

export const metadata = { title: "Troubleshooting — FlowPilot AI Docs" };

const UPDATED = "2026-10-19";

const sections: GuideSection[] = [
  {
    heading: "Login problems",
    blocks: [
      {
        kind: "ul",
        items: [
          "“Invalid email or password”: check for typos, Caps Lock, or extra whitespace (pasted passwords often carry a trailing space). Use the show/hide password toggle to verify what you typed.",
          "HTTP 429 on login: you hit the rate limit — 10 failed attempts per 10 minutes per IP + email. Wait and try again; do not hammer the endpoint.",
          "In development, failed logins write a diagnostic line ([auth] failed login) with the email and which check failed — the password is never logged.",
        ],
      },
    ],
  },
  {
    heading: "Instagram / Meta OAuth errors",
    blocks: [
      {
        kind: "table",
        head: ["Symptom", "Likely cause", "Fix"],
        rows: [
          ["“Invalid Scopes” in Meta's dialog", "App state, not the scope names", "Keep the app in Development mode; add each permission under App Review → Permissions and Features; the connecting user needs a role on the app or be a test user."],
          ["“Invalid platform app” at token exchange", "INSTAGRAM_APP_ID missing — the code fell back to the Facebook App ID", "Set INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET to the distinct Instagram app credentials."],
          ["“No access_token in Meta response”", "Unexpected token response shape", "Fixed in the current build (tolerant parsing + sanitized diagnostics). If it persists, send the [instagram-login] server log lines — they include HTTP status and a redacted body preview, never secrets."],
          ["Callback redirects with ?meta_error=…", "Denied, invalid state, exchange or persistence failure", "The Integrations page now surfaces the error on the provider card. Re-run the flow and read the card message."],
        ],
      },
    ],
  },
  {
    heading: "Webhooks not arriving",
    blocks: [
      {
        kind: "ol",
        items: [
          "Confirm APP_PUBLIC_URL is a public HTTPS URL — Meta cannot reach localhost.",
          "Confirm the verify token in the Meta dashboard exactly equals META_VERIFY_TOKEN (it is a string you invent, e.g. openssl rand -hex 16).",
          "Confirm you subscribed to the needed fields: messages, messaging_postbacks, messaging_referrals, feed.",
          "Check the server log for the webhook route: signature mismatches (HMAC-SHA256) are rejected with 403 and logged without secrets.",
        ],
      },
    ],
  },
  {
    heading: "Messages not sending",
    blocks: [
      {
        kind: "ul",
        items: [
          "WhatsApp free-form message rejected with 422: the 24-hour customer-service window closed. Send an approved template instead.",
          "Comment-to-DM skipped: one reply per comment, and comments older than 7 days are ineligible (Meta error 551). Check the eligibility verdict on the skipped item.",
          "Status NEEDS_ATTENTION on the integration: the token expired or was revoked — reconnect the channel.",
          "Email campaign steps: email has no delivery provider wired. These are simulated and logged, never delivered.",
        ],
      },
    ],
  },
  {
    heading: "What to include when reporting a bug",
    blocks: [
      {
        kind: "ul",
        items: [
          "The exact steps, what you expected, and what happened instead.",
          "The relevant server log lines ([auth], [instagram-login], webhook route) — they are sanitized by design.",
          "Your app version (see /api/health) and the workspace plan.",
          "Never paste: passwords, tokens, app secrets, cookies, authorization codes, or full OAuth state values.",
        ],
      },
    ],
  },
];

export default function TroubleshootingPage() {
  return (
    <GuidePage
      slug="troubleshooting"
      title="Troubleshooting"
      desc="Fix the most common connection, webhook, and messaging problems."
      updated={UPDATED}
      sections={sections}
      related={[
        { slug: "integration-setup", title: "Integration setup" },
        { slug: "support", title: "Support" },
      ]}
    />
  );
}
