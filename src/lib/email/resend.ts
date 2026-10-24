import type { EmailSender } from "./sender";

const RESEND_API_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 20_000; // matches the provider-call timeout policy in SECURITY_AUDIT.md

/**
 * Resend transactional-email adapter.
 *
 * Credentials are passed in by `getEmailSender()` (read from env ONLY).
 * Never logs the API key or the email body.
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string
  ) {}

  async send(
    to: string,
    subject: string,
    html: string
  ): Promise<{ ok: boolean; messageId?: string }> {
    let res: Response;
    try {
      res = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: this.from, to: [to], subject, html }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(
        `[email] Resend request failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
    }
    if (!res.ok) {
      // Read a bounded error snippet for diagnostics; never contains secrets.
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`[email] Resend send failed (HTTP ${res.status}): ${detail}`);
    }
    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, messageId: data?.id };
  }
}
