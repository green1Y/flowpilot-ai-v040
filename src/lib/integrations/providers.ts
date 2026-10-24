import { ChannelAdapter } from "./adapter";
import { MockAdapter } from "./mock";
import { MessengerAdapter } from "./messenger";
import { InstagramAdapter } from "./instagram";
import { WhatsAppAdapter, WhatsAppAdapterOptions } from "./whatsapp";
import { db } from "@/lib/db";
import { decryptCredentials, MetaCredentials } from "./meta";

/**
 * Provider catalog with HONEST capability + limitation panels.
 * Real adapters (instagram, whatsapp, …) ship as MockAdapter-backed stubs
 * with accurate capability documentation until official OAuth credentials are
 * configured. A provider is only marked CONNECTED after verify() succeeds.
 */
export interface ProviderInfo {
  provider: string;
  displayName: string;
  category: "social" | "messaging" | "business" | "other";
  capabilities: ChannelAdapter["capabilities"];
  limitations: string[];
  requiredPermissions: string[];
  docsUrl: string;
}

/**
 * Providers with a REAL OAuth flow implemented (Meta Login / TikTok Login
 * Kit). Every other catalog provider uses the simulated mock handshake —
 * the UI must label those as Simulated, never as a real connection.
 */
export const REAL_OAUTH_PROVIDERS = new Set([
  "instagram",
  "facebook",
  "whatsapp",
  "tiktok",
]);

export function isSimulatedProvider(provider: string): boolean {
  return !REAL_OAUTH_PROVIDERS.has(provider);
}

export const PROVIDERS: ProviderInfo[] = [
  {
    provider: "instagram",
    displayName: "Instagram",
    category: "social",
    capabilities: ["reply_comment", "comment_to_dm", "send_text", "webhooks", "read_conversations"],
    limitations: [
      "Requires an Instagram Professional (Business/Creator) account linked to a Facebook Page.",
      "Automated private replies (comment-to-DM) are only allowed for eligible interactions and must follow Meta messaging policies.",
      "Human-agent messaging window: 24h for standard messaging; some message types need approved templates.",
    ],
    // Wave 2A (D5): Business Login scopes — the old instagram_manage_*
    // / pages_show_list scopes were deprecated by Meta (2025-01-27) and
    // are not requested by the Business Login flow (see
    // INSTAGRAM_LOGIN_SCOPES in instagram-login.ts, which already lists
    // these three). The catalog now matches the flow that actually runs.
    requiredPermissions: ["instagram_business_basic", "instagram_business_manage_messages", "instagram_business_manage_comments"],
    docsUrl: "https://developers.facebook.com/docs/instagram-platform",
  },
  {
    provider: "facebook",
    displayName: "Facebook Pages",
    category: "social",
    capabilities: ["reply_comment", "send_text", "webhooks", "read_conversations"],
    limitations: [
      "Requires a Facebook Page with the app subscribed to Page webhooks.",
      "Standard messaging window applies; promotional content outside the window requires approved message tags.",
      "Media sends are not implemented — sends are text-only.",
    ],
    requiredPermissions: ["pages_messaging", "pages_show_list", "pages_read_engagement"],
    docsUrl: "https://developers.facebook.com/docs/messenger-platform",
  },
  {
    provider: "whatsapp",
    displayName: "WhatsApp Business",
    category: "messaging",
    capabilities: ["send_text", "templates_required", "messaging_window", "webhooks", "read_conversations"],
    limitations: [
      "Business-initiated conversations REQUIRE pre-approved message templates.",
      "24-hour customer-service window for free-form replies after the user's last message.",
      "Opt-in is required before messaging a customer.",
      "Media sends are not implemented — sends are text-only.",
    ],
    requiredPermissions: ["whatsapp_business_messaging", "whatsapp_business_management"],
    docsUrl: "https://developers.facebook.com/docs/whatsapp",
  },
  {
    provider: "telegram",
    displayName: "Telegram",
    category: "messaging",
    capabilities: ["send_text", "send_media", "webhooks", "read_conversations"],
    limitations: ["Bots cannot initiate conversations with users who have not started the bot."],
    requiredPermissions: ["bot_token"],
    docsUrl: "https://core.telegram.org/bots/api",
  },
  {
    provider: "tiktok",
    displayName: "TikTok",
    category: "social",
    capabilities: [],
    limitations: [
      "TikTok Login Kit provides account identity verification only (display name, username, avatar).",
      "There is no general DM-sending API for TikTok; FlowPilot does not offer TikTok messaging.",
      "Requires a TikTok developer app with Login Kit enabled and the redirect URI whitelisted.",
    ],
    requiredPermissions: ["user.info.basic"],
    docsUrl: "https://developers.tiktok.com/doc/login-kit-web/",
  },
  {
    provider: "youtube",
    displayName: "YouTube",
    category: "social",
    capabilities: ["reply_comment", "read_conversations"],
    limitations: ["Supports comment reply workflows via the YouTube Data API. Quota-limited; no unsolicited DM capability."],
    requiredPermissions: ["youtube.force-ssl"],
    docsUrl: "https://developers.google.com/youtube/v3",
  },
  {
    provider: "linkedin",
    displayName: "LinkedIn",
    category: "social",
    capabilities: ["read_conversations", "webhooks"],
    limitations: ["LinkedIn messaging APIs are restricted to approved partners. Organization Page messaging where authorized."],
    requiredPermissions: ["w_organization_social", "r_organization_social"],
    docsUrl: "https://learn.microsoft.com/en-us/linkedin/",
  },
  {
    provider: "x",
    displayName: "X (Twitter)",
    category: "social",
    capabilities: ["send_text", "reply_comment", "read_conversations", "webhooks"],
    limitations: ["Requires an X API tier with DM/write access. Rate limits are strict and tier-dependent."],
    requiredPermissions: ["tweet.write", "dm.write"],
    docsUrl: "https://docs.x.com/",
  },
  {
    provider: "email",
    displayName: "Email (SMTP/API)",
    category: "messaging",
    capabilities: ["send_text", "send_media"],
    limitations: ["Requires SPF/DKIM-configured sending domain. Unsubscribe handling is mandatory for marketing mail."],
    requiredPermissions: ["smtp_credentials"],
    docsUrl: "https://flowpilot.ai/docs/integrations/email",
  },
  {
    provider: "webchat",
    displayName: "Website Live Chat",
    category: "messaging",
    capabilities: ["send_text", "send_media", "webhooks", "read_conversations"],
    limitations: ["Embed the FlowPilot widget snippet on your site. First-party channel — no external approval needed."],
    requiredPermissions: [],
    docsUrl: "https://flowpilot.ai/docs/integrations/webchat",
  },
  {
    provider: "sheets",
    displayName: "Google Sheets",
    category: "business",
    capabilities: ["webhooks"],
    limitations: ["Syncs contact/lead rows. Requires a Google Cloud OAuth client with Sheets scopes."],
    requiredPermissions: ["spreadsheets"],
    docsUrl: "https://developers.google.com/sheets/api",
  },
  {
    provider: "zapier",
    displayName: "Zapier / Make",
    category: "business",
    capabilities: ["webhooks"],
    limitations: ["Outbound webhooks to Zapier/Make catch hooks. No OAuth required — uses signed webhook URLs."],
    requiredPermissions: [],
    docsUrl: "https://flowpilot.ai/docs/integrations/webhooks",
  },
];

/** Resolve an adapter for a provider. All adapters are currently mock-backed
 *  (honest stubs) until official credentials are configured per provider. */
export function getAdapter(provider: string, opts?: { failRate?: number }): ChannelAdapter {
  const info = PROVIDERS.find((p) => p.provider === provider);
  if (!info) throw new Error(`Unknown provider: ${provider}`);
  return new MockAdapter({
    provider: info.provider,
    displayName: info.displayName,
    capabilities: info.capabilities,
    limitations: info.limitations,
    requiredPermissions: info.requiredPermissions,
    failRate: opts?.failRate ?? 0,
  });
}

/** Construct the real Meta adapter for a decrypted credential record. */
function buildMetaAdapter(
  creds: MetaCredentials,
  requestedProvider: string,
  opts?: WhatsAppAdapterOptions
): ChannelAdapter | null {
  if (creds.provider !== requestedProvider) return null;
  switch (creds.provider) {
    case "facebook":
      return new MessengerAdapter(creds);
    case "instagram":
      return new InstagramAdapter(creds);
    case "whatsapp":
      return new WhatsAppAdapter(creds, opts);
    default:
      return null;
  }
}

/**
 * Batch B — explicit account routing failure. Thrown when a caller asked
 * for a SPECIFIC connected account (or when several accounts make the
 * implicit choice ambiguous) and no honest resolution exists. Callers
 * must surface this — a message must NEVER be silently re-routed through
 * a different account than the one that was requested.
 */
export class AccountResolutionError extends Error {
  code:
    | "ACCOUNT_NOT_FOUND"
    | "ACCOUNT_WRONG_PROVIDER"
    | "ACCOUNT_NOT_CONNECTED"
    | "ACCOUNT_NOT_USABLE"
    | "AMBIGUOUS_ACCOUNT";
  constructor(
    code: AccountResolutionError["code"],
    message: string
  ) {
    super(message);
    this.name = "AccountResolutionError";
    this.code = code;
  }
}

export interface ResolvedWorkspaceAdapter {
  adapter: ChannelAdapter;
  /** The Integration row the adapter was built from; null on mock fallback. */
  integrationId: string | null;
  /** True when the adapter is the honest mock (no real account was used). */
  mocked: boolean;
}

type ResolveOpts = WhatsAppAdapterOptions & {
  /**
   * Pin resolution to this exact connected account (Batch B explicit
   * routing — workflow node config or the account an inbound event
   * arrived on). Strict: any problem throws AccountResolutionError
   * instead of falling back to another account or the mock.
   */
  integrationId?: string;
};

/** Try to build a real adapter from a row; null when not usable. */
function tryBuildRealAdapter(
  row: { encryptedCredentials: string | null },
  provider: string,
  opts?: WhatsAppAdapterOptions
): ChannelAdapter | null {
  if (!row.encryptedCredentials) return null;
  try {
    const creds = decryptCredentials(row.encryptedCredentials);
    return buildMetaAdapter(creds, provider, opts);
  } catch {
    return null;
  }
}

/**
 * Batch B — resolve the adapter for a workspace + provider WITH the exact
 * account it belongs to.
 *
 * Resolution order (no explicit `integrationId`):
 *   1. the pair's isDefault CONNECTED account with usable credentials;
 *   2. the single CONNECTED account with usable credentials, if exactly one;
 *   3. several usable CONNECTED accounts and no default → AMBIGUOUS_ACCOUNT
 *      (fail safe — never "first row of a query");
 *   4. no usable connected account → the honest mock adapter
 *      (integrationId null, mocked true — the pre-Batch-B behavior).
 *
 * With an explicit `integrationId` the named account — and only that
 * account — is used; every problem throws AccountResolutionError.
 * Simulated (non-OAuth) providers resolve to the mock adapter bound to
 * their row, honestly labeled mocked.
 */
export async function resolveWorkspaceAdapter(
  workspaceId: string,
  provider: string,
  opts?: ResolveOpts
): Promise<ResolvedWorkspaceAdapter> {
  const { integrationId: explicitId, ...adapterOpts } = opts ?? {};

  if (explicitId) {
    const row = await db.integration.findFirst({
      where: { id: explicitId, workspaceId },
    });
    if (!row) {
      throw new AccountResolutionError(
        "ACCOUNT_NOT_FOUND",
        `Connected account ${explicitId} was not found in this workspace — refusing to route through a different account.`
      );
    }
    if (row.provider !== provider) {
      throw new AccountResolutionError(
        "ACCOUNT_WRONG_PROVIDER",
        `Connected account ${explicitId} is a ${row.provider} account, not ${provider} — refusing to route through it.`
      );
    }
    if (row.status === "DISCONNECTED") {
      throw new AccountResolutionError(
        "ACCOUNT_NOT_CONNECTED",
        `Connected account ${row.accountName ?? explicitId} (${provider}) is disconnected — reconnect it before sending.`
      );
    }
    if (isSimulatedProvider(provider)) {
      // Simulated providers have no real adapter; the row's "connection"
      // is the honest mock, bound to this exact account.
      return { adapter: getAdapter(provider), integrationId: row.id, mocked: true };
    }
    if (row.status !== "CONNECTED") {
      throw new AccountResolutionError(
        "ACCOUNT_NOT_CONNECTED",
        `Connected account ${row.accountName ?? explicitId} (${provider}) is ${row.status}, not CONNECTED — refusing to send through it.`
      );
    }
    const real = tryBuildRealAdapter(row, provider, adapterOpts);
    if (!real) {
      throw new AccountResolutionError(
        "ACCOUNT_NOT_USABLE",
        `Connected account ${row.accountName ?? explicitId} (${provider}) has unusable credentials — reconnect it before sending.`
      );
    }
    return { adapter: real, integrationId: row.id, mocked: false };
  }

  // Implicit resolution over the workspace's CONNECTED accounts.
  const rows = await db.integration.findMany({
    where: { workspaceId, provider, status: "CONNECTED" },
    orderBy: { createdAt: "asc" },
  });
  const usable: { id: string; isDefault: boolean; adapter: ChannelAdapter }[] = [];
  for (const row of rows) {
    const real = tryBuildRealAdapter(row, provider, adapterOpts);
    if (real) usable.push({ id: row.id, isDefault: row.isDefault, adapter: real });
  }
  const chosen = usable.find((u) => u.isDefault) ?? (usable.length === 1 ? usable[0] : null);
  if (chosen) {
    return { adapter: chosen.adapter, integrationId: chosen.id, mocked: false };
  }
  if (usable.length > 1) {
    throw new AccountResolutionError(
      "AMBIGUOUS_ACCOUNT",
      `Workspace has ${usable.length} connected ${provider} accounts and none is marked default — refusing to guess which account to send through. Pin an account on the workflow/action or mark one account as default.`
    );
  }
  // No usable connected account: honest mock fallback (pre-Batch-B
  // behavior for account-less paths — demo/simulated sends stay labeled).
  return { adapter: getAdapter(provider), integrationId: null, mocked: true };
}

/**
 * Resolve the best adapter for a workspace + provider (legacy signature —
 * delegates to resolveWorkspaceAdapter). Implicit resolution keeps the
 * historical contract (real adapter when a connected account is usable,
 * honest mock otherwise), EXCEPT that a genuinely ambiguous multi-account
 * state now throws AccountResolutionError instead of silently picking an
 * account. getAdapter still throws for truly unknown catalog entries.
 */
export async function getWorkspaceAdapter(
  workspaceId: string,
  provider: string,
  opts?: ResolveOpts
): Promise<ChannelAdapter> {
  const resolved = await resolveWorkspaceAdapter(workspaceId, provider, opts);
  return resolved.adapter;
}

/** Seed rows so the Integrations center always has an honest status per provider. */
export function seedIntegrationRows() {
  return PROVIDERS.map((p) => ({
    provider: p.provider,
    displayName: p.displayName,
    category: p.category,
    capabilities: p.capabilities,
    limitations: p.limitations,
    requiredPermissions: p.requiredPermissions,
    docsUrl: p.docsUrl,
  }));
}
