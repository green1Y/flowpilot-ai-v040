"use client";

/**
 * Builder dialogs: template gallery, description editor, delete confirm,
 * keyboard shortcuts, test (dry-run) modal, and simulate modal.
 */
import { useState } from "react";
import { X, LayoutTemplate } from "lucide-react";
import { TEMPLATES, type WorkflowTemplate } from "@/lib/workflows/templates";
import { SAMPLE_EVENT_PRESETS, type SampleEventPreset } from "@/lib/workflows/simulatePresets";
import { useBuilderLocale } from "./i18n";
import { Modal } from "../../components";

export interface SimStep {
  nodeId: string;
  nodeType: string;
  label: string;
  outcome: "matched" | "skipped" | "would_execute" | "validation_error";
  detail: string;
}
export interface SimIssue {
  nodeId?: string;
  code: string;
  message: string;
}
export interface SimulationResult {
  workflowId: string;
  workflowName: string;
  matched: boolean;
  path: SimStep[];
  wouldSend: boolean;
  messages: { channel: string; to: string; bodyPreview: string }[];
  errors: SimIssue[];
  warnings: SimIssue[];
  note: string;
}

function Shell({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`flex max-h-[85vh] w-full ${wide ? "max-w-3xl" : "max-w-lg"} flex-col overflow-hidden rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]`}>
        <div className="flex items-center justify-between border-b border-[var(--fp-border)] px-5 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-[var(--fp-text-2)] hover:text-[var(--fp-text)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

// ── Template gallery ────────────────────────────────────────────────────

export function TemplateGallery({ onClose, onInsert }: { onClose: () => void; onInsert: (t: WorkflowTemplate) => void }) {
  const { t, rtl } = useBuilderLocale();
  const b = t.builder;
  const [filter, setFilter] = useState("");
  const shown = TEMPLATES.filter(
    (x) => !filter.trim() || `${x.name} ${x.description} ${x.category}`.toLowerCase().includes(filter.trim().toLowerCase())
  );
  return (
    <Shell title={b.templateGalleryTitle} onClose={onClose} wide>
      <p className="mb-3 text-xs text-[var(--fp-text-2)]">{b.templateGalleryHint}</p>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={b.palette.search}
        dir={rtl ? "rtl" : "ltr"}
        className="mb-4 w-full rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg)] px-2.5 py-1.5 text-sm outline-none placeholder:text-[var(--fp-text-2)] focus:border-[var(--fp-accent)]"
      />
      <div className="grid gap-3 md:grid-cols-2">
        {shown.map((x) => (
          <div key={x.id} className="flex flex-col rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
            <div className="mb-1 flex items-center gap-2">
              <LayoutTemplate size={14} className="text-[var(--fp-accent-2)]" />
              <p className="font-medium">{x.name}</p>
            </div>
            <p className="mb-1 text-xs text-[var(--fp-accent-2)]">{x.category}</p>
            <p className="mb-3 flex-1 text-xs text-[var(--fp-text-2)]">{x.description}</p>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[var(--fp-text-2)]">
                {x.nodes.length} nodes · {x.edges.length} connections
              </span>
              <button
                onClick={() => onInsert(x)}
                className="rounded-lg bg-[var(--fp-accent)]/20 px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--fp-accent)]/30"
              >
                {b.insert}
              </button>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}

// ── Description editor ──────────────────────────────────────────────────

export function DescriptionEditor({ initial, onClose, onSave }: { initial: string; onClose: () => void; onSave: (v: string) => void }) {
  const { t, rtl } = useBuilderLocale();
  const [value, setValue] = useState(initial);
  return (
    <Shell title={t.builder.editDescription} onClose={onClose}>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={5}
        dir={rtl ? "rtl" : "ltr"}
        placeholder={t.builder.descriptionPlaceholder}
        className="w-full rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-3 text-sm outline-none placeholder:text-[var(--fp-text-2)] focus:border-[var(--fp-accent)]"
      />
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl bg-white/5 px-4 py-2 text-sm font-medium hover:bg-white/10">
          {t.builder.cancel}
        </button>
        <button
          onClick={() => {
            onSave(value);
            onClose();
          }}
          className="btn-gradient rounded-xl px-4 py-2 text-sm font-semibold text-white"
        >
          {t.builder.config.apply}
        </button>
      </div>
    </Shell>
  );
}

// ── Delete confirm ────────────────────────────────────────────────────

export function DeleteConfirm({ name, onClose, onConfirm, busy }: { name: string; onClose: () => void; onConfirm: () => void; busy: boolean }) {
  const { t, rtl } = useBuilderLocale();
  return (
    <Shell title={t.builder.deleteWorkflow} onClose={onClose}>
      <p className="text-sm text-[var(--fp-text-2)]" dir={rtl ? "rtl" : "ltr"}>
        {t.builder.deleteConfirm}
      </p>
      <p className="mt-2 font-mono text-xs" dir="ltr">
        {name}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl bg-white/5 px-4 py-2 text-sm font-medium hover:bg-white/10">
          {t.builder.cancel}
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="rounded-xl bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-200 hover:bg-red-500/30 disabled:opacity-50"
        >
          {t.builder.confirmDelete}
        </button>
      </div>
    </Shell>
  );
}

// ── Shortcuts ───────────────────────────────────────────────────────────

const SHORTCUTS: Array<[string, string]> = [
  ["Delete / Backspace", "Delete selected nodes / connections"],
  ["Ctrl/⌘ + Z", "Undo"],
  ["Ctrl/⌘ + Shift + Z / Ctrl/⌘ + Y", "Redo"],
  ["Ctrl/⌘ + D", "Duplicate selected nodes"],
  ["Ctrl/⌘ + C / Ctrl/⌘ + V", "Copy / paste nodes"],
  ["Shift + click / drag", "Multi-select nodes"],
  ["Right-click a node", "Context menu"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useBuilderLocale();
  return (
    <Shell title={t.builder.shortcuts} onClose={onClose}>
      <ul className="space-y-2">
        {SHORTCUTS.map(([keys, desc]) => (
          <li key={keys} className="flex items-center justify-between gap-4 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] px-3 py-2 text-sm">
            <span className="text-[var(--fp-text-2)]">{desc}</span>
            <kbd className="shrink-0 rounded-lg bg-white/10 px-2 py-1 font-mono text-xs" dir="ltr">
              {keys}
            </kbd>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

// ── Test (dry-run) modal ────────────────────────────────────────────────

export function TestModal({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const { t } = useBuilderLocale();
  const m = t.builder.testModal;
  const [event, setEvent] = useState(
    JSON.stringify(
      { type: "new_message", channel: "instagram", from: "user_123", name: "Alex", text: "Hi! What are your prices?" },
      null,
      2
    )
  );
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  async function runTest() {
    setBusy(true);
    setResult("");
    try {
      const parsed = JSON.parse(event);
      const res = await fetch(`/api/workflows/${workflowId}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: parsed }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Test failed");
      setResult(`Dry run started — execution ${json.data.executionId}. ${json.data.note}.`);
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={m.title} onClose={onClose}>
      <p className="mb-2 text-sm text-[var(--fp-text-2)]">{m.hint}</p>
      <textarea
        value={event}
        onChange={(e) => setEvent(e.target.value)}
        rows={10}
        spellCheck={false}
        dir="ltr"
        className="w-full rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-3 font-mono text-xs outline-none focus:border-[var(--fp-accent)]"
      />
      {result && (
        <p className="mt-3 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-3 text-sm" dir="ltr">
          {result}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl bg-white/5 px-4 py-2 text-sm font-medium hover:bg-white/10">
          {m.close}
        </button>
        <button
          onClick={runTest}
          disabled={busy}
          className="btn-gradient rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? m.running : m.run}
        </button>
      </div>
    </Modal>
  );
}

// ── Simulate modal ──────────────────────────────────────────────────────

const SIM_OUTCOME_STYLE: Record<SimStep["outcome"], string> = {
  matched: "bg-emerald-500/15 text-emerald-300",
  skipped: "bg-white/5 text-[var(--fp-text-2)]",
  would_execute: "bg-sky-500/15 text-sky-300",
  validation_error: "bg-red-500/15 text-red-300",
};

export function SimulateModal({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const { t } = useBuilderLocale();
  const m = t.builder.simModal;
  const [presetId, setPresetId] = useState<string>(SAMPLE_EVENT_PRESETS[0].id);
  const [event, setEvent] = useState<string>(JSON.stringify(SAMPLE_EVENT_PRESETS[0].event, null, 2));
  const [eventError, setEventError] = useState("");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [busy, setBusy] = useState(false);

  function pickPreset(preset: SampleEventPreset) {
    setPresetId(preset.id);
    setEvent(JSON.stringify(preset.event, null, 2));
    setEventError("");
  }

  async function runSimulation() {
    setBusy(true);
    setEventError("");
    setResult(null);
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event) as Record<string, unknown>;
      } catch {
        setEventError("Invalid JSON — fix the sample event and try again.");
        return;
      }
      const res = await fetch(`/api/workflows/${workflowId}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sampleEvent: parsed }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Simulation failed");
      setResult(json.data as SimulationResult);
    } catch (e) {
      setEventError(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={m.title} onClose={onClose}>
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2">
        <span className="rounded bg-sky-500/20 px-2 py-0.5 text-[11px] font-bold tracking-wide text-sky-300">
          {m.badge}
        </span>
        <p className="text-xs text-sky-200/80">{m.banner}</p>
      </div>
      <p className="mb-2 text-sm text-[var(--fp-text-2)]">{m.hint}</p>
      <div className="mb-2 flex flex-wrap gap-2">
        {SAMPLE_EVENT_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => pickPreset(p)}
            title={p.description}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              presetId === p.id ? "bg-sky-500/25 text-sky-200" : "bg-white/5 text-[var(--fp-text-2)] hover:bg-white/10"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <textarea
        value={event}
        onChange={(e) => {
          setEvent(e.target.value);
          setEventError("");
        }}
        rows={8}
        spellCheck={false}
        dir="ltr"
        className="w-full rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-3 font-mono text-xs outline-none focus:border-[var(--fp-accent)]"
      />
      {eventError && (
        <p className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          {eventError}
        </p>
      )}
      {result && <SimulationResults result={result} />}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl bg-white/5 px-4 py-2 text-sm font-medium hover:bg-white/10">
          {m.close}
        </button>
        <button
          onClick={runSimulation}
          disabled={busy}
          className="rounded-xl bg-sky-500/25 px-4 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-500/35 disabled:opacity-50"
        >
          {busy ? m.running : m.run}
        </button>
      </div>
    </Modal>
  );
}

function SimulationResults({ result }: { result: SimulationResult }) {
  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className={`rounded-full px-3 py-1 font-medium ${result.matched ? "bg-emerald-500/15 text-emerald-300" : "bg-white/5 text-[var(--fp-text-2)]"}`}>
          {result.matched ? "Trigger matched" : "No trigger matched"}
        </span>
        <span className={`rounded-full px-3 py-1 font-medium ${result.wouldSend ? "bg-amber-500/15 text-amber-300" : "bg-white/5 text-[var(--fp-text-2)]"}`}>
          {result.wouldSend ? "Would send messages" : "Would not send"}
        </span>
        <span className="rounded-full bg-white/5 px-3 py-1 font-medium text-[var(--fp-text-2)]">
          {result.path.length} step{result.path.length === 1 ? "" : "s"}
        </span>
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold">Execution path</h4>
        <ol className="space-y-1.5">
          {result.path.map((s) => (
            <li key={s.nodeId} className="flex items-start gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-2.5 text-sm">
              <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${SIM_OUTCOME_STYLE[s.outcome]}`}>
                {s.outcome.replace(/_/g, " ")}
              </span>
              <div className="min-w-0">
                <p className="font-medium">
                  {s.label} <span className="font-mono text-xs text-[var(--fp-text-2)]">{s.nodeType}</span>
                </p>
                <p className="text-xs text-[var(--fp-text-2)]">{s.detail}</p>
              </div>
            </li>
          ))}
          {result.path.length === 0 && (
            <li className="text-sm text-[var(--fp-text-2)]">No steps — the workflow has no trigger that matched.</li>
          )}
        </ol>
      </div>

      {result.messages.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold">
            Would-be messages <span className="font-normal text-[var(--fp-text-2)]">(preview only — not sent)</span>
          </h4>
          <div className="space-y-2">
            {result.messages.map((msg, i) => (
              <div key={i} className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-3 text-sm">
                <p className="mb-1 text-xs text-[var(--fp-text-2)]" dir="ltr">
                  <span className="font-semibold text-[var(--fp-text)]">{msg.channel}</span> → {msg.to}
                </p>
                <p className="whitespace-pre-wrap font-mono text-xs" dir="ltr">
                  {msg.bodyPreview}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.errors.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-red-300">Errors ({result.errors.length})</h4>
          <ul className="space-y-1 text-sm text-red-300/90">
            {result.errors.map((e, i) => (
              <li key={i} className="rounded-xl border border-red-500/25 bg-red-500/5 p-2.5">
                <span className="font-mono text-xs text-red-400">[{e.code}]</span> {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.warnings.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-amber-300">Warnings ({result.warnings.length})</h4>
          <ul className="space-y-1 text-sm text-amber-200/90">
            {result.warnings.map((w, i) => (
              <li key={i} className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-2.5">
                <span className="font-mono text-xs text-amber-400">[{w.code}]</span> {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
