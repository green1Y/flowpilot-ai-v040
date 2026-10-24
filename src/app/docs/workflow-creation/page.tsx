import { GuidePage, type GuideSection } from "../guide";

export const metadata = { title: "Workflow creation — FlowPilot AI Docs" };

const UPDATED = "2026-10-19";

const sections: GuideSection[] = [
  {
    heading: "The builder",
    blocks: [
      {
        kind: "p",
        text: "Automations in the sidebar opens the workflow list; the builder is a visual node graph (trigger → conditions → actions). Every node type is validated against the node registry before a workflow can be published — invalid graphs are rejected with the specific errors, not a generic failure.",
      },
    ],
  },
  {
    heading: "Start from a template",
    blocks: [
      {
        kind: "p",
        text: "The gallery ships 15 templates whose nodes and edges are valid per the node registry, so they can be opened in the builder immediately:",
      },
      {
        kind: "ul",
        items: [
          "Instagram comment-to-DM, Facebook comment response",
          "FAQ auto-responder, product inquiry assistant, price & availability inquiry",
          "Lead qualification, website chat lead capture, appointment routing",
          "Support triage, WhatsApp support, human handoff, team lead notification",
          "Order status assistant, unanswered follow-up, feedback collection",
        ],
      },
      {
        kind: "p",
        text: "Each template lists its required integrations and permissions plus a publish checklist and known limitations — read those before activating.",
      },
    ],
  },
  {
    heading: "Simulate before you activate",
    blocks: [
      {
        kind: "p",
        text: "Simulate mode performs a side-effect-free walk of your workflow graph: no messages are sent, no contacts are modified. Run it with the sample event presets to see exactly which path a real event would take. A workflow that fails simulation will fail live — fix it first.",
      },
      {
        kind: "note",
        title: "Honesty note",
        text: "Simulation proves logic, not delivery. It cannot confirm that Meta will accept a message — only a real send through a CONNECTED channel can, and those are logged with their provider response.",
      },
    ],
  },
  {
    heading: "Publishing (going live)",
    blocks: [
      {
        kind: "ol",
        items: [
          "Publishing requires a MANAGER role or higher in the workspace.",
          "The graph is validated; invalid workflows are rejected with HTTP 422 and the error list.",
          "Published workflows react to real triggers. Drafts never execute — executing a DRAFT returns HTTP 409 with the actual reason.",
        ],
      },
      {
        kind: "note",
        title: "Never automatic",
        text: "FlowPilot never publishes or activates a workflow on its own — not from a template, not from onboarding, not from an import. Activation always requires an explicit human confirmation.",
      },
    ],
  },
  {
    heading: "AI replies and escalation",
    blocks: [
      {
        kind: "p",
        text: "AI steps are grounded in your uploaded knowledge base (chunked documents, retrieval with citations). When the AI is unsure, the conversation is queued for human review in the escalation queue instead of guessing. Human takeover in the inbox pauses automation for that conversation.",
      },
    ],
  },
];

export default function WorkflowCreationPage() {
  return (
    <GuidePage
      slug="workflow-creation"
      title="Workflow creation"
      desc="Build automations with the visual builder, templates, and Simulate mode."
      updated={UPDATED}
      sections={sections}
      related={[
        { slug: "comment-to-dm", title: "Comment-to-DM setup" },
        { slug: "permissions-limitations", title: "Permissions & platform limitations" },
      ]}
    />
  );
}
