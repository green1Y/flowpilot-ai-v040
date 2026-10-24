/**
 * Sample-event presets for workflow simulation.
 *
 * Pure constants — no imports, no database access — so this module is safe
 * to import from client components (the Automations builder) and tests.
 */

export interface SampleEventPreset {
  id: string;
  label: string;
  description: string;
  event: Record<string, unknown>;
}

export const SAMPLE_EVENT_PRESETS: SampleEventPreset[] = [
  {
    id: "new_message",
    label: "New message",
    description: "An inbound message from a contact on a messaging channel.",
    event: {
      type: "new_message",
      channel: "instagram",
      from: "sample_user",
      name: "Sample User",
      text: "Hi! How much does this cost?",
      conversationId: "",
      contactId: "",
      intent: "",
      tags: [],
      isNewContact: true,
      leadScore: 0,
    },
  },
  {
    id: "comment_received",
    label: "Comment received",
    description: "Someone comments on a post or video; may be eligible for a private reply.",
    event: {
      type: "new_comment",
      channel: "instagram",
      from: "sample_user",
      name: "Sample User",
      text: "I want this! How do I order?",
      commentId: "c_sample_123",
      commentEligible: true,
      conversationId: "",
      contactId: "",
    },
  },
  {
    id: "postback",
    label: "Postback (button tap)",
    description: "A contact taps a button or quick reply on Facebook Messenger.",
    event: {
      type: "new_message",
      channel: "facebook",
      from: "sample_user",
      name: "Sample User",
      text: "",
      postback: "GET_STARTED",
      conversationId: "",
      contactId: "",
    },
  },
  {
    id: "custom",
    label: "Custom JSON",
    description: "Start from a blank manual event and edit the JSON yourself.",
    event: {
      type: "manual",
    },
  },
];

export function getSampleEventPreset(id: string): SampleEventPreset | undefined {
  return SAMPLE_EVENT_PRESETS.find((p) => p.id === id);
}
