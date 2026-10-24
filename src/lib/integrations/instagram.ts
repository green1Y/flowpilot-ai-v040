/**
 * Instagram Messaging channel adapter (real Meta Graph API).
 *
 * Sends through the Page-scoped Messenger Platform endpoint for the linked
 * Instagram Business/Creator account (`/me/messages`), plus Instagram
 * private replies to eligible comments (`/{comment-id}/private_replies`).
 * Capability-honest: `connect()` refuses to fake OAuth — browser
 * authorization is required, so it returns NEEDS_ATTENTION.
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
import {
  getInstagramLoginUser,
  igGraph,
} from "./instagram-login";

/** True when these credentials came from Instagram Business Login. */
function isInstagramLogin(creds: MetaCredentials): boolean {
  return creds.loginType === "instagram_login";
}

export class InstagramAdapter implements ChannelAdapter {
  provider = "instagram";
  displayName = "Instagram Messaging";
  capabilities: ChannelAdapter["capabilities"] = [
    "send_text",
    "reply_comment",
    "comment_to_dm",
    "webhooks",
    "read_conversations",
  ];
  limitations = [
    "Instagram Business Login: connect an Instagram Professional account directly — no Facebook Page required.",
    "Legacy Facebook-Login connections (Page-linked) keep working; new connections use Business Login.",
    "Private replies are only allowed for eligible comments and must follow Meta messaging policies.",
    "Standard messaging window: free-form replies are only allowed within 24 hours of the user's last message.",
  ];
  requiredPermissions = [
    "instagram_business_basic",
    "instagram_business_manage_messages",
    "instagram_business_manage_comments",
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
      accountLabel: this.creds.igUsername ?? this.creds.pageName,
    };
  }

  async verify(
    _input: Record<string, unknown>
  ): Promise<ConnectionResult> {
    // Business Login: verify the IG Professional account directly.
    if (isInstagramLogin(this.creds)) {
      const me = await getInstagramLoginUser(this.creds.accessToken);
      return {
        ok: true,
        verified: true,
        status: "CONNECTED",
        message: "Instagram account verified via Instagram Business Login",
        accountLabel: me.username,
      };
    }
    // Legacy Facebook-Login: verify the linked Page.
    const page = await verifyPage(
      this.creds.pageId as string,
      this.creds.pageAccessToken as string
    );
    return {
      ok: true,
      verified: true,
      status: "CONNECTED",
      message: "Page verified via Meta Graph API",
      accountLabel: this.creds.igUsername ?? page.name,
    };
  }

  async sendMessage(input: {
    to: string;
    body: string;
    media?: string[];
    templateName?: string;
  }): Promise<SendResult> {
    // Business Login: send through graph.instagram.com with the IG user token.
    if (isInstagramLogin(this.creds)) {
      const data = await igGraph<{ message_id?: string }>(
        "/me/messages",
        this.creds.accessToken,
        {
          method: "POST",
          body: {
            recipient: { id: input.to },
            message: { text: input.body.slice(0, 1000) },
          },
        }
      );
      return {
        ok: true,
        mocked: false,
        externalId: data.message_id ?? null,
      };
    }
    const data = await graph<{ message_id?: string }>("/me/messages", {
      token: this.creds.pageAccessToken as string,
      method: "POST",
      body: {
        recipient: { id: input.to },
        message: { text: input.body.slice(0, 1000) },
      },
    });
    return {
      ok: true,
      mocked: false,
      externalId: data.message_id ?? null,
    };
  }

  /**
   * Private reply to an eligible comment. The engine feature-checks for
   * this method before using comment-to-DM workflows.
   */
  async replyToComment(input: {
    commentId: string;
    body: string;
  }): Promise<SendResult> {
    // Business Login: private replies through graph.instagram.com.
    if (isInstagramLogin(this.creds)) {
      const data = await igGraph<{ id?: string }>(
        `/${input.commentId}/private_replies`,
        this.creds.accessToken,
        { method: "POST", body: { message: input.body } }
      );
      return {
        ok: true,
        mocked: false,
        externalId: data.id ?? null,
      };
    }
    const data = await graph<{ id?: string }>(
      `/${input.commentId}/private_replies`,
      {
        token: this.creds.pageAccessToken as string,
        method: "POST",
        body: { message: input.body },
      }
    );
    return {
      ok: true,
      mocked: false,
      externalId: data.id ?? null,
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return verifyMetaSignature(rawBody, signature);
  }
}
