"use client";

/**
 * Wave 2A (item 10) — Health Center.
 *
 * Per-account cards from GET /api/integrations/accounts (never the
 * per-provider list route, which collapses multi-account workspaces).
 * Each card shows: connection-state badge, SIMULATED badge where
 * applicable, account identity, required-vs-granted scopes, last
 * Test/Verify result + timestamp, webhook subscription state, last
 * error/status detail, a Test Connection button (upgraded test route)
 * and a Resubscribe button (resubscribe-webhooks route).
 *
 * Honesty notes baked into the UI:
 *  - Granted scopes are NOT read via API anywhere in this codebase, so
 *    the card says "not checked via API" instead of inventing a list.
 *  - Test/Verify results are not persisted as rows; the card shows the
 *    integration's verifiedAt / status detail / last sync, labeled as
 *    such, plus the live result of the button just pressed.
 *  - The Email/Resend panel reads GET /api/email/health when that route
 *    exists; at the time this page shipped it did not, so the panel
 *    honestly shows "email probe pending" instead of an invented check.
 *
 * Navigation wiring is the coordinator's job — the Sidebar is untouched.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import {
  CONNECTION_STATE_TONES,
  type ConnectionState,
} from "@/lib/integrations/connection-state";

interface AccountItem {
  id: string;
  provider: string;
  displayName: string;
  simulated: boolean;
  connectionState: ConnectionState;
  envConfigured: boolean;
  status: string;
  statusDetailMessage?: string | null;
  requiredPermissions: string[];
  isDefault?: boolean;
  accountName?: string | null;
  accountId?: string | null;
  accountAvatarUrl?: string | null;
  lastSyncAt?: string | null;
  verifiedAt?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  webhookSubscribedAt?: string | null;
  webhookSubscriptionDetail?: string | null;
}

interface TestResult {
  ok: boolean;
  mocked: boolean;
  latencyMs: number;
  note?: string;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** webhookSubscriptionDetail is sanitized JSON { fields, checkedAt }. */
function webhookSummary(a: AccountItem): string {
  if (!a.webhookSubscribedAt) return "Never confirmed via API";
  let fields = "";
  try {
    const d = JSON.parse(a.webhookSubscriptionDetail ?? "{}") as { fields?: string[] };
    if (Array.isArray(d.fields) && d.fields.length > 0) fields = ` (${d.fields.join(", ")})`;
  } catch {
    // Keep the timestamp even if the detail blob is unreadable.
  }
  return `Subscribed ${fmt(a.webhookSubscribedAt)}${fields}`;
}

export default function HealthCenterPage() {
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [emailProbe, setEmailProbe] = useState<
    | { state: "pending" }
    | { state: "ok"; detail: string }
    | { state: "error"; detail: string }
  >({ state: "pending" });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ accounts: AccountItem[] }>("/api/integrations/accounts");
      setAccounts(data.accounts ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
    // Email/Resend probe: GET /api/email/health shipped with wave 2E
    // (MANAGER+; returns { configured, reachable?, domainsCount?, code? }).
    // A 404 means the endpoint is absent → "pending". A 403 means the
    // viewer lacks the MANAGER+ gate — reported as such, never as a
    // healthy or unhealthy email state. Nothing is invented here.
    try {
      const data = await api<Record<string, unknown>>("/api/email/health");
      const configured = data.configured === true;
      const reachable = data.reachable === true;
      const detail = configured
        ? `Resend configured${typeof data.domainsCount === "number" ? ` — ${data.domainsCount} domain(s) listed` : ""} — reachable: ${reachable ? "yes" : "no"}${typeof data.error === "string" ? ` (${data.error})` : ""}`
        : `Resend not configured (${typeof data.code === "string" ? data.code : "EMAIL_NOT_CONFIGURED"})`;
      setEmailProbe({ state: "ok", detail });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setEmailProbe({ state: "error", detail: "Email probe requires a MANAGER role — sign in as a manager to see it." });
      } else {
        setEmailProbe({ state: "pending" });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runTest = async (a: AccountItem) => {
    const key = `test:${a.id}`;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const res = await api<TestResult>(`/api/integrations/${a.id}/test`, { method: "POST" });
      setResults((r) => ({
        ...r,
        [a.id]: `Test: ${res.ok ? "passed" : "failed"} — ${res.note ?? ""} (${res.latencyMs}ms)${res.mocked ? " [mocked]" : ""}`,
      }));
    } catch (e) {
      setResults((r) => ({
        ...r,
        [a.id]: `Test failed: ${e instanceof ApiError ? e.message : "unknown error"}`,
      }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
    void load();
  };

  const runResubscribe = async (a: AccountItem) => {
    const key = `resub:${a.id}`;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      // api() returns the raw payload when there is no `data` envelope —
      // the BLOCKED response ({ ok:false, blocked:true, reason }) arrives
      // here intact on HTTP 200.
      const res = await api<Record<string, unknown>>(
        `/api/integrations/${a.id}/resubscribe-webhooks`,
        { method: "POST" }
      );
      if (res.blocked === true) {
        setResults((r) => ({
          ...r,
          [a.id]: `Resubscribe BLOCKED: ${String(res.reason ?? "dashboard-side subscription is manual")}`,
        }));
      } else {
        const data = (res as { data?: { subscribed?: boolean } }).data;
        setResults((r) => ({
          ...r,
          [a.id]: `Resubscribe: ${data?.subscribed ? "subscribed" : "done"}`,
        }));
      }
    } catch (e) {
      setResults((r) => ({
        ...r,
        [a.id]: `Resubscribe failed: ${e instanceof ApiError ? e.message : "unknown error"}`,
      }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
    void load();
  };

  return (
    <div>
      <PageHeader
        title="Health Center"
        description="Per-account connection health. Test Connection proves the provider asset exists (token + identity check, nothing sent). Webhook state shown here is only as strong as the provider API allows — see the notes on each card."
      />
      {loading && <Spinner />}
      {error && <p className="text-sm text-[#FB7185]">{error}</p>}
      {!loading && !error && accounts.length === 0 && (
        <EmptyState title="No accounts" description="No integration rows exist for this workspace yet." />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {accounts.map((a) => {
          const tone: BadgeTone = CONNECTION_STATE_TONES[a.connectionState] ?? "gray";
          return (
            <Card key={a.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{a.displayName}</CardTitle>
                  <Badge tone={tone}>{a.connectionState}</Badge>
                  {a.simulated && <Badge tone="gray">SIMULATED</Badge>}
                  {a.isDefault && <Badge tone="blue">Default</Badge>}
                  {!a.envConfigured && <Badge tone="amber">Configuration required</Badge>}
                </div>
              </CardHeader>
              <CardContent>
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="text-[var(--fp-text-2)]">Account</dt>
                    <dd>{a.accountName ?? "Unknown account"}{a.accountId ? ` (${a.accountId})` : ""}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--fp-text-2)]">Required scopes</dt>
                    <dd>{a.requiredPermissions.length > 0 ? a.requiredPermissions.join(", ") : "None"}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--fp-text-2)]">Granted scopes</dt>
                    <dd className="italic text-[var(--fp-text-2)]">
                      not checked via API — no scopes read is implemented; do not assume the required list is granted.
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--fp-text-2)]">Last verified</dt>
                    <dd>{fmt(a.verifiedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--fp-text-2)]">Last result / status detail</dt>
                    <dd>{a.statusDetailMessage ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--fp-text-2)]">Last sync</dt>
                    <dd>{fmt(a.lastSyncAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--fp-text-2)]">Webhook subscription</dt>
                    <dd>{webhookSummary(a)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--fp-text-2)]">Last error</dt>
                    <dd>{a.lastError ? `${a.lastError} (${fmt(a.lastErrorAt)})` : "—"}</dd>
                  </div>
                </dl>
                {results[a.id] && (
                  <p className="mt-3 text-xs text-[var(--fp-text-2)]">{results[a.id]}</p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={!!busy[`test:${a.id}`]}
                    onClick={() => void runTest(a)}
                  >
                    Test Connection
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={!!busy[`resub:${a.id}`]}
                    onClick={() => void runResubscribe(a)}
                  >
                    Resubscribe
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Email / Resend configuration</CardTitle>
          </CardHeader>
          <CardContent>
            {emailProbe.state === "pending" && (
              <p className="text-sm italic text-[var(--fp-text-2)]">
                email probe pending — no email health endpoint is available yet, so no email
                status is claimed here.
              </p>
            )}
            {emailProbe.state === "ok" && (
              <p className="text-sm">{emailProbe.detail}</p>
            )}
            {emailProbe.state === "error" && (
              <p className="text-sm text-[#FB7185]">{emailProbe.detail}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
