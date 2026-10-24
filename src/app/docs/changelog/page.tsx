import { GuidePage, type GuideSection } from "../guide";

export const metadata = { title: "Changelog — FlowPilot AI Docs" };

const UPDATED = "2026-10-19";

const sections: GuideSection[] = [
  {
    heading: "How to read this changelog",
    blocks: [
      {
        kind: "p",
        text: "Each entry says what shipped and how it was verified. “Verified” means typecheck-clean, the full test suite green, and a production build succeeding. “Not live-tested” means no provider credentials exist in the build environment, so real OAuth and provider API calls are exercised only with mocked HTTP until you connect your own credentials.",
      },
    ],
  },
  {
    heading: "Phase 4 — Onboarding, docs, monitoring (2026-10-19)",
    blocks: [
      {
        kind: "ul",
        items: [
          "Guided onboarding at /app/onboarding: 10 steps, resumable progress, skip-anywhere, explicit-confirm activation only.",
          "Public docs at /docs with 10 guides (this site).",
          "GET /api/health probe ({ ok, version, db, uptime }), backup/restore and recovery runbooks, npm audit report.",
          "Verified: typecheck clean, full test suite green including new health + onboarding progress tests.",
        ],
      },
    ],
  },
  {
    heading: "Phase 3 — Retargeting, analytics, simulation (2026-10-18)",
    blocks: [
      {
        kind: "ul",
        items: [
          "CustomerEvent unified event model, idempotent on (workspaceId, providerEventId).",
          "Retargeting Center: 5 campaign types; paid_ad is export-only (Meta checklist + CSV), never faked.",
          "Analytics rebuilt into 8 tabs from real DB data; spend/ROAS never invented.",
          "Workflow Simulate mode (side-effect-free graph walk); RBAC role gates + 20 authz tests.",
          "Verified: 405/405 tests, production build, live smoke test. Not live-tested: paid-ad creation, provider sends.",
        ],
      },
    ],
  },
  {
    heading: "Integrations hardening (2026-10-18)",
    blocks: [
      {
        kind: "ul",
        items: [
          "TikTok Login Kit: real OAuth, CONNECTED only after token exchange + identity + persistence succeed.",
          "Instagram scope corrections (instagram_business_*), strict INSTAGRAM_APP_ID/SECRET env handling, tolerant token-response parsing with sanitized diagnostics.",
          "Security audit fixes: single-use OAuth state, 20s provider timeouts, login rate limiting (10/10min → 429), best-effort token revocation on disconnect.",
          "Provider audit published (PROVIDER_AUDIT.md): real vs. simulated per provider.",
        ],
      },
    ],
  },
  {
    heading: "Platform upgrade, stages 0–4 (2026-10-17)",
    blocks: [
      {
        kind: "ul",
        items: [
          "Per-platform messaging eligibility checker, individual follow-ups with pre-send verdicts, bulk campaigns with per-recipient skip reasons.",
          "Inbox hardening (assignment, priorities, human takeover, REAL/DEMO badges), AI knowledge base with citations + escalation queue.",
          "SaaS plans (Starter/Growth/Agency) with server-side usage limits (402 PLAN_LIMIT_EXCEEDED).",
          "Real Meta integrations (Instagram, Messenger, WhatsApp): OAuth, webhook verification + HMAC + dedupe, encrypted token storage.",
          "Verified: 222/222 tests, production build. Not live-tested: no META_* credentials in the build environment.",
        ],
      },
    ],
  },
  {
    heading: "Phase 1–2 foundation (2026-10-17)",
    blocks: [
      {
        kind: "ul",
        items: [
          "Next.js 14 + TypeScript + Tailwind + Prisma/SQLite; workflow builder + engine; 11 app sections.",
          "Verified: 30/30 tests, clean build, headless-browser visual check, E2E mock automation.",
        ],
      },
    ],
  },
];

export default function ChangelogPage() {
  return (
    <GuidePage
      slug="changelog"
      title="Changelog"
      desc="What shipped in each phase, and what was verified vs. mocked."
      updated={UPDATED}
      sections={sections}
      related={[{ slug: "getting-started", title: "Getting started" }]}
    />
  );
}
