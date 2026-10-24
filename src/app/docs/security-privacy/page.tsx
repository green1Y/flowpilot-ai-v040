import { GuidePage, type GuideSection } from "../guide";

export const metadata = { title: "Security & privacy — FlowPilot AI Docs" };

const UPDATED = "2026-10-19";

const sections: GuideSection[] = [
  {
    heading: "Credential storage",
    blocks: [
      {
        kind: "ul",
        items: [
          "Provider tokens are encrypted with AES-256-GCM before being stored in the database. Plaintext credentials are never persisted.",
          "OAuth state values are HMAC-SHA256 signed, single-use, and expire after 15 minutes.",
          "Disconnecting revokes the provider token best-effort, then wipes local credentials and identity. A failed revocation never blocks the local wipe.",
        ],
      },
    ],
  },
  {
    heading: "What is (and isn't) logged",
    blocks: [
      {
        kind: "ul",
        items: [
          "Server logs are sanitized by design: HTTP status + redacted body previews, URLs stripped of query params. Secrets, tokens, passwords, cookies, authorization codes, and full OAuth state values are never logged.",
          "Failed logins log only the email and which check failed (user found / password valid) — never the password or its hash.",
          "Meta's token-exchange diagnostics redact access tokens from any logged response.",
        ],
      },
      {
        kind: "note",
        title: "Known and documented",
        text: "One LOW audit finding is intentionally left as-is: access_token appears in query strings on Meta GET requests (Meta's documented pattern). It never appears in our logs or error responses.",
      },
    ],
  },
  {
    heading: "Tenant isolation",
    blocks: [
      {
        kind: "ul",
        items: [
          "Every API route resolves the workspace through requireWorkspace: session + workspace membership. Requests for a workspace you are not a member of return 403 without revealing whether it exists.",
          "Role gates (requireRole) protect mutating routes; cross-workspace authorization is covered by regression tests.",
          "The onboarding progress API is keyed by (userId, workspaceId) — one user's progress is never visible to another.",
        ],
      },
    ],
  },
  {
    heading: "Sessions and rate limits",
    blocks: [
      {
        kind: "ul",
        items: [
          "Sessions are signed JWTs in httpOnly, SameSite=Lax cookies (Secure in production), 7-day expiry.",
          "Login is rate-limited: 10 failed attempts per 10 minutes per IP + email → HTTP 429.",
          "All provider API calls carry a 20-second timeout so a hung provider cannot hang the app.",
        ],
      },
    ],
  },
  {
    heading: "Webhooks",
    blocks: [
      {
        kind: "ul",
        items: [
          "The Meta webhook endpoint verifies the subscription challenge token and HMAC-SHA256-signs every inbound payload.",
          "Replayed deliveries are deduplicated; message IDs are idempotent on (workspaceId, providerEventId).",
        ],
      },
    ],
  },
  {
    heading: "Your responsibilities",
    blocks: [
      {
        kind: "ul",
        items: [
          "Keep your .env file private — it is never committed and release archives exclude it. Verify its values after every upgrade.",
          "Use a strong, unique META_VERIFY_TOKEN and APP_PUBLIC_URL over HTTPS.",
          "When reporting issues, never paste secrets — the troubleshooting guide lists exactly what is safe to share.",
        ],
      },
    ],
  },
];

export default function SecurityPage() {
  return (
    <GuidePage
      slug="security-privacy"
      title="Security & privacy"
      desc="How credentials are stored, what is logged, and how tenant data stays isolated."
      updated={UPDATED}
      sections={sections}
      related={[
        { slug: "api-configuration", title: "API configuration" },
        { slug: "troubleshooting", title: "Troubleshooting" },
      ]}
    />
  );
}
