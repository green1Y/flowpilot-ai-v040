import { GuidePage, type GuideSection } from "../guide";

export const metadata = { title: "Integration setup — FlowPilot AI Docs" };

const UPDATED = "2026-10-19";

const sections: GuideSection[] = [
  {
    heading: "Real vs. simulated — read this first",
    blocks: [
      {
        kind: "table",
        head: ["Provider", "Connection reality", "What works"],
        rows: [
          ["Instagram", "REAL OAuth (Instagram Business Login)", "Messaging, comment replies, comment-to-DM, webhooks"],
          ["Facebook Messenger", "REAL OAuth (Facebook Login)", "Page messaging, comment replies, webhooks"],
          ["WhatsApp Business", "REAL OAuth + manual token", "Messaging with 24h window + templates, webhooks"],
          ["TikTok", "REAL OAuth (Login Kit)", "Identity only — TikTok exposes no DM-sending API"],
          ["Telegram, YouTube, LinkedIn, X, email, webchat, Sheets, Zapier", "SIMULATED handshake", "Mock behavior only — never touches the real service"],
        ],
      },
      {
        kind: "note",
        title: "Honesty note",
        text: "Nothing in this environment has ever been live-tested: no provider credentials exist here, so no real OAuth, token, or API call has been made from this build. “Tested” in our notes means verified with mocked-HTTP unit and route tests. Your own credentials make the real flows work — the code paths are identical.",
      },
    ],
  },
  {
    heading: "Instagram (Business Login)",
    blocks: [
      {
        kind: "ul",
        items: [
          "Requires an Instagram Professional (Business or Creator) account. In the current flow it connects directly — no Page picker step.",
          "Scopes: instagram_business_basic, instagram_business_manage_messages, instagram_business_manage_comments (the old instagram_basic / instagram_manage_* scopes were deprecated by Meta on 2025-01-27).",
          "Environment: INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET (distinct from the Facebook App ID — mixing them causes Meta's “Invalid platform app” error).",
          "Token handling: long-lived tokens, refreshed automatically near expiry. Error 190 flips the status to NEEDS_ATTENTION.",
        ],
      },
    ],
  },
  {
    heading: "Facebook Messenger (Facebook Login)",
    blocks: [
      {
        kind: "ul",
        items: [
          "Requires a Facebook Page; after OAuth you bind the specific Page.",
          "Scopes: pages_messaging, pages_show_list, pages_read_engagement.",
          "Standard Meta messaging window applies; promotional content outside the window needs approved message tags.",
        ],
      },
    ],
  },
  {
    heading: "WhatsApp Business Platform",
    blocks: [
      {
        kind: "ul",
        items: [
          "Two connect paths: Meta OAuth, or a manual system-user token (verified server-side via phone-number lookup before CONNECTED).",
          "Scopes: whatsapp_business_messaging, whatsapp_business_management.",
          "24-hour customer-service window is enforced in the send path: free-form messages outside the window are rejected (422) unless you send an approved template.",
          "Opt-in is required before messaging a customer — this is a Meta policy, not a FlowPilot choice.",
        ],
      },
    ],
  },
  {
    heading: "TikTok (Login Kit)",
    blocks: [
      {
        kind: "ul",
        items: [
          "Scope: user.info.basic (identity only). TikTok exposes no general DM-sending API, so the catalog no longer claims messaging capabilities.",
          "CONNECTED is written only after token exchange + identity fetch + encrypted persistence all succeed. Any failure redirects with a safe error message — never a half-connected state.",
          "Disconnect revokes the token at TikTok (best-effort) before wiping local credentials.",
        ],
      },
    ],
  },
  {
    heading: "Meta app setup (all three Meta providers)",
    blocks: [
      {
        kind: "ol",
        items: [
          "Create a Business-type app at developers.facebook.com/apps; copy the App ID and App Secret into your .env (META_APP_ID, META_APP_SECRET) — never commit them.",
          "Add the Messenger, Instagram, and WhatsApp products to the app.",
          "Request the permissions listed above under App Review → Permissions and Features. In development mode, app roles and test users work without review; Live-mode apps need App Review (a few business days).",
          "Set the webhook callback URL to {APP_PUBLIC_URL}/api/webhooks/meta and the verify token to your META_VERIFY_TOKEN (a random string you invent). Subscribe to messages, messaging_postbacks, messaging_referrals, and feed.",
        ],
      },
      {
        kind: "note",
        title: "“Invalid Scopes” from Meta's OAuth dialog",
        text: "The scope names above are valid — the cause is app state, not the names. Keep the app in Development mode while testing, add each permission under App Review → Permissions and Features, and make sure the connecting user has a role on the app or is a registered test user.",
      },
    ],
  },
  {
    heading: "Simulated providers",
    blocks: [
      {
        kind: "p",
        text: "Telegram, YouTube, LinkedIn, X, email, webchat, Sheets, and Zapier run a generic mock handshake that records NEEDS_ATTENTION. It does not verify and does not mark CONNECTED. The UI labels these as Simulated. Notably: email has no delivery provider wired — email campaign steps are logged, never delivered.",
      },
    ],
  },
  {
    heading: "Disconnecting",
    blocks: [
      {
        kind: "p",
        text: "Disconnect revokes the provider token best-effort (Meta permission delete, TikTok revoke endpoint) and then wipes local credentials and identity. A failed revocation never blocks the local disconnect — your data is cleared regardless.",
      },
    ],
  },
];

export default function IntegrationSetupPage() {
  return (
    <GuidePage
      slug="integration-setup"
      title="Integration setup"
      desc="Connect Instagram, Messenger, WhatsApp, TikTok — and understand what's real vs. simulated."
      updated={UPDATED}
      sections={sections}
      related={[
        { slug: "permissions-limitations", title: "Permissions & platform limitations" },
        { slug: "troubleshooting", title: "Troubleshooting" },
      ]}
    />
  );
}
