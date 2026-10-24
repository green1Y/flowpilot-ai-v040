import { GuidePage, type GuideSection } from "../guide";

export const metadata = { title: "Permissions & platform limitations — FlowPilot AI Docs" };

const UPDATED = "2026-10-19";

const sections: GuideSection[] = [
  {
    heading: "Messaging windows",
    blocks: [
      {
        kind: "table",
        head: ["Channel", "Rule", "What FlowPilot enforces"],
        rows: [
          ["Instagram", "24-hour standard messaging window", "Eligibility verdict before every send; outside-window free-form sends are blocked."],
          ["Facebook Messenger", "24-hour standard window; promotional content outside needs approved message tags", "Same eligibility gate as Instagram."],
          ["WhatsApp", "24-hour customer-service window; business-initiated conversations REQUIRE pre-approved templates", "Free-form send outside the window → HTTP 422 unless a template is supplied."],
          ["TikTok", "No messaging API exists", "No send path is offered; the integration is identity-only."],
        ],
      },
    ],
  },
  {
    heading: "Comment-to-DM limits",
    blocks: [
      {
        kind: "ul",
        items: [
          "Instagram and Facebook only — private replies do not exist on WhatsApp.",
          "Exactly one private reply per comment; repeats are blocked.",
          "Comments older than 7 days are automatically excluded (Meta error 551 beyond that).",
          "Requires the comment scopes: instagram_business_manage_comments and pages_read_engagement.",
        ],
      },
    ],
  },
  {
    heading: "Opt-in and consent",
    blocks: [
      {
        kind: "ul",
        items: [
          "WhatsApp: opt-in is required before messaging a customer (Meta policy).",
          "Retargeting email steps: the contact needs an email address AND recorded marketing consent — and even then, email is simulated (no delivery provider is wired).",
          "Suppression is universal: opted-out contacts are excluded from every campaign type, always.",
          "Retargeting frequency cap: default 1 send per contact per day across all FlowPilot outbound (configurable per campaign).",
        ],
      },
    ],
  },
  {
    heading: "Paid ads — what FlowPilot does NOT do",
    blocks: [
      {
        kind: "p",
        text: "The paid_ad retargeting type is an honest export workflow: launch produces the Meta setup checklist plus a consent-flagged CSV for manual import into Ads Manager. No ads, audiences, or ad IDs are ever created or fabricated in FlowPilot. Activating the Meta Marketing API is a documented manual checklist, not a button.",
      },
    ],
  },
  {
    heading: "Roles (RBAC)",
    blocks: [
      {
        kind: "table",
        head: ["Capability", "Required role"],
        rows: [
          ["Publish / activate a workflow", "MANAGER or higher"],
          ["Launch a retargeting campaign (explicit confirm)", "MANAGER or higher"],
          ["Pause / resume / stop a campaign", "MANAGER or higher"],
          ["Inbox and analytics", "Role-gated per route; read-only roles cannot mutate"],
        ],
      },
      {
        kind: "note",
        title: "Known gap",
        text: "Some inbox conversation routes still lack AGENT+ gates — flagged as a follow-up. If a route lets a read-only role mutate state, treat it as a bug and report it.",
      },
    ],
  },
  {
    heading: "Simulated providers",
    blocks: [
      {
        kind: "p",
        text: "Telegram, YouTube, LinkedIn, X, email, webchat, Sheets, and Zapier have no real OAuth or API integration. Their connect flow is a mock handshake, the UI labels them Simulated, and any “send” through them is mock-backed — never presented as delivered.",
      },
    ],
  },
];

export default function PermissionsPage() {
  return (
    <GuidePage
      slug="permissions-limitations"
      title="Permissions & platform limitations"
      desc="What each platform allows: messaging windows, templates, scopes, and hard limits."
      updated={UPDATED}
      sections={sections}
      related={[
        { slug: "integration-setup", title: "Integration setup" },
        { slug: "comment-to-dm", title: "Comment-to-DM setup" },
      ]}
    />
  );
}
