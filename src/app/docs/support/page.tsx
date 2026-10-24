import { GuidePage, type GuideSection } from "../guide";

export const metadata = { title: "Support — FlowPilot AI Docs" };

const UPDATED = "2026-10-19";

const sections: GuideSection[] = [
  {
    heading: "Before you ask",
    blocks: [
      {
        kind: "ol",
        items: [
          "Check the troubleshooting guide — most connection, webhook, and messaging issues are covered there with exact fixes.",
          "Reproduce the problem once more and note the exact steps, what you expected, and what happened.",
          "Collect the safe diagnostics: the relevant server log lines ([auth], [instagram-login], webhook route), your app version from GET /api/health, and your workspace plan.",
        ],
      },
    ],
  },
  {
    heading: "What to include",
    blocks: [
      {
        kind: "ul",
        items: [
          "Steps to reproduce, expected vs. actual behavior.",
          "Sanitized log lines (they are redacted by design — status codes and safe previews only).",
          "Screenshots of the Integrations card state or the error shown in the UI.",
          "The guide you followed, if any, and where it diverged from what you saw.",
        ],
      },
      {
        kind: "note",
        title: "Never include",
        text: "Passwords, tokens, app secrets, cookies, authorization codes, or full OAuth state values. If a log line contains one, redact it before sending. Real secrets are never needed to diagnose a FlowPilot issue.",
      },
    ],
  },
  {
    heading: "Where to get help",
    blocks: [
      {
        kind: "ul",
        items: [
          "In-product docs: this site — start with getting started, integration setup, or troubleshooting.",
          "Onboarding: /app/onboarding walks through setup again any time; progress is saved per step.",
          "Operational runbooks in the project root: BACKUP_RESTORE.md (backups, restores, retention), RECOVERY.md (restarts, queue observability, dependency health).",
        ],
      },
    ],
  },
  {
    heading: "Response expectations",
    blocks: [
      {
        kind: "p",
        text: "Reports with reproduction steps and sanitized logs are answered fastest. Reports that include secrets will have the secrets redacted and may be delayed while the exposure is contained — when in doubt, leave the value out.",
      },
    ],
  },
];

export default function SupportPage() {
  return (
    <GuidePage
      slug="support"
      title="Support"
      desc="How to get help, report a bug, and what to include."
      updated={UPDATED}
      sections={sections}
      related={[
        { slug: "troubleshooting", title: "Troubleshooting" },
        { slug: "getting-started", title: "Getting started" },
      ]}
    />
  );
}
