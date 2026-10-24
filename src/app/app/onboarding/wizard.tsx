"use client";

/**
 * Onboarding wizard (Phase 4).
 * 10 steps: welcome → workspace → language/timezone → use case → connect
 * first account → permissions review → first workflow → safe test (Simulate)
 * → activate (explicit confirm only) → measure.
 *
 * Progress persists via /api/onboarding/progress (resumable). "Skip for now"
 * is always available. NEVER auto-activates a live workflow or external action.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Globe2,
  Link2,
  Play,
  ShieldCheck,
  Sparkles,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import { api, ApiError, useWorkspaces } from "@/lib/api-client";
import { setLocaleClient } from "@/i18n/client";
import type { en as enFrag } from "@/i18n/fragments/onboarding";
import { Button } from "@/components/ui/Button";
import { PageSpinner } from "@/components/ui/Spinner";

type T = typeof enFrag;

const STEP_IDS = [
  "welcome",
  "workspace",
  "language",
  "usecase",
  "connect",
  "permissions",
  "workflow",
  "simulate",
  "activate",
  "measure",
] as const;

type StepId = (typeof STEP_IDS)[number];

const TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Athens",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Australia/Sydney",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
];

interface IntegrationRow {
  provider: string;
  displayName: string;
  status: string;
  limitations: string[];
  requiredPermissions: string[];
}

interface WorkflowRow {
  id: string;
  name: string;
  status: string;
}

const STEP_ICONS: Record<StepId, React.ReactNode> = {
  welcome: <Sparkles className="h-5 w-5" aria-hidden />,
  workspace: <Zap className="h-5 w-5" aria-hidden />,
  language: <Globe2 className="h-5 w-5" aria-hidden />,
  usecase: <CheckCircle2 className="h-5 w-5" aria-hidden />,
  connect: <Link2 className="h-5 w-5" aria-hidden />,
  permissions: <ShieldCheck className="h-5 w-5" aria-hidden />,
  workflow: <WorkflowIcon className="h-5 w-5" aria-hidden />,
  simulate: <Play className="h-5 w-5" aria-hidden />,
  activate: <Zap className="h-5 w-5" aria-hidden />,
  measure: <Check className="h-5 w-5" aria-hidden />,
};

const STEP_TITLES: Record<StepId, (t: T) => string> = {
  welcome: (t) => t.s1_title,
  workspace: (t) => t.s2_title,
  language: (t) => t.s3_title,
  usecase: (t) => t.s4_title,
  connect: (t) => t.s5_title,
  permissions: (t) => t.s6_title,
  workflow: (t) => t.s7_title,
  simulate: (t) => t.s8_title,
  activate: (t) => t.s9_title,
  measure: (t) => t.s10_title,
};

export default function OnboardingWizard({ t }: { t: T }) {
  const router = useRouter();
  const { current: workspace, loading: wsLoading } = useWorkspaces();

  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [user, setUser] = useState<{ name: string; email: string } | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationRow[] | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per-step UI state
  const [locale, setLocale] = useState("en");
  const [timezone, setTimezone] = useState("UTC");
  const [useCase, setUseCase] = useState<string | null>(null);
  const [permsAck, setPermsAck] = useState(false);
  const [activateId, setActivateId] = useState<string | null>(null);
  const [activateAck, setActivateAck] = useState(false);
  const [activating, setActivating] = useState(false);

  const step = STEP_IDS[idx];

  // Load persisted progress (resumable).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await api<{ progress: { currentStep: number; stepsDone: string[]; skipped: string[]; data: Record<string, unknown>; completedAt: string | null } }>(
          "/api/onboarding/progress"
        );
        if (cancelled) return;
        if (p.progress.completedAt) {
          router.replace("/app/overview");
          return;
        }
        setIdx(Math.min(p.progress.currentStep, STEP_IDS.length - 1));
        setDone(p.progress.stepsDone);
        setSkipped(p.progress.skipped);
        setData(p.progress.data);
        const d = p.progress.data;
        if (typeof d.locale === "string") setLocale(d.locale);
        if (typeof d.timezone === "string") setTimezone(d.timezone);
        if (typeof d.useCase === "string") setUseCase(d.useCase);
      } catch {
        // Fresh start — progress will be created on first save.
      } finally {
        if (!cancelled) setLoading(false);
      }
      try {
        const raw = await api<unknown>("/api/auth/me");
        const u = raw && typeof raw === "object" && "user" in raw ? (raw as { user: unknown }).user : raw;
        if (u && typeof u === "object") {
          const o = u as Record<string, unknown>;
          if (typeof o.name === "string" && typeof o.email === "string")
            setUser({ name: o.name, email: o.email });
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const loadIntegrations = useCallback(async () => {
    if (integrations) return;
    try {
      const r = await api<{ integrations: IntegrationRow[] }>("/api/integrations");
      setIntegrations(r.integrations);
    } catch {
      setIntegrations([]);
    }
  }, [integrations]);

  const loadWorkflows = useCallback(async () => {
    if (workflows) return;
    try {
      const r = await api<WorkflowRow[]>("/api/workflows");
      setWorkflows(Array.isArray(r) ? r : []);
    } catch {
      setWorkflows([]);
    }
  }, [workflows]);

  useEffect(() => {
    if (step === "connect") void loadIntegrations();
    if (step === "workflow" || step === "activate") void loadWorkflows();
  }, [step, loadIntegrations, loadWorkflows]);

  const saveState = useCallback(
    async (s: {
      idx: number;
      done: string[];
      skipped: string[];
      data: Record<string, unknown>;
      completed?: boolean;
    }) => {
      setSaving(true);
      setError(null);
      try {
        await api("/api/onboarding/progress", {
          method: "PUT",
          body: {
            currentStep: s.idx,
            stepsDone: s.done,
            skipped: s.skipped,
            data: s.data,
            completed: s.completed,
          },
        });
        setIdx(s.idx);
        setDone(s.done);
        setSkipped(s.skipped);
        setData(s.data);
        if (s.completed) router.replace("/app/overview");
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not save progress. Please try again.");
      } finally {
        setSaving(false);
      }
    },
    [router]
  );

  /** Advance one step, optionally marking the current step done (else skipped). */
  const advance = useCallback(
    (markDone: boolean, dataOverride?: Record<string, unknown>) => {
      const id = STEP_IDS[idx];
      const d = dataOverride ?? data;
      const nextDone = markDone ? Array.from(new Set([...done, id])) : done;
      const nextSkipped = markDone ? skipped : Array.from(new Set([...skipped, id]));
      const isLast = idx >= STEP_IDS.length - 1;
      if (isLast) {
        void saveState({ idx, done: nextDone, skipped: nextSkipped, data: d, completed: true });
      } else {
        void saveState({ idx: idx + 1, done: nextDone, skipped: nextSkipped, data: d });
      }
    },
    [idx, done, skipped, data, saveState]
  );

  const skip = useCallback(() => advance(false), [advance]);

  const continueStep = useCallback(() => {
    // Step-specific persistence before advancing.
    if (step === "language") {
      const nextData = { ...data, locale, timezone };
      // Persist first so the locale reload resumes at the right place.
      void saveState({ idx, done, skipped, data: nextData }).then(() => {
        try {
          const current = document.cookie.match(/(?:^|; )fp_locale=([^;]*)/)?.[1];
          if (locale !== current) {
            setLocaleClient(locale as "en" | "ar");
            return;
          }
        } catch {
          /* fall through */
        }
        advance(true, nextData);
      });
      return;
    }
    if (step === "usecase" && useCase) {
      advance(true, { ...data, useCase });
      return;
    }
    advance(true);
  }, [step, idx, done, skipped, data, locale, timezone, useCase, saveState, advance]);

  const goBack = useCallback(() => {
    if (idx > 0) void saveState({ idx: idx - 1, done, skipped, data });
  }, [idx, done, skipped, data, saveState]);

  const jumpTo = useCallback(
    (i: number) => {
      void saveState({ idx: i, done, skipped, data });
    },
    [done, skipped, data, saveState]
  );

  const activateWorkflow = useCallback(async () => {
    if (!activateId || !activateAck) return;
    setActivating(true);
    setError(null);
    try {
      await api(`/api/workflows/${activateId}/publish`, { method: "POST" });
      const nextData = { ...data, activatedWorkflowId: activateId };
      setWorkflows((w) => w?.map((x) => (x.id === activateId ? { ...x, status: "PUBLISHED" } : x)) ?? w);
      // Activation counts as the step being done.
      void saveState({
        idx: idx + 1,
        done: Array.from(new Set([...done, step])),
        skipped,
        data: nextData,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Activation failed. Please try again.");
    } finally {
      setActivating(false);
    }
  }, [activateId, activateAck, data, idx, done, step, skipped, saveState]);

  const drafts = useMemo(() => workflows?.filter((w) => w.status === "DRAFT") ?? [], [workflows]);
  const hasWorkflow = (workflows?.length ?? 0) > 0;

  if (loading || wsLoading) return <PageSpinner label={t.title} />;

  const progressPct = Math.round(((done.length + skipped.length) / STEP_IDS.length) * 100);

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header + progress */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-bold text-[var(--fp-text)]">{t.title}</h1>
          <Link
            href="/docs/guides"
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-card)] px-3 py-1.5 text-xs font-medium text-[var(--fp-accent-2)] hover:border-[var(--fp-accent)]/50"
          >
            {t.readDocs} ↗
          </Link>
        </div>
        <p className="mt-1 text-sm text-[var(--fp-text-2)]">{t.subtitle}</p>
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-[var(--fp-text-2)]">
            <span>
              {t.stepOf.replace("{current}", String(idx + 1)).replace("{total}", String(STEP_IDS.length))}
            </span>
            <span>{saving ? t.saving : progressPct > 0 ? `${progressPct}%` : ""}</span>
          </div>
          <div className="mt-1.5 flex gap-1.5" aria-hidden>
            {STEP_IDS.map((id, i) => (
              <div
                key={id}
                className={`h-1.5 flex-1 rounded-full ${
                  done.includes(id) || skipped.includes(id)
                    ? "bg-[var(--fp-accent)]"
                    : i === idx
                      ? "bg-[var(--fp-accent-2)]"
                      : "bg-[var(--fp-border)]"
                }`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {STEP_IDS.map((id, i) => (
              <span
                key={id}
                title={STEP_TITLES[id](t)}
                className={`flex h-7 w-7 items-center justify-center rounded-lg border text-[var(--fp-text-2)] ${
                  done.includes(id)
                    ? "border-[#34D399]/40 bg-[#34D399]/10 text-[#6EE7B7]"
                    : i === idx
                      ? "border-[var(--fp-accent)]/50 bg-[var(--fp-accent)]/10 text-[var(--fp-accent)]"
                      : "border-[var(--fp-border)] bg-[var(--fp-card)]"
                }`}
              >
                {done.includes(id) ? <Check className="h-3.5 w-3.5" aria-hidden /> : STEP_ICONS[id]}
              </span>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-[#FB7185]/30 bg-[#FB7185]/10 px-4 py-3 text-sm text-[#FDA4AF]">
          {error}
        </div>
      )}

      {/* Step card */}
      <div className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-6 shadow-card sm:p-8">
        <h2 className="text-xl font-semibold text-[var(--fp-text)]">{STEP_TITLES[step](t)}</h2>

        <div className="mt-4 text-sm text-[var(--fp-text-2)]">
          {step === "welcome" && (
            <>
              <p>{t.s1_body}</p>
              {user && (
                <p className="mt-3 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-3 text-[var(--fp-text)]">
                  {user.name} · {user.email}
                </p>
              )}
            </>
          )}

          {step === "workspace" && (
            <>
              <p>{t.s2_body}</p>
              <p className="mt-3 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-3 text-[var(--fp-text)]">
                {workspace ? workspace.name : t.noWorkspace}
              </p>
            </>
          )}

          {step === "language" && (
            <>
              <p>{t.s3_body}</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[var(--fp-text)]">{t.language}</span>
                  <select
                    value={locale}
                    onChange={(e) => setLocale(e.target.value)}
                    className="w-full rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-3 py-2.5 text-sm text-[var(--fp-text)]"
                  >
                    <option value="en">English</option>
                    <option value="ar">العربية</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[var(--fp-text)]">{t.timezone}</span>
                  <select
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    className="w-full rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-3 py-2.5 text-sm text-[var(--fp-text)]"
                  >
                    {TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}

          {step === "usecase" && (
            <>
              <p>{t.s4_body}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["lead_gen", t.useCases.lead_gen, t.useCases.lead_gen_d],
                    ["support", t.useCases.support, t.useCases.support_d],
                    ["ecommerce", t.useCases.ecommerce, t.useCases.ecommerce_d],
                    ["marketing", t.useCases.marketing, t.useCases.marketing_d],
                  ] as const
                ).map(([id, label, desc]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setUseCase(id)}
                    className={`rounded-xl border p-4 text-left transition ${
                      useCase === id
                        ? "border-[var(--fp-accent)] bg-[var(--fp-accent)]/10"
                        : "border-[var(--fp-border)] bg-[var(--fp-bg)] hover:border-[var(--fp-accent)]/40"
                    }`}
                  >
                    <div className="text-sm font-semibold text-[var(--fp-text)]">{label}</div>
                    <div className="mt-1 text-xs text-[var(--fp-text-2)]">{desc}</div>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === "connect" && (
            <>
              <p>{t.s5_body}</p>
              <div className="mt-4 space-y-2">
                {(integrations ?? []).slice(0, 6).map((p) => (
                  <div
                    key={p.provider}
                    className="flex items-center justify-between rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-2.5"
                  >
                    <span className="text-sm font-medium text-[var(--fp-text)]">{p.displayName}</span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        p.status === "CONNECTED"
                          ? "bg-[#34D399]/10 text-[#6EE7B7]"
                          : "bg-[var(--fp-border)]/40 text-[var(--fp-text-2)]"
                      }`}
                    >
                      {p.status === "CONNECTED" ? "✓" : "—"} {p.status}
                    </span>
                  </div>
                ))}
              </div>
              <Link href="/app/integrations" className="mt-4 inline-block">
                <Button variant="secondary">
                  <Link2 className="mr-2 h-4 w-4" aria-hidden />
                  {t.openIntegrations}
                </Button>
              </Link>
            </>
          )}

          {step === "permissions" && (
            <>
              <p>{t.s6_body}</p>
              <ul className="mt-4 space-y-2 text-sm">
                {(integrations ?? [])
                  .filter((p) => p.status === "CONNECTED")
                  .flatMap((p) => p.limitations.map((l) => ({ provider: p.displayName, text: l })))
                  .slice(0, 8)
                  .map((l, i) => (
                    <li key={i} className="flex gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-2.5">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--fp-accent-2)]" aria-hidden />
                      <span>
                        <strong className="text-[var(--fp-text)]">{l.provider}:</strong> {l.text}
                      </span>
                    </li>
                  ))}
              </ul>
              <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm text-[var(--fp-text)]">
                <input
                  type="checkbox"
                  checked={permsAck}
                  onChange={(e) => setPermsAck(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-[#8B5CF6]"
                />
                {t.s6_ack}
              </label>
            </>
          )}

          {step === "workflow" && (
            <>
              <p>{t.s7_body}</p>
              {workflows === null ? (
                <p className="mt-4 text-sm">{t.saving}</p>
              ) : hasWorkflow ? (
                <p className="mt-4 flex items-center gap-2 rounded-xl border border-[#34D399]/30 bg-[#34D399]/10 px-4 py-3 text-sm text-[#6EE7B7]">
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  {t.s7_created}
                </p>
              ) : (
                <p className="mt-4 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-3 text-sm">
                  {t.s7_none}
                </p>
              )}
              <Link href="/app/automations" className="mt-4 inline-block">
                <Button variant="secondary">
                  <WorkflowIcon className="mr-2 h-4 w-4" aria-hidden />
                  {t.browseTemplates}
                </Button>
              </Link>
            </>
          )}

          {step === "simulate" && (
            <>
              <p>{t.s8_body}</p>
              <Link href="/app/automations" className="mt-4 inline-block">
                <Button variant="secondary">
                  <Play className="mr-2 h-4 w-4" aria-hidden />
                  {t.openAutomations}
                </Button>
              </Link>
            </>
          )}

          {step === "activate" && (
            <>
              <p>{t.s9_body}</p>
              <p className="mt-3 rounded-xl border border-[#FBBF24]/30 bg-[#FBBF24]/10 px-4 py-3 text-sm text-[#FCD34D]">
                {t.s9_warn}
              </p>
              {workflows === null ? (
                <p className="mt-4 text-sm">{t.saving}</p>
              ) : drafts.length === 0 ? (
                <p className="mt-4 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-3 text-sm">
                  {t.noWorkflows}
                </p>
              ) : (
                <div className="mt-4 space-y-2">
                  <span className="text-xs font-medium text-[var(--fp-text)]">{t.selectWorkflow}</span>
                  {drafts.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => setActivateId(w.id)}
                      className={`block w-full rounded-xl border px-4 py-2.5 text-left text-sm ${
                        activateId === w.id
                          ? "border-[var(--fp-accent)] bg-[var(--fp-accent)]/10 text-[var(--fp-text)]"
                          : "border-[var(--fp-border)] bg-[var(--fp-bg)] text-[var(--fp-text)] hover:border-[var(--fp-accent)]/40"
                      }`}
                    >
                      {w.name}
                    </button>
                  ))}
                </div>
              )}
              {drafts.length > 0 && (
                <>
                  <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm text-[var(--fp-text)]">
                    <input
                      type="checkbox"
                      checked={activateAck}
                      onChange={(e) => setActivateAck(e.target.checked)}
                      className="mt-1 h-4 w-4 accent-[#8B5CF6]"
                    />
                    {t.s9_ack}
                  </label>
                  <Button
                    className="mt-3"
                    disabled={!activateId || !activateAck || activating}
                    onClick={activateWorkflow}
                  >
                    {activating ? t.saving : t.activate}
                  </Button>
                  {data.activatedWorkflowId != null && (
                    <p className="mt-3 flex items-center gap-2 text-sm text-[#6EE7B7]">
                      <CheckCircle2 className="h-4 w-4" aria-hidden />
                      {t.activated}
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {step === "measure" && (
            <>
              <p>{t.s10_body}</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link href="/app/overview">
                  <Button variant="secondary">{t.openOverview}</Button>
                </Link>
                <Link href="/app/analytics">
                  <Button variant="secondary">{t.openAnalytics}</Button>
                </Link>
              </div>
            </>
          )}
        </div>

        {/* Footer actions */}
        <div className="mt-8 flex items-center justify-between border-t border-[var(--fp-border)] pt-5">
          <Button variant="ghost" onClick={skip} disabled={saving}>
            {t.skipForNow}
          </Button>
          <div className="flex items-center gap-2">
            {idx > 0 && (
              <Button
                variant="secondary"
                onClick={goBack}
                disabled={saving}
              >
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
                {t.back}
              </Button>
            )}
            {step === "measure" ? (
              <Button onClick={() => advance(true)} disabled={saving}>
                <Check className="mr-2 h-4 w-4" aria-hidden />
                {t.finish}
              </Button>
            ) : (
              <Button
                onClick={continueStep}
                disabled={
                  saving ||
                  (step === "usecase" && !useCase) ||
                  (step === "permissions" && !permsAck) ||
                  (step === "workflow" && !hasWorkflow) ||
                  (step === "activate" && (!activateId || !activateAck || activating))
                }
              >
                {t.continue}
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Step list */}
      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {STEP_IDS.map((id, i) => (
          <button
            key={id}
            type="button"
            onClick={() => jumpTo(i)}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs ${
              i === idx
                ? "border-[var(--fp-accent)]/50 bg-[var(--fp-accent)]/10 text-[var(--fp-text)]"
                : "border-[var(--fp-border)] bg-[var(--fp-card)] text-[var(--fp-text-2)] hover:border-[var(--fp-accent)]/30"
            }`}
          >
            {done.includes(id) ? (
              <Check className="h-3.5 w-3.5 text-[#6EE7B7]" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            )}
            <span className="truncate">
              {i + 1}. {STEP_TITLES[id](t)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
