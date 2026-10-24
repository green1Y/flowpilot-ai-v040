import { GuidePage, type GuideSection } from "../guide";

export const metadata = { title: "API configuration — FlowPilot AI Docs" };

const UPDATED = "2026-10-19";

const sections: GuideSection[] = [
  {
    heading: "Is there a public API?",
    blocks: [
      {
        kind: "note",
        title: "Honesty note",
        text: "There is no public REST API with API keys in this version. The product is a server-rendered app authenticated with session cookies. Internal /api/* routes exist for the frontend; they are session-authenticated and workspace-scoped, not a documented third-party API.",
      },
    ],
  },
  {
    heading: "Environment variables",
    blocks: [
      {
        kind: "p",
        text: "All configuration lives in your own .env file (never committed; release archives exclude it). The full list with explanations is in .env.example. The important groups:",
      },
      {
        kind: "table",
        head: ["Variable", "Purpose"],
        rows: [
          ["DATABASE_URL", "SQLite file for local dev (file:./prisma/dev.db); PostgreSQL connection string for production."],
          ["JWT_SECRET", "Signs session tokens. Set a long random value; changing it signs everyone out."],
          ["SESSION_COOKIE", "Cookie name override (default fp_session)."],
          ["APP_PUBLIC_URL", "Your public base URL — used for OAuth redirects and webhook registration."],
          ["META_APP_ID / META_APP_SECRET", "Meta app credentials for Instagram, Messenger, WhatsApp."],
          ["INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET", "Distinct Instagram app credentials (Instagram Business Login)."],
          ["META_VERIFY_TOKEN", "Random string you invent; must match the Meta dashboard webhook verify token."],
          ["TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET", "TikTok Login Kit credentials."],
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
          "Meta inbound events: {APP_PUBLIC_URL}/api/webhooks/meta — HMAC-verified, replay-deduplicated.",
          "Register this URL in the Meta app dashboard with your META_VERIFY_TOKEN; subscribe to messages, messaging_postbacks, messaging_referrals, and feed.",
        ],
      },
    ],
  },
  {
    heading: "Health and operations",
    blocks: [
      {
        kind: "ul",
        items: [
          "GET /api/health returns { ok, version, db, uptime } — no auth, no secrets. Use it for load-balancer probes and uptime monitors; it returns 503 when the database is unreachable.",
          "Database: Prisma + SQLite locally. Apply schema changes with npx prisma db push (additive only) — never delete dev.db; see BACKUP_RESTORE.md in the project root for backup and restore procedures.",
          "Background jobs run on the in-process durable queue (src/lib/queue.ts) with retries, exponential backoff, and dead-letter handling. See RECOVERY.md for how to observe and restart them.",
        ],
      },
    ],
  },
];

export default function ApiConfigPage() {
  return (
    <GuidePage
      slug="api-configuration"
      title="API configuration"
      desc="Environment variables, webhooks, and what's (not) exposed as a public API."
      updated={UPDATED}
      sections={sections}
      related={[
        { slug: "security-privacy", title: "Security & privacy" },
        { slug: "integration-setup", title: "Integration setup" },
      ]}
    />
  );
}
