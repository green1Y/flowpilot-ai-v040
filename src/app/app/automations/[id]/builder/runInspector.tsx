"use client";

/**
 * Run inspector: execution history for this workflow with per-node
 * status/duration/IO, and safe retry of failed runs.
 * SIMULATION rows are clearly labeled vs LIVE RUN vs DRY RUN.
 */
import { useEffect, useState } from "react";
import { RotateCcw, ChevronDown, X } from "lucide-react";
import { useBuilderLocale } from "./i18n";
import { StatusBadge } from "../../components";

interface RunStep {
  id: string;
  nodeId: string;
  nodeLabel: string;
  status: string;
  input: unknown;
  output: unknown;
  error?: string | null;
  durationMs?: number | null;
}

interface Run {
  id: string;
  status: string;
  dryRun: boolean;
  error?: string | null;
  attempts: number;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  triggerEvent?: unknown;
  steps: RunStep[];
}

interface RunInspectorProps {
  workflowId: string;
  onClose: () => void;
  /** Tint canvas nodes by the selected run's step statuses. */
  onOverlayRun: (run: Run | null) => void;
}

export function RunInspector({ workflowId, onClose, onOverlayRun }: RunInspectorProps) {
  const { t } = useBuilderLocale();
  const r = t.builder.runsPanel;
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/workflows/${workflowId}/executions`);
        const json = await res.json();
        if (json.ok) setRuns(json.data as Run[]);
        else setNotice(json.error ?? "Failed to load runs");
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "Failed to load runs");
      } finally {
        setLoading(false);
      }
    })();
  }, [workflowId]);

  async function retry(run: Run) {
    setRetrying(run.id);
    setNotice("");
    try {
      const event =
        typeof run.triggerEvent === "string" ? JSON.parse(run.triggerEvent) : (run.triggerEvent ?? {});
      const res = await fetch(`/api/workflows/${workflowId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event,
          // Fresh idempotency key: a retry is a NEW run of the same event,
          // never a duplicate of the failed one.
          idempotencyKey: `retry-${run.id}-${Date.now()}`,
          dryRun: false,
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Retry failed");
      setNotice(`Retry started — execution ${json.data.executionId}.`);
      // Refresh the list.
      const list = await fetch(`/api/workflows/${workflowId}/executions`);
      const listJson = await list.json();
      if (listJson.ok) setRuns(listJson.data as Run[]);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setRetrying(null);
    }
  }

  const shown = runs.find((x) => x.id === expanded) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={r.title}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
        <div className="flex items-center justify-between border-b border-[var(--fp-border)] px-5 py-3">
          <div>
            <h3 className="font-semibold">{r.title}</h3>
            <p className="text-xs text-[var(--fp-text-2)]">{r.hint}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-[var(--fp-text-2)] hover:text-[var(--fp-text)]">
            <X size={16} />
          </button>
        </div>

        {notice && (
          <div className="border-b border-[var(--fp-border)] px-5 py-2 text-sm text-[var(--fp-text-2)]">
            {notice}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5">
          {loading && <p className="text-sm text-[var(--fp-text-2)]">…</p>}
          {!loading && runs.length === 0 && (
            <p className="text-sm text-[var(--fp-text-2)]">{r.noRuns}</p>
          )}
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.id} className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)]">
                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <StatusBadge status={run.status} />
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${
                      run.dryRun ? "bg-sky-500/20 text-sky-300" : "bg-emerald-500/20 text-emerald-300"
                    }`}
                  >
                    {run.dryRun ? r.dryRun : r.live}
                  </span>
                  <span className="font-mono text-xs text-[var(--fp-text-2)]">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                  <span className="text-xs text-[var(--fp-text-2)]">
                    {run.durationMs == null ? "—" : `${(run.durationMs / 1000).toFixed(1)}s`}
                  </span>
                  <span className="text-xs text-[var(--fp-text-2)]">
                    {run.steps.length} {r.steps.toLowerCase()}
                  </span>
                  <div className="ms-auto flex items-center gap-2">
                    {run.status === "FAILED" && (
                      <button
                        onClick={() => retry(run)}
                        disabled={retrying === run.id}
                        className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1 text-xs font-medium hover:bg-white/10 disabled:opacity-50"
                      >
                        <RotateCcw size={12} />
                        {retrying === run.id ? r.retrying : r.retry}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        const next = expanded === run.id ? null : run.id;
                        setExpanded(next);
                        onOverlayRun(next ? run : null);
                      }}
                      className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1 text-xs font-medium hover:bg-white/10"
                    >
                      {r.steps}
                      <ChevronDown size={12} className={expanded === run.id ? "rotate-180" : ""} />
                    </button>
                  </div>
                </div>
                {expanded === run.id && shown && (
                  <div className="border-t border-[var(--fp-border)] px-4 py-3">
                    {shown.error && (
                      <p className="mb-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-300">
                        {r.error}: {shown.error}
                      </p>
                    )}
                    <ol className="space-y-1.5">
                      {shown.steps.map((s) => (
                        <li key={s.id} className="rounded-lg border border-[var(--fp-border)] p-2.5 text-xs">
                          <div className="flex items-center gap-2">
                            <StatusBadge status={s.status} />
                            <span className="font-medium">{s.nodeLabel}</span>
                            <span className="font-mono text-[var(--fp-text-2)]">{s.nodeId}</span>
                            {s.durationMs != null && (
                              <span className="ms-auto text-[var(--fp-text-2)]">
                                {(s.durationMs / 1000).toFixed(2)}s
                              </span>
                            )}
                          </div>
                          {s.error && <p className="mt-1 text-red-300">{s.error}</p>}
                          <details className="mt-1">
                            <summary className="cursor-pointer text-[var(--fp-text-2)] hover:text-[var(--fp-text)]">
                              {r.input} / {r.output}
                            </summary>
                            <div className="mt-1 grid gap-2 md:grid-cols-2">
                              <pre className="overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11px]" dir="ltr">
                                {JSON.stringify(s.input, null, 2)}
                              </pre>
                              <pre className="overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11px]" dir="ltr">
                                {JSON.stringify(s.output, null, 2)}
                              </pre>
                            </div>
                          </details>
                        </li>
                      ))}
                      {shown.steps.length === 0 && (
                        <li className="text-xs text-[var(--fp-text-2)]">{r.noRuns}</li>
                      )}
                    </ol>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
