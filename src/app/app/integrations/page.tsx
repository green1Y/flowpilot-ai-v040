"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import {
  Plug,
  ChevronDown,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Zap,
  Unplug,
  Instagram,
  Facebook,
  MessageCircle,
  KeyRound,
  BookOpen,
  Minus,
  X,
  FlaskConical,
} from "lucide-react";
import { CONNECTION_STATE_TONES, type ConnectionState } from "@/lib/integrations/connection-state";
import type { CapabilityDetail, CapabilityState } from "@/lib/integrations/capabilities";
import {
  getIntegrationsStrings,
  type IntegrationsStrings,
} from "@/i18n/fragments/integrations";

/* ------------------------------------------------------------------ */

interface IntegrationItem {
  id?: string;
  provider: string;
  displayName: string;
  category: string;
  capabilities: string[];
  capabilitiesDetail?: CapabilityDetail[];
  connectionState?: ConnectionState;
  envConfigured?: boolean;
  statusDetailMessage?: string | null;
  limitations: string[];
  requiredPermissions: string[];
  docsUrl?: string;
  status: string; // DEMO | CONNECTED | NEEDS_ATTENTION | EXPIRED | DISCONNECTED
  lastSyncAt?: string | null;
  verifiedAt?: string | null;
  accountName?: string;
  accountId?: string;
  accountAvatarUrl?: string | null;
  simulated?: boolean;
}

interface TestResult {
  ok: boolean;
  mocked: boolean;
  latencyMs: number;
  note?: string;
}

interface MetaPage {
  id: string;
  name: string;
  hasInstagram: boolean;
}

const META_PROVIDERS = ["instagram", "facebook", "whatsapp"] as const;
type MetaProvider = (typeof META_PROVIDERS)[number];

function isMetaProvider(p: string): p is MetaProvider {
  return (META_PROVIDERS as readonly string[]).includes(p);
}

interface MetaMeta {
  title: string;
  description: string;
  icon: typeof Instagram;
  defaultCapabilities: string[];
  setupSteps: string[];
}

const META_CARD_META: Record<MetaProvider, MetaMeta> = {
  instagram: {
    title: "Instagram Messaging",
    description: "Send and receive Instagram DMs through FlowPilot automations.",
    icon: Instagram,
    defaultCapabilities: ["messaging", "media", "postbacks"],
    setupSteps: [
      "Go to developers.facebook.com → My Apps → Create App. Choose the \"Business\" app type and finish the wizard.",
      "In the app dashboard, go to Instagram → API setup with Instagram login → set up Business Login for your Instagram Professional (Business/Creator) account. No Facebook Page is required.",
      "Under Business login settings, add this app's OAuth redirect URI (shown in the connect dialog) to the allowed list.",
      "Add the permissions instagram_business_basic, instagram_business_manage_messages and instagram_business_manage_comments; complete App Review if needed and switch the app to Live mode.",
      "Configure the webhook: paste the callback URL shown below, enter your verify token, and subscribe to the Instagram object's messages and comments fields.",
      "Click Connect below and sign in with your Instagram Professional account — the account connects directly.",
    ],
  },
  facebook: {
    title: "Facebook Messenger",
    description: "Send and receive Facebook Page messages through FlowPilot automations.",
    icon: Facebook,
    defaultCapabilities: ["messaging", "postbacks", "handover"],
    setupSteps: [
      "Go to developers.facebook.com → My Apps → Create App. Choose the \"Business\" app type and finish the wizard.",
      "In the app dashboard, add the Messenger product.",
      "Go to Webhooks in the left menu → Add Callback URL. Paste the callback URL shown below, enter your verify token, and click Verify and Save.",
      "Subscribe the webhook to the fields: messages and messaging_postbacks.",
      "Add the permissions pages_messaging and pages_manage_metadata to your app, complete App Review if needed, and switch the app to Live mode.",
      "Click Connect with Meta below, sign in, and pick the Facebook Page you want FlowPilot to message from.",
    ],
  },
  whatsapp: {
    title: "WhatsApp Business Platform",
    description: "Send WhatsApp messages from your business number via the Cloud API.",
    icon: MessageCircle,
    defaultCapabilities: ["messaging", "templates", "media"],
    setupSteps: [
      "Go to developers.facebook.com → My Apps → Create App. Choose the \"Business\" app type and finish the wizard.",
      "In the app dashboard, add the WhatsApp product.",
      "Under WhatsApp → API Setup you will find your Phone number ID and a temporary access token — paste those with \"Enter token manually\". WhatsApp connects via manual token only (WABA + phone number ID + bearer token, validated live by the server); there is no WhatsApp OAuth completion step.",
      "Go to Webhooks in the left menu → Add Callback URL. Paste the callback URL shown below, enter your verify token, and click Verify and Save.",
      "Subscribe the webhook to the field: messages.",
      "Set your display name and switch the app to Live mode before sending production messages; test numbers work while in development.",
    ],
  },
};

/** Fallback when the API predates the 8-state model (defensive). */
function connectionStateOf(item: IntegrationItem): ConnectionState {
  if (item.connectionState) return item.connectionState;
  switch (item.status) {
    case "CONNECTED":
      return "connected";
    case "NEEDS_ATTENTION":
      return "connecting";
    case "EXPIRED":
      return "reauth_required";
    default:
      return "not_connected";
  }
}

/** Capability state → icon. */
function capabilityIcon(state: CapabilityState) {
  switch (state) {
    case "available":
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#34D399]" />;
    case "limited":
      return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#FBBF24]" />;
    case "simulated":
      return <FlaskConical className="h-3.5 w-3.5 shrink-0 text-[#94A3B8]" />;
    case "unavailable":
      return <X className="h-3.5 w-3.5 shrink-0 text-[var(--fp-text-2)] opacity-50" />;
    default:
      return <Minus className="h-3.5 w-3.5 shrink-0 text-[var(--fp-text-2)] opacity-50" />;
  }
}

/* ------------------------------------------------------------------ */

export default function IntegrationsPage() {
  const [items, setItems] = useState<IntegrationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Locale from the fp_locale cookie (the app shell has no I18nProvider).
  const [locale] = useState(() => {
    try {
      const m = document.cookie.match(/(?:^|;\s*)fp_locale=(en|ar)/);
      return m?.[1] ?? "en";
    } catch {
      return "en";
    }
  });
  const t: IntegrationsStrings = getIntegrationsStrings(locale);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [disconnectTarget, setDisconnectTarget] = useState<IntegrationItem | null>(null);
  const [webhookBase, setWebhookBase] = useState("");

  // Select-Page modal (Instagram/Facebook OAuth completion)
  const [pageModal, setPageModal] = useState<{ provider: MetaProvider } | null>(null);
  const [pages, setPages] = useState<MetaPage[]>([]);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [selectingPage, setSelectingPage] = useState<string | null>(null);

  // WhatsApp manual-token modal
  const [waManual, setWaManual] = useState(false);
  const [waPhoneNumberId, setWaPhoneNumberId] = useState("");
  const [waAccessToken, setWaAccessToken] = useState("");
  const [waDisplayName, setWaDisplayName] = useState("");
  const [waError, setWaError] = useState<string | null>(null);

  useEffect(() => {
    setWebhookBase(window.location.origin);
  }, []);

  const fetchIntegrations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ integrations: IntegrationItem[] }>("/api/integrations");
      setItems(data.integrations ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshQuiet = useCallback(async () => {
    try {
      const data = await api<{ integrations: IntegrationItem[] }>("/api/integrations");
      setItems(data.integrations ?? []);
    } catch {
      // Non-fatal; per-card notices already carry the outcome.
    }
  }, []);

  useEffect(() => {
    void fetchIntegrations();
  }, [fetchIntegrations]);

  /* Handle the ?tiktok_connected=1 / ?tiktok_error=<message> redirect
     after TikTok Login Kit OAuth. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tErr = params.get("tiktok_error");
    const tOk = params.get("tiktok_connected");
    if (tErr || tOk) {
      window.history.replaceState(null, "", window.location.pathname);
      if (tErr) {
        setCardErrors((e) => ({ ...e, tiktok: `Connection failed: ${tErr}` }));
      } else {
        setNotices((n) => ({
          ...n,
          tiktok: "TikTok authorization completed — account verified and connected.",
        }));
      }
      void refreshQuiet();
    }
  }, [refreshQuiet]);

  /* Handle the ?meta_connected=<provider> / ?meta_error=<message> redirect
     after Meta OAuth. Failures previously landed here silently — surface them. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errMsg = params.get("meta_error");
    if (errMsg) {
      const errProvider = params.get("meta_provider");
      window.history.replaceState(null, "", window.location.pathname);
      const targets =
        errProvider && isMetaProvider(errProvider)
          ? [errProvider]
          : ["facebook", "instagram", "whatsapp"];
      setCardErrors((e) => {
        const next = { ...e };
        for (const p of targets) next[p] = `Connection failed: ${errMsg}`;
        return next;
      });
      return;
    }
    const connected = params.get("meta_connected");
    if (!connected || !isMetaProvider(connected)) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (connected === "whatsapp") {
      setNotices((n) => ({
        ...n,
        whatsapp:
          "Meta authorization completed, but WhatsApp OAuth cannot finish here — connect WhatsApp with a manual token (WABA + phone number ID) instead.",
      }));
      void refreshQuiet();
      return;
    }
    // Instagram Business Login connects the IG account directly — no Page
    // selection step. Facebook still needs the Page picker.
    if (connected === "instagram") {
      setNotices((n) => ({
        ...n,
        instagram: "Instagram connected — account verified.",
      }));
      void refreshQuiet();
      return;
    }
    setNotices((n) => ({
      ...n,
      [connected]: "Meta authorization succeeded — pick the Page to connect.",
    }));
    setPageModal({ provider: connected });
    void refreshQuiet();
  }, [refreshQuiet]);

  /* Fetch pages for the Select-Page modal. */
  useEffect(() => {
    if (!pageModal) return;
    const provider = pageModal.provider;
    setPagesLoading(true);
    setCardErrors((e) => ({ ...e, [provider]: "" }));
    api<{ pages: MetaPage[] }>("/api/integrations/meta/pages", { params: { provider } })
      .then((d) => setPages(d.pages ?? []))
      .catch((e) =>
        setCardErrors((err) => ({
          ...err,
          [provider]: e instanceof ApiError ? `Could not load Pages: ${e.message}` : "Could not load Pages",
        })),
      )
      .finally(() => setPagesLoading(false));
  }, [pageModal]);

  const setItem = (provider: string, patch: Partial<IntegrationItem>) =>
    setItems((prev) => prev.map((i) => (i.provider === provider ? { ...i, ...patch } : i)));

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      await fn();
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  const setNotice = (provider: string, text: string) =>
    setNotices((n) => ({ ...n, [provider]: text }));

  const setCardError = (provider: string, text: string) =>
    setCardErrors((e) => ({ ...e, [provider]: text }));

  /* ---------------- Meta OAuth connect (all three providers) ---------------- */

  const metaAuthorize = (provider: MetaProvider) =>
    withBusy(provider, async () => {
      setNotice(provider, "");
      setCardError(provider, "");
      try {
        const res = await api<{ url: string }>("/api/integrations/meta/authorize", {
          method: "POST",
          body: { provider },
        });
        if (!res.url) throw new Error("No authorization URL returned");
        window.location.href = res.url;
      } catch (e) {
        setCardError(
          provider,
          e instanceof ApiError ? `Connect failed: ${e.message}` : "Connect failed",
        );
      }
    });

  /* ---------------- TikTok Login Kit OAuth ---------------- */

  const tiktokAuthorize = () =>
    withBusy("tiktok", async () => {
      setNotice("tiktok", "");
      setCardError("tiktok", "");
      try {
        const res = await api<{ url: string }>("/api/integrations/tiktok/authorize", {
          method: "POST",
        });
        if (!res.url) throw new Error("No authorization URL returned");
        window.location.href = res.url;
      } catch (e) {
        setCardError(
          "tiktok",
          e instanceof ApiError ? `Connect failed: ${e.message}` : "Connect failed",
        );
      }
    });

  /* ---------------- Select Page (Instagram/Facebook) ---------------- */

  const selectPage = (provider: MetaProvider, pageId: string) => {
    setSelectingPage(pageId);
    api<{ status: string; accountName?: string; accountId?: string }>(
      "/api/integrations/meta/select",
      { method: "POST", body: { provider, pageId } },
    )
      .then((res) => {
        setPageModal(null);
        setNotice(
          provider,
          res.accountName
            ? `Connected as ${res.accountName}.`
            : "Page connected.",
        );
        return refreshQuiet();
      })
      .catch((e) =>
        setCardError(
          provider,
          e instanceof ApiError ? `Page selection failed: ${e.message}` : "Page selection failed",
        ),
      )
      .finally(() => setSelectingPage(null));
  };

  /* ---------------- WhatsApp manual token ---------------- */

  const submitWhatsAppManual = () =>
    withBusy("whatsapp", async () => {
      setWaError(null);
      if (!waPhoneNumberId.trim() || !waAccessToken.trim()) {
        setWaError("Phone Number ID and access token are both required.");
        return;
      }
      try {
        const res = await api<{ status: string; accountName?: string; accountId?: string }>(
          "/api/integrations/meta/whatsapp/manual",
          {
            method: "POST",
            body: {
              phoneNumberId: waPhoneNumberId.trim(),
              accessToken: waAccessToken.trim(),
              ...(waDisplayName.trim() ? { displayName: waDisplayName.trim() } : {}),
            },
          },
        );
        setWaManual(false);
        setWaPhoneNumberId("");
        setWaAccessToken("");
        setWaDisplayName("");
        setNotice(
          "whatsapp",
          res.accountName ? `Connected as ${res.accountName} (token verified by the server).` : "Token verified — WhatsApp connected.",
        );
        await refreshQuiet();
      } catch (e) {
        setWaError(e instanceof ApiError ? e.message : "Failed to save token");
      }
    });

  /* ---------------- Generic catalog actions ---------------- */

  const genericConnect = (item: IntegrationItem) =>
    withBusy(item.provider, async () => {
      setNotice(item.provider, "");
      setCardError(item.provider, "");
      try {
        const res = await api<{ status: string; message?: string }>(
          `/api/integrations/${item.provider}/connect`,
          { method: "POST" },
        );
        setItem(item.provider, { status: res.status ?? "NEEDS_ATTENTION" });
        setNotice(
          item.provider,
          res.message ??
            "Connection started — verification is required before the provider can be used.",
        );
        await refreshQuiet();
      } catch (e) {
        setCardError(
          item.provider,
          e instanceof ApiError ? `Connect failed: ${e.message}` : "Connect failed",
        );
      }
    });

  const genericVerify = (item: IntegrationItem) =>
    withBusy(item.provider, async () => {
      setNotice(item.provider, "");
      setCardError(item.provider, "");
      try {
        if (!item.id) throw new Error("No integration record to verify yet");
        const res = await api<{ status: string }>(`/api/integrations/${item.id}/verify`, {
          method: "POST",
        });
        setItem(item.provider, {
          status: res.status ?? "CONNECTED",
          verifiedAt: new Date().toISOString(),
        });
        setNotice(item.provider, "Verified — provider is connected.");
      } catch (e) {
        setCardError(
          item.provider,
          e instanceof ApiError ? `Verify failed: ${e.message}` : `Verify failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
    });

  const testConnection = (item: IntegrationItem) =>
    withBusy(`${item.provider}:test`, async () => {
      setCardError(item.provider, "");
      try {
        if (!item.id) throw new Error("Connect the provider before testing");
        const res = await api<TestResult>(`/api/integrations/${item.id}/test`, { method: "POST" });
        setTestResults((t) => ({ ...t, [item.provider]: res }));
      } catch (e) {
        setCardError(
          item.provider,
          e instanceof ApiError ? `Test failed: ${e.message}` : "Test failed",
        );
      }
    });

  const confirmDisconnect = async () => {
    if (!disconnectTarget?.id) {
      setDisconnectTarget(null);
      return;
    }
    const provider = disconnectTarget.provider;
    const id = disconnectTarget.id;
    setDisconnectTarget(null);
    await withBusy(provider, async () => {
      try {
        await api(`/api/integrations/${id}/disconnect`, { method: "POST" });
        setItem(provider, { status: "DISCONNECTED" });
        setNotice(provider, "Disconnected.");
      } catch (e) {
        setCardError(
          provider,
          e instanceof ApiError ? `Disconnect failed: ${e.message}` : "Disconnect failed",
        );
      }
    });
  };

  const toggleExpanded = (provider: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });

  /* ---------------- Render helpers ---------------- */

  const itemsByProvider = new Map(items.map((i) => [i.provider, i]));
  const metaItems: (IntegrationItem & { provider: MetaProvider })[] = META_PROVIDERS.map((p) => {
    const meta = META_CARD_META[p];
    const existing = itemsByProvider.get(p);
    return {
      ...existing,
      provider: p,
      displayName: existing?.displayName ?? meta.title,
      category: existing?.category ?? "messaging",
      capabilities: existing?.capabilities ?? meta.defaultCapabilities,
      limitations: existing?.limitations ?? [],
      requiredPermissions: existing?.requiredPermissions ?? [],
      status: existing?.status ?? "DISCONNECTED",
    };
  });
  const otherItems = items.filter((i) => !isMetaProvider(i.provider));

  const renderStatusBadge = (item: IntegrationItem) => {
    const state = connectionStateOf(item);
    return (
      <Badge
        tone={CONNECTION_STATE_TONES[state]}
        title={t.stateHints[state]}
      >
        {t.states[state]}
      </Badge>
    );
  };

  const renderNotice = (provider: string) => {
    const notice = notices[provider];
    if (!notice) return null;
    return (
      <p className="flex items-start gap-1.5 rounded-lg bg-[#34D399]/10 px-3 py-2 text-xs text-[#6EE7B7]">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {notice}
      </p>
    );
  };

  const renderCardError = (provider: string) => {
    const err = cardErrors[provider];
    if (!err) return null;
    return (
      <p className="flex items-start gap-1.5 rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-3 py-2 text-xs text-[#FB7185]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {err}
      </p>
    );
  };

  const renderTestResult = (provider: string) => {
    const res = testResults[provider];
    if (!res) return null;
    return (
      <p className="rounded-lg bg-[var(--fp-bg-2)] px-3 py-2 text-xs text-[var(--fp-text-2)]">
        Test {res.ok ? "passed" : "failed"} — {res.latencyMs}ms
        {res.mocked && " (mock)"}.{res.note ? ` ${res.note}` : ""}
      </p>
    );
  };

  /* Account identity: avatar + name when the provider's identity API
     returned them; an honest "unavailable" note when connected without
     identity (never guessed or placeholder data). */
  const renderAccountIdentity = (item: IntegrationItem) => {
    if (item.status !== "CONNECTED") return null;
    if (item.accountName || item.accountId) {
      return (
        <div className="flex items-center gap-2.5">
          {item.accountAvatarUrl ? (
            <img
              src={item.accountAvatarUrl}
              alt=""
              className="h-9 w-9 shrink-0 rounded-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--fp-bg-2)] text-sm font-semibold text-[var(--fp-text-2)]">
              {(item.accountName ?? "?").slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            {item.accountName && (
              <p className="truncate text-sm font-medium text-[var(--fp-text)]">{item.accountName}</p>
            )}
            {item.accountId && (
              <p className="truncate font-mono text-[11px] text-[var(--fp-text-2)]">ID: {item.accountId}</p>
            )}
          </div>
        </div>
      );
    }
    return (
      <p className="text-xs italic text-[var(--fp-text-2)]" title="The provider confirmed the connection but its identity API did not return account details.">
        Connected, account details unavailable
      </p>
    );
  };

  /* Honest capability display, driven by src/lib/integrations/capabilities.ts:
     each capability resolves to available / limited / unavailable /
     not_connected / simulated based on the platform truth AND the actual
     authorization state. Hover (title) carries the honest note. */
  const renderCapabilities = (item: IntegrationItem) => {
    const details = item.capabilitiesDetail;
    if (!details || details.length === 0) {
      // Defensive fallback: raw catalog chips when the API predates the matrix.
      return (
        <div className="flex flex-wrap gap-1.5">
          {item.capabilities.map((c) => (
            <span
              key={c}
              className="rounded-md bg-[var(--fp-bg-2)] px-2 py-1 font-mono text-[11px] text-[var(--fp-text-2)]"
            >
              {c}
            </span>
          ))}
        </div>
      );
    }
    return (
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">
          {t.ui.capabilitiesHeading}
        </p>
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {details.map((d) => (
            <li
              key={d.key}
              title={`${t.capabilityStates[d.state]} — ${d.note}`}
              className={`flex items-center gap-2 rounded-md px-2 py-1 text-xs ${
                d.state === "unavailable" || d.state === "not_connected"
                  ? "text-[var(--fp-text-2)] opacity-70"
                  : "text-[var(--fp-text)]"
              }`}
            >
              {capabilityIcon(d.state)}
              <span className="truncate">{t.capabilities[d.key]}</span>
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-[var(--fp-text-2)]">
                {t.capabilityStates[d.state]}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  /* Surface the last recorded connection failure / setup blocker on the card.
     The message comes from statusDetail (safe, user-facing — never tokens). */
  const renderConnectionIssue = (item: IntegrationItem) => {
    const state = connectionStateOf(item);
    if (state === "unavailable") {
      return (
        <p className="flex items-start gap-1.5 rounded-lg border border-[#FBBF24]/30 bg-[#FBBF24]/10 px-3 py-2 text-xs text-[#FBBF24]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-semibold">{t.ui.setupRequired}. </span>
            {t.stateHints.unavailable}
          </span>
        </p>
      );
    }
    if (
      (state === "failed" || state === "permission_missing" || state === "reauth_required") &&
      item.statusDetailMessage
    ) {
      return (
        <p className="flex items-start gap-1.5 rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-3 py-2 text-xs text-[#FB7185]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-semibold">{t.ui.connectionIssue}: </span>
            {item.statusDetailMessage}
          </span>
        </p>
      );
    }
    return null;
  };

  const renderDisconnectTest = (item: IntegrationItem, isMeta: boolean) => (
    <div className="flex flex-wrap gap-2 pt-1">
      {item.id && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void testConnection(item)}
          loading={!!busy[`${item.provider}:test`]}
          disabled={!!busy[item.provider]}
        >
          <Zap className="h-3.5 w-3.5" /> Test connection
        </Button>
      )}
      {item.id && item.status !== "DISCONNECTED" && (
        <Button
          size="sm"
          variant="danger"
          onClick={() => setDisconnectTarget(item)}
          disabled={!!busy[item.provider]}
        >
          <Unplug className="h-3.5 w-3.5" /> Disconnect
        </Button>
      )}
      {isMeta && !item.id && (
        <p className="text-xs text-[var(--fp-text-2)]">
          Connect to enable testing and disconnection.
        </p>
      )}
    </div>
  );

  /* ---------------- Meta rich cards ---------------- */

  const renderMetaCard = (item: (IntegrationItem & { provider: MetaProvider })) => {
    const meta = META_CARD_META[item.provider];
    const Icon = meta.icon;
    const provider = item.provider;
    const connected = item.status === "CONNECTED";
    const isOpen = expanded.has(provider);
    const isBusy = !!busy[provider];
    const webhookUrl = webhookBase ? `${webhookBase}/api/webhooks/meta` : "/api/webhooks/meta";

    return (
      <Card key={provider}>
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--fp-bg-2)]">
              <Icon className="h-5 w-5 text-[var(--fp-text)]" />
            </div>
            <div>
              <CardTitle>{meta.title}</CardTitle>
              <p className="mt-0.5 text-xs text-[var(--fp-text-2)]">{meta.description}</p>
              <div className="mt-1.5">{renderAccountIdentity(item)}</div>
            </div>
          </div>
          {renderStatusBadge(item)}
        </CardHeader>
        <CardContent className="space-y-3">
          {renderCapabilities(item)}
          {renderConnectionIssue(item)}

          <button
            onClick={() => toggleExpanded(provider)}
            aria-expanded={isOpen}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
            Setup instructions
          </button>

          {isOpen && (
            <div className="space-y-2 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3 text-xs">
              <p className="flex items-center gap-1.5 font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">
                <BookOpen className="h-3.5 w-3.5" /> Meta dashboard steps
              </p>
              <ol className="list-decimal space-y-1.5 pl-4 text-[var(--fp-text-2)]">
                {meta.setupSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <div className="rounded-md bg-[var(--fp-card)] p-2.5">
                <p className="mb-1 font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">
                  Webhook callback URL
                </p>
                <p className="break-all font-mono text-[var(--fp-text)]">{webhookUrl}</p>
                <p className="mt-1 text-[var(--fp-text-2)]">
                  Paste this URL as the Callback URL in your Meta app&apos;s Webhooks settings.
                  It uses this FlowPilot instance&apos;s public address — if you are running behind a
                  tunnel or proxy, prefix the path <span className="font-mono">/api/webhooks/meta</span>{" "}
                  with your own public URL instead.
                </p>
              </div>
              {item.docsUrl && (
                <a
                  href={item.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[#22D3EE] hover:underline"
                >
                  Provider docs <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

          {renderCardError(provider)}
          {renderNotice(provider)}
          {renderTestResult(provider)}

          <div className="flex flex-wrap gap-2 pt-1">
            {connected ? (
              <Button size="sm" variant="secondary" onClick={() => void metaAuthorize(provider)} loading={isBusy}>
                <Plug className="h-3.5 w-3.5" /> Reconnect
              </Button>
            ) : (
              <Button size="sm" onClick={() => void metaAuthorize(provider)} loading={isBusy}>
                <Plug className="h-3.5 w-3.5" /> Connect with Meta
              </Button>
            )}
            {provider === "whatsapp" && !connected && (
              <Button size="sm" variant="secondary" onClick={() => setWaManual(true)} disabled={isBusy}>
                <KeyRound className="h-3.5 w-3.5" /> Enter token manually
              </Button>
            )}
          </div>

          {renderDisconnectTest(item, true)}
        </CardContent>
      </Card>
    );
  };

  /* ---------------- Generic catalog cards ---------------- */

  const renderGenericCard = (item: IntegrationItem) => {
    const isOpen = expanded.has(item.provider);
    const connected = item.status === "CONNECTED";
    const needsAttention = item.status === "NEEDS_ATTENTION";
    const isBusy = !!busy[item.provider];
    const isTikTok = item.provider === "tiktok";

    return (
      <Card key={item.provider}>
        <CardHeader>
          <div>
            <CardTitle>{item.displayName}</CardTitle>
            <p className="mt-0.5 text-xs capitalize text-[var(--fp-text-2)]">{item.category}</p>
          </div>
          <div className="flex items-center gap-2">
            {item.simulated && (
              <Badge
                tone="gray"
                title="This provider has no real OAuth integration yet — connections and messages are simulated for demo purposes."
              >
                SIMULATED
              </Badge>
            )}
            {renderStatusBadge(item)}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {renderAccountIdentity(item)}
          {renderCapabilities(item)}
          {renderConnectionIssue(item)}

          <button
            onClick={() => toggleExpanded(item.provider)}
            aria-expanded={isOpen}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
            View capabilities & limitations
          </button>

          {isOpen && (
            <div className="space-y-2 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3 text-xs">
              <div>
                <p className="mb-1 font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">Limitations</p>
                {item.limitations.length === 0 ? (
                  <p className="text-[var(--fp-text-2)]">None documented.</p>
                ) : (
                  <ul className="list-disc space-y-1 pl-4 text-[var(--fp-text-2)]">
                    {item.limitations.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="mb-1 font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">Required permissions</p>
                {item.requiredPermissions.length === 0 ? (
                  <p className="text-[var(--fp-text-2)]">None.</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {item.requiredPermissions.map((p) => (
                      <span key={p} className="rounded bg-[var(--fp-card)] px-2 py-0.5 font-mono text-[var(--fp-text-2)]">{p}</span>
                    ))}
                  </div>
                )}
              </div>
              {item.docsUrl && (
                <a href={item.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#22D3EE] hover:underline">
                  Provider docs <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {item.verifiedAt && (
                <p className="flex items-center gap-1 text-[#34D399]">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Verified {new Date(item.verifiedAt).toLocaleDateString()}
                </p>
              )}
              {item.lastSyncAt && (
                <p className="text-[var(--fp-text-2)]">Last sync {new Date(item.lastSyncAt).toLocaleString()}</p>
              )}
            </div>
          )}

          {renderCardError(item.provider)}
          {renderNotice(item.provider)}
          {renderTestResult(item.provider)}

          <div className="flex flex-wrap gap-2 pt-1">
            {isTikTok ? (
              connected ? (
                <Button size="sm" variant="secondary" onClick={() => void tiktokAuthorize()} loading={isBusy}>
                  <Plug className="h-3.5 w-3.5" /> Reconnect
                </Button>
              ) : (
                <Button size="sm" onClick={() => void tiktokAuthorize()} loading={isBusy}>
                  <Plug className="h-3.5 w-3.5" /> Connect with TikTok
                </Button>
              )
            ) : (
              <>
                {!connected && !needsAttention && (
                  <Button size="sm" onClick={() => void genericConnect(item)} loading={isBusy}>
                    <Plug className="h-3.5 w-3.5" /> Connect
                  </Button>
                )}
                {needsAttention && (
                  <Button size="sm" onClick={() => void genericVerify(item)} loading={isBusy}>
                    <CheckCircle2 className="h-3.5 w-3.5" /> Verify
                  </Button>
                )}
              </>
            )}
            {item.id && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void testConnection(item)}
                loading={!!busy[`${item.provider}:test`]}
                disabled={isBusy}
              >
                <Zap className="h-3.5 w-3.5" /> Test
              </Button>
            )}
            {item.id && item.status !== "DISCONNECTED" && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => setDisconnectTarget(item)}
                disabled={isBusy}
              >
                <Unplug className="h-3.5 w-3.5" /> Disconnect
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  /* ---------------- Page ---------------- */

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connect the channels and tools FlowPilot works with."
      />

      {error && (
        <p className="mb-4 rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-4 py-2 text-sm text-[#FB7185]">
          {error}
        </p>
      )}

      {loading ? (
        <Spinner label="Loading integrations…" />
      ) : (
        <>
          <section className="mb-8">
            <h2 className="mb-1 text-base font-semibold text-[var(--fp-text)]">Official Meta integrations</h2>
            <p className="mb-4 text-sm text-[var(--fp-text-2)]">
              Connect your Meta channels directly — OAuth, page selection, and manual token setup are all supported.
            </p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {metaItems.map(renderMetaCard)}
            </div>
          </section>

          <section>
            <h2 className="mb-1 text-base font-semibold text-[var(--fp-text)]">Other providers</h2>
            <p className="mb-4 text-sm text-[var(--fp-text-2)]">
              Additional channels and tools available in the FlowPilot catalog.
            </p>
            {otherItems.length === 0 ? (
              <EmptyState icon={Plug} title="No other providers" description="The catalog only lists the Meta integrations right now." />
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {otherItems.map(renderGenericCard)}
              </div>
            )}
          </section>
        </>
      )}

      {/* Disconnect confirmation */}
      <Modal open={!!disconnectTarget} onClose={() => setDisconnectTarget(null)} title="Disconnect provider">
        <p className="text-sm text-[var(--fp-text-2)]">
          Disconnect <span className="font-semibold text-[var(--fp-text)]">{disconnectTarget?.displayName}</span>?
          Automations using it will stop until it is reconnected.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDisconnectTarget(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirmDisconnect()}>Disconnect</Button>
        </div>
      </Modal>

      {/* Select Page (Instagram / Facebook OAuth completion) */}
      <Modal
        open={!!pageModal}
        onClose={() => setPageModal(null)}
        title={`Select a Page — ${pageModal ? META_CARD_META[pageModal.provider].title : ""}`}
      >
        {pagesLoading ? (
          <Spinner label="Loading Pages…" />
        ) : pages.length === 0 ? (
          <p className="text-sm text-[var(--fp-text-2)]">
            No Pages were returned for this Meta account. Make sure the account has a Facebook Page
            (with a linked Instagram account for Instagram Messaging) and try connecting again.
          </p>
        ) : (
          <ul className="space-y-2">
            {pages.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--fp-text)]">{p.name}</p>
                  <p className="font-mono text-[11px] text-[var(--fp-text-2)]">Page ID: {p.id}</p>
                  {p.hasInstagram && (
                    <Badge tone="violet" className="mt-1">Instagram linked</Badge>
                  )}
                </div>
                <Button
                  size="sm"
                  loading={selectingPage === p.id}
                  disabled={selectingPage !== null}
                  onClick={() => pageModal && selectPage(pageModal.provider, p.id)}
                >
                  Select
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      {/* WhatsApp manual token */}
      <Modal open={waManual} onClose={() => setWaManual(false)} title="Enter WhatsApp token manually">
        <div className="space-y-3">
          <p className="text-sm text-[var(--fp-text-2)]">
            Paste the credentials from your Meta app under WhatsApp → API Setup. The server verifies
            the token before the integration is marked connected.
          </p>
          <Input
            label="Phone Number ID"
            value={waPhoneNumberId}
            onChange={(e) => setWaPhoneNumberId(e.target.value)}
            placeholder="e.g. 123456789012345"
            autoComplete="off"
          />
          <Input
            label="Access token"
            value={waAccessToken}
            onChange={(e) => setWaAccessToken(e.target.value)}
            placeholder="Paste the WhatsApp access token"
            autoComplete="off"
          />
          <Input
            label="Display name (optional)"
            value={waDisplayName}
            onChange={(e) => setWaDisplayName(e.target.value)}
            placeholder="e.g. Acme Support"
            autoComplete="off"
          />
          {waError && (
            <p className="flex items-start gap-1.5 rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-3 py-2 text-xs text-[#FB7185]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {waError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setWaManual(false)}>Cancel</Button>
            <Button onClick={() => void submitWhatsAppManual()} loading={!!busy.whatsapp}>
              <KeyRound className="h-3.5 w-3.5" /> Save & verify
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
