/**
 * Facebook Messenger channel adapter (real Meta Graph API).
 *
 * Capability-honest: every send/verify call below hits the real Meta Graph
 * API. `connect()` deliberately refuses to fake a connection — real Page
 * authorization requires browser OAuth ("Connect with Meta" flow), so it
 * returns NEEDS_ATTENTION instead of CONNECTED.
 *
 * Security: tokens are never logged; they are passed only to Meta.
 */

import {
  ChannelAdapter,
  ConnectionResult,
  SendResult,
} from "./adapter";
import {
  graph,
  MetaCredentials,
  verifyMetaSignature,
  verifyPage,
} from "./meta";

export class MessengerAdapter implements ChannelAdapter {
  provider = "facebook";
  displayName = "Facebook Messenger";
  capabilities: ChannelAdapter["capabilities"] = [
    "send_text",
    "send_media",
    "webhooks",
    "read_conversations",
  ];
  limitations = [
    "Standard messaging window: free-form replies are only allowed within 24 hours of the user's last message.",
    "Promotional content outside the window requires an approved message tag.",
    "Requires a Facebook Page with the app subscribed to Page webhooks.",
  ];
  requiredPermissions = [
    "pages_messaging",
    "pages_show_list",
    "pages_read_engagement",
  ];

  constructor(private readonly creds: MetaCredentials) {}

  async connect(
    _input: Record<string, unknown>
  ): Promise<ConnectionResult> {
    return {
      ok: true,
      verified: false,
      status: "NEEDS_ATTENTION",
      message:
        "Use 'Connect with Meta' (OAuth) in the Integrations page — browser authorization is required.",
      accountLabel: this.creds.pageName,
    };
  }

  async verify(
    _input: Record<string, unknown>
  ): Promise<ConnectionResult> {
    const page = await verifyPage(
      this.creds.pageId as string,
      this.creds.pageAccessToken as string
    );
    return {
      ok: true,
      verified: true,
      status: "CONNECTED",
      message: "Page verified via Meta Graph API",
      accountLabel: this.creds.pageName ?? page.name,
    };
  }

  async sendMessage(input: {
    to: string;
    body: string;
    media?: string[];
    templateName?: string;
  }): Promise<SendResult> {
    const data = await graph<{ message_id?: string }>("/me/messages", {
      token: this.creds.pageAccessToken as string,
      method: "POST",
      body: {
        recipient: { id: input.to },
        messaging_type: "RESPONSE",
        message: { text: input.body.slice(0, 2000) },
      },
    });
    return {
      ok: true,
      mocked: false,
      externalId: data.message_id ?? null,
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return verifyMetaSignature(rawBody, signature);
  }
}
