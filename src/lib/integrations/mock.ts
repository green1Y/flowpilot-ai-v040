import {
  ChannelAdapter,
  ConnectionResult,
  SendResult,
} from "./adapter";

/**
 * Mock channel adapter — implements the FULL ChannelAdapter interface.
 * Used for local dev, demo mode, and automated tests.
 *
 * Honesty rules:
 * - `sendMessage` never performs a real external send; `mocked: true` and
 *   `externalId: null` make that explicit to every caller.
 * - `connect` performs a simulated OAuth handshake; `verify` must be called
 *   before status becomes CONNECTED (mirrors the real verification step).
 * - Failure injection: pass `failRate` (0..1) to simulate flaky providers.
 */
export class MockAdapter implements ChannelAdapter {
  provider: string;
  displayName: string;
  capabilities: ChannelAdapter["capabilities"];
  limitations: string[];
  requiredPermissions: string[];
  private failRate: number;

  constructor(opts: {
    provider: string;
    displayName: string;
    capabilities?: ChannelAdapter["capabilities"];
    limitations?: string[];
    requiredPermissions?: string[];
    failRate?: number;
  }) {
    this.provider = opts.provider;
    this.displayName = opts.displayName;
    this.capabilities = opts.capabilities ?? ["send_text", "webhooks", "read_conversations"];
    this.limitations = opts.limitations ?? [
      "Mock adapter — all sends are simulated. No real messages leave this server.",
    ];
    this.requiredPermissions = opts.requiredPermissions ?? ["mock.connect"];
    this.failRate = opts.failRate ?? 0;
  }

  private async latency() {
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
  }

  async connect(_input: Record<string, unknown>): Promise<ConnectionResult> {
    await this.latency();
    if (Math.random() < this.failRate) {
      return { ok: false, verified: false, status: "DISCONNECTED", message: "Mock provider rejected the handshake (injected failure)." };
    }
    // First step of OAuth: handshake initiated, NOT yet verified.
    return {
      ok: true,
      verified: false,
      status: "NEEDS_ATTENTION",
      message: "OAuth handshake initiated. Complete verification to activate.",
      accountLabel: `demo-${this.provider}-account`,
    };
  }

  async verify(_input: Record<string, unknown>): Promise<ConnectionResult> {
    await this.latency();
    if (Math.random() < this.failRate) {
      return { ok: false, verified: false, status: "NEEDS_ATTENTION", message: "Verification failed (injected failure). Try again." };
    }
    return {
      ok: true,
      verified: true,
      status: "CONNECTED",
      message: "Connection verified against the mock provider.",
      accountLabel: `demo-${this.provider}-account`,
    };
  }

  async sendMessage(input: { to: string; body: string; media?: string[]; templateName?: string }): Promise<SendResult> {
    await this.latency();
    if (Math.random() < this.failRate) {
      return { ok: false, mocked: true, externalId: null, error: "Mock provider rejected the send (injected failure)." };
    }
    console.log(`[mock:${this.provider}] simulated send → ${input.to}: ${input.body.slice(0, 80)}`);
    return { ok: true, mocked: true, externalId: null };
  }

  verifyWebhookSignature(_rawBody: string, _signature: string): boolean {
    // Mock webhooks are trusted in dev; production adapters must verify HMAC.
    return true;
  }
}
