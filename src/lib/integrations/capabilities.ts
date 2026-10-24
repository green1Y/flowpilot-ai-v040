/**
 * Capability matrix — per provider × capability, honest states.
 *
 * The matrix answers "what can this provider actually do right now?" It is
 * derived from TWO inputs:
 *   1. Platform truth: what the provider's API allows AND what FlowPilot
 *      actually implements (e.g. WhatsApp has no history API; Instagram
 *      private replies are 1-per-comment within 7 days; TikTok Login Kit
 *      offers identity only — no DM-sending API exists).
 *   2. Authorization state: the same capability resolves differently when
 *      the provider is connected vs. not connected vs. simulated (mock).
 *
 * A capability is only "available" when the integration row is CONNECTED
 * (real OAuth, verified). "limited" marks a platform window or permission
 * caveat the user must know about. "not_connected" means the wiring exists
 * but no live connection backs it. "simulated" means the mock adapter is
 * standing in — never mistaken for a real connection.
 *
 * Consumed by GET /api/integrations (per-card capability display).
 */

import type { ConnectionState } from "./connection-state";

/** The capabilities FlowPilot can surface, in display order. */
export const CAPABILITY_KEYS = [
  "read_events",
  "receive_comments",
  "send_messages",
  "publish_media",
  "manage_conversations",
  "retrieve_analytics",
  "manage_ads",
  "audience_conversion_data",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Resolved display state of one capability for one provider. */
export type CapabilityState =
  | "available" // works now — connected + provider supports it
  | "limited" // works with platform caveats (windows, templates, approvals)
  | "unavailable" // provider/API does not offer this, or FlowPilot does not implement it
  | "not_connected" // wiring exists but there is no live connection to back it
  | "simulated"; // the mock adapter stands in — demo only

/** Platform-level truth per provider × capability (before auth state). */
export type CapabilityLevel = "yes" | "limited" | "no";

export interface CapabilityTruth {
  level: CapabilityLevel;
  /** Honest, user-facing note explaining the level (why limited / why no). */
  note: string;
}

/**
 * Platform truth. "yes" means the provider API offers it AND FlowPilot has
 * a real implementation path; "no" means the API lacks it OR FlowPilot has
 * no implementation (both are stated in the note so the card never
 * over-promises). Sources: Meta Graph API v21.0 docs, WhatsApp Cloud API,
 * Instagram API (Business Login), TikTok Login Kit docs, plus the adapter
 * inventory in this repo (messenger.ts / instagram.ts / whatsapp.ts).
 */
export const PROVIDER_CAPABILITIES: Record<string, Record<CapabilityKey, CapabilityTruth>> = {
  instagram: {
    read_events: {
      level: "yes",
      note: "Message + comment webhooks are subscribed per-account at connect time.",
    },
    receive_comments: {
      level: "yes",
      note: "Comment webhooks feed the inbox; private replies are 1-per-comment within 7 days (Meta rule).",
    },
    send_messages: {
      level: "limited",
      note: "Standard 24h messaging window — free-form replies only within 24h of the user's last message.",
    },
    publish_media: {
      level: "no",
      note: "FlowPilot does not implement Instagram content publishing — DMs only, and media sends are not implemented (text-only sends).",
    },
    manage_conversations: {
      level: "yes",
      note: "Conversations read in the inbox; assignment, priorities and human takeover supported.",
    },
    retrieve_analytics: {
      level: "no",
      note: "Instagram Insights are not wired — FlowPilot reports from its own event log only.",
    },
    manage_ads: {
      level: "no",
      note: "Needs the Meta Marketing API + ad-account approval — not implemented (see Retargeting Center checklist).",
    },
    audience_conversion_data: {
      level: "no",
      note: "Conversions API / audience upload are not implemented.",
    },
  },
  facebook: {
    read_events: {
      level: "yes",
      note: "Page webhooks for messages and postbacks once the app is subscribed.",
    },
    receive_comments: {
      level: "yes",
      note: "Page feed webhooks; comment replies through the Page.",
    },
    send_messages: {
      level: "limited",
      note: "24h window for free-form replies; promotional content outside the window needs an approved message tag.",
    },
    publish_media: {
      level: "no",
      note: "FlowPilot does not implement Page post publishing — Messenger only, and media sends are not implemented (text-only sends).",
    },
    manage_conversations: {
      level: "yes",
      note: "Conversations read in the inbox; assignment, priorities and human takeover supported.",
    },
    retrieve_analytics: {
      level: "no",
      note: "Page Insights are not wired — FlowPilot reports from its own event log only.",
    },
    manage_ads: {
      level: "no",
      note: "Needs the Meta Marketing API + ad-account approval — not implemented (see Retargeting Center checklist).",
    },
    audience_conversion_data: {
      level: "no",
      note: "Conversions API / audience upload are not implemented.",
    },
  },
  whatsapp: {
    read_events: {
      level: "yes",
      note: "Inbound messages arrive via Cloud API webhooks (messages field).",
    },
    receive_comments: {
      level: "no",
      note: "WhatsApp has no comments surface.",
    },
    send_messages: {
      level: "limited",
      note: "Business-initiated chats REQUIRE pre-approved templates; free-form only inside the 24h window. Opt-in required.",
    },
    publish_media: {
      // Wave 2A (D7): media sends are NOT implemented — every Meta
      // adapter's sendMessage builds a text-only payload and ignores its
      // `media` argument (messenger.ts / instagram.ts / whatsapp.ts).
      // Advertising it as available over-promised; sends are text-only.
      level: "no",
      note: "Media sends are not implemented — sends are text-only. The adapters ignore media attachments; use text or an approved template.",
    },
    manage_conversations: {
      level: "yes",
      note: "Conversations read in the inbox; assignment, priorities and human takeover supported.",
    },
    retrieve_analytics: {
      level: "no",
      note: "WhatsApp analytics endpoints are not wired — FlowPilot reports from its own send log only.",
    },
    manage_ads: {
      level: "no",
      note: "Needs the Meta Marketing API + ad-account approval — not implemented.",
    },
    audience_conversion_data: {
      level: "no",
      note: "Conversions API / audience upload are not implemented.",
    },
  },
  tiktok: {
    read_events: {
      level: "no",
      note: "TikTok Login Kit has no webhook surface in this integration.",
    },
    receive_comments: {
      level: "no",
      note: "TikTok exposes no comment-read API through Login Kit.",
    },
    send_messages: {
      level: "no",
      note: "TikTok exposes no general DM-sending API — FlowPilot does not offer TikTok messaging.",
    },
    publish_media: {
      level: "no",
      note: "Video upload via TikTok APIs is not implemented.",
    },
    manage_conversations: {
      level: "no",
      note: "No conversation API available through Login Kit.",
    },
    retrieve_analytics: {
      level: "no",
      note: "TikTok analytics endpoints are not wired.",
    },
    manage_ads: {
      level: "no",
      note: "TikTok Marketing API is not integrated.",
    },
    audience_conversion_data: {
      level: "no",
      note: "TikTok Events API is not integrated.",
    },
  },
  // --- Simulated catalog providers: truth mirrors the catalog's claimed
  // capabilities, but every "yes"/"limited" resolves to "simulated" because
  // no real OAuth/API integration exists — the mock adapter stands in. ---
  telegram: {
    read_events: { level: "yes", note: "Bot API updates would feed webhooks — simulated." },
    receive_comments: { level: "no", note: "Telegram has no comments surface." },
    send_messages: { level: "yes", note: "Bot API messaging — simulated." },
    publish_media: { level: "yes", note: "Bot API media sends — simulated." },
    manage_conversations: { level: "yes", note: "Simulated conversation handling." },
    retrieve_analytics: { level: "no", note: "No analytics API wired." },
    manage_ads: { level: "no", note: "No ads integration." },
    audience_conversion_data: { level: "no", note: "No conversion-data integration." },
  },
  youtube: {
    read_events: { level: "no", note: "No webhook surface wired." },
    receive_comments: { level: "yes", note: "Comment-reply workflows via the YouTube Data API — simulated." },
    send_messages: { level: "no", note: "No unsolicited DM capability on YouTube." },
    publish_media: { level: "no", note: "Video upload not implemented." },
    manage_conversations: { level: "limited", note: "Comment threads treated as conversations — simulated." },
    retrieve_analytics: { level: "no", note: "YouTube Analytics API not wired." },
    manage_ads: { level: "no", note: "No ads integration." },
    audience_conversion_data: { level: "no", note: "No conversion-data integration." },
  },
  linkedin: {
    read_events: { level: "limited", note: "Restricted to approved partners — simulated." },
    receive_comments: { level: "no", note: "Comment APIs restricted to approved partners." },
    send_messages: { level: "no", note: "LinkedIn messaging APIs restricted to approved partners." },
    publish_media: { level: "no", note: "Organization content publishing not implemented." },
    manage_conversations: { level: "limited", note: "Organization Page messaging where authorized — simulated." },
    retrieve_analytics: { level: "no", note: "No analytics API wired." },
    manage_ads: { level: "no", note: "No ads integration." },
    audience_conversion_data: { level: "no", note: "No conversion-data integration." },
  },
  x: {
    read_events: { level: "yes", note: "Account activity webhooks would apply — simulated." },
    receive_comments: { level: "yes", note: "Reply-to-post workflows — simulated." },
    send_messages: { level: "yes", note: "DM API (tier-dependent) — simulated." },
    publish_media: { level: "no", note: "Media upload not implemented." },
    manage_conversations: { level: "yes", note: "Simulated conversation handling." },
    retrieve_analytics: { level: "no", note: "No analytics API wired." },
    manage_ads: { level: "no", note: "No ads integration." },
    audience_conversion_data: { level: "no", note: "No conversion-data integration." },
  },
  email: {
    read_events: { level: "no", note: "No inbound email parsing wired." },
    receive_comments: { level: "no", note: "Email has no comments surface." },
    send_messages: { level: "yes", note: "SMTP/API sends — simulated (no delivery provider configured)." },
    publish_media: { level: "yes", note: "Attachments on sends — simulated." },
    manage_conversations: { level: "no", note: "No conversation threading wired." },
    retrieve_analytics: { level: "no", note: "No delivery/open analytics wired." },
    manage_ads: { level: "no", note: "No ads integration." },
    audience_conversion_data: { level: "no", note: "No conversion-data integration." },
  },
  webchat: {
    read_events: { level: "yes", note: "Widget events are first-party — simulated until the widget is embedded." },
    receive_comments: { level: "no", note: "Live chat has no comments surface." },
    send_messages: { level: "yes", note: "First-party channel — simulated until the widget is embedded." },
    publish_media: { level: "yes", note: "Media in chat — simulated." },
    manage_conversations: { level: "yes", note: "Simulated conversation handling." },
    retrieve_analytics: { level: "no", note: "No chat analytics wired." },
    manage_ads: { level: "no", note: "No ads integration." },
    audience_conversion_data: { level: "no", note: "No conversion-data integration." },
  },
  sheets: {
    read_events: { level: "limited", note: "Contact/lead row sync — not real-time events; simulated." },
    receive_comments: { level: "no", note: "Sheets has no comments surface." },
    send_messages: { level: "no", note: "Sheets is a data source, not a channel." },
    publish_media: { level: "no", note: "Not a media channel." },
    manage_conversations: { level: "no", note: "Not a conversation channel." },
    retrieve_analytics: { level: "no", note: "No analytics integration." },
    manage_ads: { level: "no", note: "No ads integration." },
    audience_conversion_data: { level: "no", note: "No conversion-data integration." },
  },
  zapier: {
    read_events: { level: "limited", note: "Outbound webhooks to Zapier/Make catch hooks — simulated." },
    receive_comments: { level: "no", note: "Not a conversation channel." },
    send_messages: { level: "no", note: "Not a messaging channel." },
    publish_media: { level: "no", note: "Not a media channel." },
    manage_conversations: { level: "no", note: "Not a conversation channel." },
    retrieve_analytics: { level: "no", note: "No analytics integration." },
    manage_ads: { level: "no", note: "No ads integration." },
    audience_conversion_data: { level: "no", note: "No conversion-data integration." },
  },
};

export interface CapabilityDetail {
  key: CapabilityKey;
  state: CapabilityState;
  /** Honest, user-facing note (platform caveat / why unavailable / why not connected). */
  note: string;
}

/**
 * Resolve the capability matrix for one provider given its live connection
 * state. "no" levels always resolve to "unavailable" (the platform or our
 * implementation cannot do it, connected or not). "yes"/"limited" levels
 * resolve to "available"/"limited" ONLY when connected with real auth;
 * simulated providers get "simulated"; everything else gets "not_connected"
 * so the card never implies a working feature without a live connection.
 */
export function resolveCapabilities(
  provider: string,
  opts: { connectionState: ConnectionState; simulated: boolean }
): CapabilityDetail[] {
  const truth = PROVIDER_CAPABILITIES[provider];
  const { connectionState, simulated } = opts;
  return CAPABILITY_KEYS.map((key) => {
    const t: CapabilityTruth = truth?.[key] ?? {
      level: "no",
      note: "Unknown provider — no capability information.",
    };
    if (t.level === "no") {
      return { key, state: "unavailable", note: t.note };
    }
    if (simulated) {
      // The mock stands in only when the mock handshake completed
      // ("connected"); otherwise nothing backs the capability at all.
      return {
        key,
        state: connectionState === "connected" ? "simulated" : "not_connected",
        note: t.note,
      };
    }
    if (connectionState === "connected") {
      return {
        key,
        state: t.level === "yes" ? "available" : "limited",
        note: t.note,
      };
    }
    if (connectionState === "partial") {
      // Degraded connection: advertise what exists, but mark it limited so
      // the card reflects that the connection is not fully healthy.
      return { key, state: "limited", note: `${t.note} Connection is partial — check the provider card.` };
    }
    return { key, state: "not_connected", note: t.note };
  });
}

/** Count capabilities in a resolved matrix by state (for tests/reporting). */
export function countCapabilityStates(
  details: CapabilityDetail[]
): Record<CapabilityState, number> {
  const counts: Record<CapabilityState, number> = {
    available: 0,
    limited: 0,
    unavailable: 0,
    not_connected: 0,
    simulated: 0,
  };
  for (const d of details) counts[d.state] += 1;
  return counts;
}
