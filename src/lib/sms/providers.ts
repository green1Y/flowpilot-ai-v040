/**
 * SMS provider abstraction (Wave 2D).
 *
 * Mirrors the prospecting plumbing: an SmsProvider interface + a registry
 * with NO enabled provider. There is no SMS campaign channel and no SMS
 * sending is simulated anywhere — until a real provider is integrated and
 * configured, status is always "not configured" with the prerequisite below.
 */

export const SMS_PROVIDER_NOT_CONFIGURED = "SMS_PROVIDER_NOT_CONFIGURED";

export const SMS_PROVIDER_PREREQUISITE =
  "Set SMS_PROVIDER + provider credentials (see .env.example placeholders in the release docs) — no SMS provider is configured in v0.4.0";

export interface SmsSendArgs {
  to: string;
  body: string;
}

export interface SmsSendResult {
  ok: boolean;
  externalId?: string;
  error?: string;
}

export interface SmsProvider {
  /** Env value of SMS_PROVIDER that selects this provider. */
  id: string;
  label: string;
  /** True only when the provider is configured AND enabled. */
  configured: boolean;
  send(args: SmsSendArgs): Promise<SmsSendResult>;
  getStatus(externalId: string): Promise<{ status: string }>;
}

/**
 * The provider registry. Intentionally empty in v0.4.0: no SMS provider
 * integration has been built or configured.
 */
export const SMS_PROVIDERS: SmsProvider[] = [];

export function listSmsProviders(): SmsProvider[] {
  return [...SMS_PROVIDERS];
}

export function getSmsProvider(): SmsProvider | null {
  return SMS_PROVIDERS.find((p) => p.configured) ?? null;
}

export interface SmsStatus {
  configured: boolean;
  code?: string;
  prerequisite?: string;
  supported: string[];
  provider?: string;
}

/** Public SMS status: never claims a provider exists when none does. */
export function getSmsStatus(): SmsStatus {
  const provider = getSmsProvider();
  if (!provider) {
    return {
      configured: false,
      code: SMS_PROVIDER_NOT_CONFIGURED,
      prerequisite: SMS_PROVIDER_PREREQUISITE,
      supported: [],
    };
  }
  return { configured: true, supported: [provider.id], provider: provider.id };
}
