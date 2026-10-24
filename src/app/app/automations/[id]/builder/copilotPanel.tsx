"use client";

/**
 * AI Copilot panel ("Build with AI").
 * - EN/AR natural-language input → POST /api/automations/ai/generate
 * - Clarifying-question flow (structured, rendered by the UI)
 * - Ghost preview of generated nodes/edges with Accept / Reject
 * - Ops: explain, explain in Arabic, diagnose last failure,
 *   add condition / delay / error handling, translate descriptions
 * - Honest states: NOT CONFIGURED badge + setup message when no AI
 *   provider is set; never fakes a generation.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, X, Check, CircleAlert, Languages, Stethoscope, FileText, Plus, Timer, ShieldCheck } from "lucide-react";
import type { BuilderNode } from "./types";
import type { Edge } from "@xyflow/react";
import { useBuilderLocale, fmt } from "./i18n";
import type { ClarifyingQuestion } from "@/lib/copilot/prompts";
import { specToGraph } from "@/lib/workflows/graphModel";
import type { WorkflowSpec } from "@/lib/copilot/spec";

export interface CopilotPreview {
  nodes: BuilderNode[];
  edges: Edge[];
  repaired: string[];
  /** For translate ops: nodeId → new label instead of new nodes. */
  labelUpdates?: Record<string, string>;
}

interface CopilotPanelProps {
  workflowId: string;
  onPreview: (p: CopilotPreview | null) => void;
  onAcceptPreview: (p: CopilotPreview) => void;
  onClose: () => void;
}

type Phase =
  | { name: "idle" }
  | { name: "questions"; prompt: string; questions: ClarifyingQuestion[] }
  | { name: "working"; label: string }
  | { name: "text"; text: string }
  | { name: "error"; message: string };

const QUICK_OPS = [
  { op: "add_condition", icon: Plus, key: "addCondition" },
  { op: "add_delay", icon: Timer, key: "addDelay" },
  { op: "add_error_handling", icon: ShieldCheck, key: "addErrorHandling" },
] as const;

export function CopilotPanel({ workflowId, onPreview, onAcceptPreview, onClose }: CopilotPanelProps) {
  const { t, locale, rtl } = useBuilderLocale();
  const c = t.copilot;
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [providerNote, setProviderNote] = useState("");
  const [preview, setPreview] = useState<CopilotPreview | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Probe AI provider status (honest badge, no secrets).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/automations/ai/generate");
        const json = await res.json();
        if (json.ok) {
          setConfigured(!!json.data.configured);
          setProviderNote(json.data.configured ? String(json.data.provider) : (json.data.message ?? ""));
        } else {
          setConfigured(false);
        }
      } catch {
        setConfigured(false);
      }
    })();
    return () => abortRef.current?.abort();
  }, []);

  const mapError = useCallback(
    (json: { error?: string; code?: string }, status: number): string => {
      if (status === 503 || json.code === "AI_PROVIDER_NOT_CONFIGURED") return "notConfigured";
      if (status === 429 || json.code === "COPILOT_RATE_LIMITED") return c.rateLimited;
      if (status === 504 || json.code === "AI_TIMEOUT") return c.timedOut;
      return json.error ?? c.failed;
    },
    [c]
  );

  async function callApi(body: Record<string, unknown>): Promise<{ json: Record<string, unknown>; status: number }> {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const res = await fetch("/api/automations/ai/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, locale, ...body }),
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { json, status: res.status };
  }

  function applySpecResult(spec: WorkflowSpec, repaired: string[]) {
    const { nodes, edges } = specToGraph(spec, { x: 40, y: 260 });
    const previewNodes: BuilderNode[] = nodes.map((n) => ({
      id: n.id,
      type: "flowNode",
      position: n.position,
      data: {
        label: n.label,
        kind: n.kind,
        nodeType: n.type,
        config: n.config,
        icon: "Sparkles",
        description: "",
        preview: true,
      },
    }));
    const previewEdges: Edge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label ?? "",
      style: { strokeDasharray: "6 4" },
      data: { preview: true },
    }));
    const p: CopilotPreview = { nodes: previewNodes, edges: previewEdges, repaired };
    setPreview(p);
    onPreview(p);
    setPhase({ name: "idle" });
  }

  async function generate(withAnswers?: Record<string, string>) {
    const p = prompt.trim();
    if (!p && !withAnswers) {
      setPhase({ name: "error", message: c.emptyPrompt });
      return;
    }
    setPreview(null);
    onPreview(null);
    setPhase({ name: "working", label: c.generating });
    try {
      const { json, status } = await callApi({
        op: "generate",
        prompt: withAnswers ? (phase as { prompt: string }).prompt ?? p : p,
        ...(withAnswers ? { answers: withAnswers } : {}),
      });
      if (!json.ok) {
        const mapped = mapError(json as { error?: string; code?: string }, status);
        if (mapped === "notConfigured") {
          setPhase({ name: "error", message: "notConfigured" });
        } else {
          setPhase({ name: "error", message: mapped });
        }
        return;
      }
      const data = json.data as Record<string, unknown>;
      if (data.kind === "questions") {
        setAnswers({});
        setPhase({
          name: "questions",
          prompt: p,
          questions: data.questions as ClarifyingQuestion[],
        });
        return;
      }
      if (data.kind === "spec") {
        setHistory((h) => [p.slice(0, 80), ...h].slice(0, 5));
        applySpecResult(data.spec as WorkflowSpec, (data.repaired as string[]) ?? []);
        return;
      }
      setPhase({ name: "error", message: c.failed });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setPhase({ name: "error", message: c.failed });
    }
  }

  async function runOp(op: string, opPrompt = "", forceLocale?: "en" | "ar") {
    setPreview(null);
    onPreview(null);
    setPhase({ name: "working", label: c.opRunning });
    try {
      const { json, status } = await callApi({ op, prompt: opPrompt, locale: forceLocale ?? locale });
      if (!json.ok) {
        const mapped = mapError(json as { error?: string; code?: string }, status);
        setPhase({ name: "error", message: mapped === "notConfigured" ? "notConfigured" : mapped });
        return;
      }
      const data = json.data as Record<string, unknown>;
      if (data.kind === "spec") {
        applySpecResult(data.spec as WorkflowSpec, (data.repaired as string[]) ?? []);
      } else if (data.kind === "text") {
        const text = String(data.text ?? "");
        if (op === "translate") {
          // Translate returns JSON { labels } — apply as label updates.
          try {
            const parsed = JSON.parse(text) as { labels?: Record<string, string> };
            const labels = parsed.labels ?? {};
            if (Object.keys(labels).length === 0) {
              setPhase({ name: "error", message: c.failed });
              return;
            }
            const p: CopilotPreview = { nodes: [], edges: [], repaired: [], labelUpdates: labels };
            setPreview(p);
            onPreview(p);
            setPhase({ name: "idle" });
            return;
          } catch {
            setPhase({ name: "error", message: c.failed });
            return;
          }
        }
        setPhase({ name: "text", text });
      } else {
        setPhase({ name: "error", message: c.failed });
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setPhase({ name: "error", message: c.failed });
    }
  }

  function acceptPreview() {
    if (!preview) return;
    onAcceptPreview(preview);
    setPreview(null);
    setPhase({ name: "idle" });
  }

  function rejectPreview() {
    setPreview(null);
    onPreview(null);
  }

  const working = phase.name === "working";

  return (
    <aside
      className={`flex w-96 shrink-0 flex-col border-s border-[var(--fp-border)] bg-[var(--fp-card)]`}
      aria-label={c.title}
    >
      <div className="flex items-center gap-2 border-b border-[var(--fp-border)] px-4 py-3">
        <Sparkles size={16} className="text-[var(--fp-accent-2)]" aria-hidden />
        <h3 className="font-semibold">{c.title}</h3>
        <span
          className={`ms-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
            configured === null
              ? "bg-white/10 text-[var(--fp-text-2)]"
              : configured
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-amber-500/20 text-amber-300"
          }`}
          title={providerNote}
        >
          {configured === null ? "…" : configured ? c.configuredBadge : c.notConfiguredBadge}
        </span>
        <button
          onClick={onClose}
          aria-label="Close copilot"
          className="ms-auto rounded-lg px-2 py-1 text-[var(--fp-text-2)] hover:text-[var(--fp-text)] focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)]"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Prompt input */}
        <div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            dir={rtl ? "rtl" : "ltr"}
            placeholder={c.inputPlaceholder}
            disabled={working}
            aria-label={c.title}
            className="w-full rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-3 text-sm outline-none placeholder:text-[var(--fp-text-2)] focus:border-[var(--fp-accent)] disabled:opacity-50"
          />
          <button
            onClick={() => generate()}
            disabled={working || !prompt.trim()}
            className="btn-gradient mt-2 w-full rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {working ? c.generating : c.generate}
          </button>
        </div>

        {/* Clarifying questions */}
        {phase.name === "questions" && (
          <div className="rounded-2xl border border-[var(--fp-accent)]/30 bg-[var(--fp-accent)]/5 p-4">
            <h4 className="mb-1 text-sm font-semibold">{c.questionsTitle}</h4>
            <p className="mb-3 text-xs text-[var(--fp-text-2)]">{c.askFirst}</p>
            <div className="space-y-3">
              {phase.questions.map((q) => (
                <div key={q.id}>
                  <label className="mb-1 block text-xs font-medium">
                    {locale === "ar" ? q.questionAr : q.question}
                  </label>
                  {q.options && (
                    <div className="mb-1.5 flex flex-wrap gap-1">
                      {q.options.map((o) => (
                        <button
                          key={o}
                          onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}
                          className={`rounded-full px-2.5 py-1 font-mono text-xs ${
                            answers[q.id] === o
                              ? "bg-[var(--fp-accent)]/30 text-white"
                              : "bg-white/5 text-[var(--fp-text-2)] hover:bg-white/10"
                          }`}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    value={answers[q.id] ?? ""}
                    onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                    placeholder={locale === "ar" ? q.hintAr ?? "" : q.hint ?? ""}
                    dir={rtl ? "rtl" : "ltr"}
                    className="w-full rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg)] px-2.5 py-1.5 text-sm outline-none placeholder:text-[var(--fp-text-2)] focus:border-[var(--fp-accent)]"
                  />
                </div>
              ))}
            </div>
            <button
              onClick={() => generate(answers)}
              disabled={working}
              className="btn-gradient mt-3 w-full rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {c.submitAnswers}
            </button>
          </div>
        )}

        {/* Preview accept/reject */}
        {preview && (
          <div className="rounded-2xl border border-dashed border-[var(--fp-accent-2)]/50 bg-[var(--fp-accent-2)]/5 p-4">
            <h4 className="mb-1 text-sm font-semibold">{c.previewTitle}</h4>
            <p className="mb-2 text-xs text-[var(--fp-text-2)]">{c.previewHint}</p>
            {preview.labelUpdates ? (
              <ul className="mb-3 max-h-32 space-y-1 overflow-auto text-xs">
                {Object.entries(preview.labelUpdates).map(([id, label]) => (
                  <li key={id} className="rounded-lg bg-[var(--fp-bg)] px-2 py-1">
                    <span className="font-mono text-[var(--fp-text-2)]">{id}</span> → {label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-3 text-xs text-[var(--fp-text-2)]">
                {preview.nodes.length} node{preview.nodes.length === 1 ? "" : "s"},{" "}
                {preview.edges.length} connection{preview.edges.length === 1 ? "" : "s"}
              </p>
            )}
            {preview.repaired.length > 0 && (
              <p className="mb-3 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200/90">
                {fmt(c.repairedNote, { n: preview.repaired.length, s: preview.repaired.length === 1 ? "" : "s", items: preview.repaired.slice(0, 3).join("; ") })}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={acceptPreview}
                className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/30"
              >
                <Check size={14} /> {c.accept}
              </button>
              <button
                onClick={rejectPreview}
                className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-white/5 px-4 py-2 text-sm font-medium hover:bg-white/10"
              >
                <X size={14} /> {c.reject}
              </button>
            </div>
          </div>
        )}

        {/* Working / error / text result */}
        {phase.name === "working" && (
          <div className="flex items-center gap-2 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4 text-sm text-[var(--fp-text-2)]">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--fp-accent)] border-t-transparent" />
            {phase.label}
          </div>
        )}
        {phase.name === "error" &&
          (phase.message === "notConfigured" ? (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-200">
                <CircleAlert size={15} /> {c.notConfiguredTitle}
              </div>
              <p className="text-xs leading-relaxed text-amber-100/80">{c.notConfiguredBody}</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
              {phase.message}
            </div>
          ))}
        {phase.name === "text" && (
          <div className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
            <h4 className="mb-2 text-sm font-semibold">{c.resultText}</h4>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{phase.text}</p>
            <button
              onClick={() => setPhase({ name: "idle" })}
              className="mt-3 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10"
            >
              {t.builder.cancel}
            </button>
          </div>
        )}

        {/* Ops */}
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">
            {c.title}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => runOp("explain")}
              disabled={working}
              className="flex items-center gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-3 py-2 text-xs font-medium hover:border-[var(--fp-accent)] disabled:opacity-50"
            >
              <FileText size={14} /> {c.ops.explain}
            </button>
            <button
              onClick={() => runOp("explain", "", "ar")}
              disabled={working}
              className="flex items-center gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-3 py-2 text-xs font-medium hover:border-[var(--fp-accent)] disabled:opacity-50"
            >
              <Languages size={14} /> {c.ops.explainAr}
            </button>
            <button
              onClick={() => runOp("diagnose")}
              disabled={working}
              className="flex items-center gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-3 py-2 text-xs font-medium hover:border-[var(--fp-accent)] disabled:opacity-50"
            >
              <Stethoscope size={14} /> {c.ops.diagnose}
            </button>
            <button
              onClick={() => runOp("translate")}
              disabled={working}
              className="flex items-center gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-3 py-2 text-xs font-medium hover:border-[var(--fp-accent)] disabled:opacity-50"
            >
              <Languages size={14} /> {c.ops.translate}
            </button>
            {QUICK_OPS.map(({ op, icon: Icon, key }) => (
              <button
                key={op}
                onClick={() => runOp(op)}
                disabled={working}
                className="flex items-center gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-3 py-2 text-xs font-medium hover:border-[var(--fp-accent)] disabled:opacity-50"
              >
                <Icon size={14} /> {c.ops[key]}
              </button>
            ))}
          </div>
        </div>

        {/* History */}
        {history.length > 0 && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">
                {c.history}
              </p>
              <button onClick={() => setHistory([])} className="text-xs text-[var(--fp-text-2)] hover:text-[var(--fp-text)]">
                {c.clearHistory}
              </button>
            </div>
            <ul className="space-y-1">
              {history.map((h, i) => (
                <li key={i}>
                  <button
                    onClick={() => {
                      setPrompt(h);
                    }}
                    className="w-full truncate rounded-lg bg-white/5 px-2.5 py-1.5 text-left text-xs text-[var(--fp-text-2)] hover:bg-white/10"
                    dir={rtl ? "rtl" : "ltr"}
                  >
                    {h}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}
