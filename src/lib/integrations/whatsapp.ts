/**
 * WhatsApp Business channel adapter (real Meta Cloud API).
 *
 * Two send modes:
 * 1. Template send (business-initiated or outside the 24h window) — caller
 *    passes `templateName`; the template MUST be pre-approved in Meta.
 * 2. Free-form text — allowed only inside the 24h customer-service window
 *    after the contact's last inbound message. The window is enforced via
 *    the injected `getLastInboundAt` lookup; without a templateName and
 *    without a recent inbound message the send is refused (never silently
 *    sent, never mocked).
 *
 * Capability-honest: `connect()` refuses to fake a connection — browser
 * OAuth is required, so it returns NEEDS_ATTENTION.
 *
 * Security: the bearer token is never logged; it is passed only to Meta.
 */

import {
  ChannelAdapter,
  ConnectionResult,
  SendResult,
} from "./adapter";
import {
  graph,
  getPhoneNumberInfo,
  MetaApiError,
  MetaCredentials,
  verifyMetaSignature,
} from "./meta";

const WINDOW_MS = 24 * 3600 * 1000;

export interface WhatsAppAdapterOptions {
  /** Return the contact's most recent inbound message time, or null. */
  getLastInboundAt?: (to: string) => Promise<Date | null>;
}

export class WhatsAppAdapter implements ChannelAdapter {
  provider = "whatsapp";
  displayName = "WhatsApp Business";
  capabilities: ChannelAdapter["capabilities"] = [
    "send_text",
    "send_media",
    "templates_required",
    "messaging_window",
    "webhooks",
    "read_conversations",
  ];
  limitations = [
    "Business-initiated conversations REQUIRE pre-approved message templates.",
    "Free-form replies are only allowed within 24 hours of the contact's last message.",
    "Opt-in is required before messaging a contact.",
  ];
  requiredPermissions = [
    "whatsapp_business_messaging",
    "whatsapp_business_management",
  ];

  constructor(
    private readonly creds: MetaCredentials,
    private readonly opts: WhatsAppAdapterOptions = {}
  ) {}

  async connect(
    _input: Record<string, unknown>
  ): Promise<ConnectionResult> {
    return {
      ok: true,
      verified: false,
      status: "NEEDS_ATTENTION",
      message:
        "Use 'Connect with Meta' (OAuth) in the Integrations page — browser authorization is required.",
      accountLabel: this.creds.phoneDisplayName,
    };
  }

  async verify(
    _input: Record<string, unknown>
  ): Promise<ConnectionResult> {
    const info = await getPhoneNumberInfo(
      this.creds.phoneNumberId as string,
      this.creds.accessToken
    );
    return {
      ok: true,
      verified: true,
      status: "CONNECTED",
      message: "Phone number verified via Meta Graph API",
      accountLabel: this.creds.phoneDisplayName ?? info.verified_name,
    };
  }

  async sendMessage(input: {
    to: string;
    body: string;
    media?: string[];
    templateName?: string;
  }): Promise<SendResult> {
    let payload: Record<string, unknown>;
    if (input.templateName) {
      payload = {
        messaging_product: "whatsapp",
        to: input.to,
        type: "template",
        template: {
          name: input.templateName,
          language: { code: "en_US" },
        },
      };
    } else {
      // Free-form text: allowed only inside the 24h customer-service window.
      const last = await this.opts.getLastInboundAt?.(input.to);
      if (!last || Date.now() - last.getTime() > WINDOW_MS) {
        throw new MetaApiError(
          "Outside the 24-hour customer service window — provide a templateName for this send.",
          undefined,
          422
        );
      }
      payload = {
        messaging_product: "whatsapp",
        to: input.to,
        type: "text",
        text: { body: input.body.slice(0, 4096), preview_url: false },
      };
    }

    const data = await graph<{
      messages?: Array<{ id?: string }>;
    }>(`/${this.creds.phoneNumberId}/messages`, {
      token: this.creds.accessToken,
      bearer: true,
      method: "POST",
      body: payload,
    });
    return {
      ok: true,
      mocked: false,
      externalId: data.messages?.[0]?.id ?? null,
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return verifyMetaSignature(rawBody, signature);
  }
}
