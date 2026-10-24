import { GuidePage, type GuideSection } from "../guide";

export const metadata = { title: "Comment-to-DM setup — FlowPilot AI Docs" };

const UPDATED = "2026-10-19";

const sections: GuideSection[] = [
  {
    heading: "What it does",
    blocks: [
      {
        kind: "p",
        text: "Comment-to-DM sends a private reply to someone who commented on your post — for example, replying “sneakers” triggers a DM with the product link. It exists for Instagram and Facebook only: private replies do not exist on WhatsApp, and TikTok has no messaging API.",
      },
    ],
  },
  {
    heading: "Meta's rules (enforced automatically)",
    blocks: [
      {
        kind: "ul",
        items: [
          "One private reply per comment — a second attempt on the same comment is blocked.",
          "The comment must be recent: older than 7 days is excluded automatically (Meta returns error 551 after that).",
          "Replies must follow Meta's messaging policies; promotional abuse can restrict your app.",
        ],
      },
      {
        kind: "note",
        title: "Honesty note",
        text: "The eligibility checker (checkEligibility) evaluates every candidate before sending and records the verdict. Ineligible comments are skipped with a reason — never silently dropped, never sent anyway.",
      },
    ],
  },
  {
    heading: "Setup",
    blocks: [
      {
        kind: "ol",
        items: [
          "Connect Instagram and/or Facebook with the comment scopes: instagram_business_manage_comments (Instagram) and pages_read_engagement (Facebook). Without them, comments cannot be read.",
          "Make sure the webhook subscribes to the feed field so comments are ingested into FlowPilot as they happen.",
          "Start from the Instagram comment-to-DM or Facebook comment response template in Automations.",
          "Simulate first with a sample comment event, then publish (MANAGER+).",
        ],
      },
    ],
  },
  {
    heading: "Retargeting variant",
    blocks: [
      {
        kind: "p",
        text: "The Retargeting Center also offers a comment_to_dm campaign type for re-engaging recent commenters in bulk. The same one-reply-per-comment and 7-day rules apply, plus universal suppression and a per-contact frequency cap.",
      },
    ],
  },
];

export default function CommentToDmPage() {
  return (
    <GuidePage
      slug="comment-to-dm"
      title="Comment-to-DM setup"
      desc="Turn Instagram and Facebook comments into private conversations — within Meta's rules."
      updated={UPDATED}
      sections={sections}
      related={[
        { slug: "integration-setup", title: "Integration setup" },
        { slug: "workflow-creation", title: "Workflow creation" },
      ]}
    />
  );
}
