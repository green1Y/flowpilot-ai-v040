import { GuidePage, type GuideSection } from "../guide";

export const metadata = { title: "Getting started — FlowPilot AI Docs" };

const UPDATED = "2026-10-19";

const sections: GuideSection[] = [
  {
    heading: "Create your account",
    blocks: [
      {
        kind: "ol",
        items: [
          "Go to the sign-up page and enter your name, work email, a password (at least 8 characters), and a name for your workspace.",
          "After sign-up you land on the guided onboarding flow (/app/onboarding). It walks you through language & time zone, your use case, connecting a channel, reviewing permissions, creating a workflow, testing safely, activating, and measuring results.",
          "Every step can be skipped and resumed later — progress is saved automatically.",
        ],
      },
      {
        kind: "note",
        title: "Honesty note",
        text: "Signing in is rate-limited: 10 failed attempts per 10 minutes per IP + email returns HTTP 429. If you see “Invalid email or password”, check for typos, Caps Lock, or extra spaces before retrying.",
      },
    ],
  },
  {
    heading: "Connect your first channel",
    blocks: [
      {
        kind: "p",
        text: "Open Integrations in the sidebar. Instagram, Facebook Messenger, WhatsApp, and TikTok use real OAuth flows against the official provider APIs. Every other provider (Telegram, YouTube, LinkedIn, X, email, webchat, Sheets, Zapier) uses a clearly labeled simulated handshake — it never connects to the real service.",
      },
      {
        kind: "ul",
        items: [
          "A channel is only marked CONNECTED after a verification handshake succeeds — never on callback alone.",
          "If a token expires, the status flips to NEEDS_ATTENTION and you will be asked to reconnect.",
          "Test Connection on a real provider performs an authenticated identity call. It sends nothing.",
        ],
      },
    ],
  },
  {
    heading: "Build your first workflow",
    blocks: [
      {
        kind: "ol",
        items: [
          "Open Automations and browse the template gallery (15 templates: comment-to-DM, FAQ auto-responder, lead qualification, WhatsApp support, and more).",
          "Starting from a template pre-fills a valid workflow. It stays a DRAFT — drafts never send anything.",
          "Open the builder and run Simulate mode: a side-effect-free walk through your graph. Always simulate before activating.",
          "When you are ready, publish the workflow. Publishing requires a MANAGER role or higher and an explicit confirmation — FlowPilot never activates a workflow on its own.",
        ],
      },
    ],
  },
  {
    heading: "Measure real results",
    blocks: [
      {
        kind: "p",
        text: "The Overview and Analytics sections show real data only: measured sends, replies, and conversions from your database. Estimated metrics (spend, ROAS) are never invented — if tracking is unavailable, the dashboard says so instead of guessing.",
      },
    ],
  },
  {
    heading: "Plans and limits",
    blocks: [
      {
        kind: "p",
        text: "Workspaces run on Starter, Growth, or Agency plans. Usage limits (contacts, workflows, monthly sends) are enforced server-side: exceeding a limit returns HTTP 402 PLAN_LIMIT_EXCEEDED with an honest message instead of silently failing.",
      },
    ],
  },
];

export default function GettingStartedPage() {
  return (
    <GuidePage
      slug="getting-started"
      title="Getting started"
      desc="Create your account, connect a channel, and send your first automated reply."
      updated={UPDATED}
      sections={sections}
      related={[
        { slug: "integration-setup", title: "Integration setup" },
        { slug: "workflow-creation", title: "Workflow creation" },
      ]}
    />
  );
}
