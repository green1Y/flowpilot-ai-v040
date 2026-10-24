/**
 * Provider-adapter architecture (ARCHITECTURE.md § Provider-adapter).
 *
 * Every channel implements ChannelAdapter. The mock adapter implements the
 * full interface with latency + failure injection for local dev/tests.
 * Real adapters ship as capability-honest stubs: they document what the
 * official API supports and refuse to pretend a connection exists.
 */

export type Capability =
  | "send_text"
  | "send_media"
  | "reply_comment"
  | "comment_to_dm"
  | "templates_required"
  | "messaging_window"
  | "webhooks"
  | "read_conversations";

export interface ConnectionResult {
  ok: boolean;
  /** NEVER true unless a verification handshake succeeded. */
  verified: boolean;
  status: "CONNECTED" | "NEEDS_ATTENTION" | "EXPIRED" | "DISCONNECTED";
  message: string;
  accountLabel?: string;
}

export interface SendResult {
  ok: boolean;
  /** True when the send was simulated by the mock adapter — never a real send. */
  mocked: boolean;
  externalId: string | null;
  error?: string;
}

export interface ChannelAdapter {
  provider: string;
  displayName: string;
  capabilities: Capability[];
  limitations: string[];
  requiredPermissions: string[];
  connect(input: Record<string, unknown>): Promise<ConnectionResult>;
  verify(input: Record<string, unknown>): Promise<ConnectionResult>;
  sendMessage(input: {
    to: string;
    body: string;
    media?: string[];
    templateName?: string;
  }): Promise<SendResult>;
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
  /**
   * Optional: private reply to a comment (e.g. Instagram comment-to-DM).
   * The engine feature-checks for this method before using it.
   */
  replyToComment?(input: {
    commentId: string;
    body: string;
  }): Promise<SendResult>;
}
