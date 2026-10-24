"use client";

import { Fragment, use, useEffect, useState } from "react";
import Link from "next/link";
import { StatusBadge, formatDateTime } from "../../components";

interface Step {
  id: string;
  nodeId: string;
  nodeLabel: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: string;
}

interface Execution {
  id: string;
  status: string;
  dryRun: boolean;
  workflowVersion?: number | null;
  error: string | null;
  attempts: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  steps: Step[];
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-48 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] text-[var(--fp-text-2)]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default function ExecutionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: workflowId } = use(params);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/workflows/${workflowId}/executions`);
        const json = await res.json();
        if (!json.ok) throw new Error(json.error ?? "Failed to load executions");
        setExecutions(json.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load executions");
      } finally {
        setLoading(false);
      }
    })();
  }, [workflowId]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <nav className="mb-4 text-sm text-[var(--fp-text-2)]">
        <Link href="/app/automations" className="hover:text-[var(--fp-text)]">Automations</Link>
        <span className="mx-2">/</span>
        <Link href={`/app/automations/${workflowId}`} className="hover:text-[var(--fp-text)]">Builder</Link>
        <span className="mx-2">/</span>
        <span className="font-medium text-[var(--fp-text)]">Runs</span>
      </nav>

      <h1 className="mb-1 text-2xl font-bold">Execution history</h1>
      <p className="mb-6 text-sm text-[var(--fp-text-2)]">
        Latest 50 runs. Expand a run to see every step, its input/output and any error.
      </p>

      {error && (
        <div className="mb-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[var(--fp-text-2)]">Loading runs…</p>
      ) : executions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--fp-border)] bg-[var(--fp-card)] p-12 text-center">
          <p className="font-medium">No runs yet</p>
          <p className="mt-1 text-sm text-[var(--fp-text-2)]">Use the Test button in the builder to fire a dry run.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--fp-border)] text-left text-xs uppercase tracking-wide text-[var(--fp-text-2)]">
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">Attempts</th>
                <th className="px-4 py-3">Steps</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {executions.map((ex) => (
                <Fragment key={ex.id}>
                  <tr className="border-b border-[var(--fp-border)] last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={ex.status} />
                        {ex.workflowVersion != null && (
                          <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-[var(--fp-text-2)]">
                            v{ex.workflowVersion}
                          </span>
                        )}
                        {ex.dryRun && (
                          <span className="rounded-full border border-violet-400/30 bg-violet-500/15 px-2 py-0.5 text-[11px] text-violet-300">
                            dry run
                          </span>
                        )}
                      </div>
                      {ex.error && <p className="mt-1 max-w-md truncate text-xs text-red-400" title={ex.error}>{ex.error}</p>}
                    </td>
                    <td className="px-4 py-3 text-[var(--fp-text-2)]">{formatDateTime(ex.startedAt)}</td>
                    <td className="px-4 py-3 text-[var(--fp-text-2)]">
                      {ex.durationMs == null ? "—" : `${(ex.durationMs / 1000).toFixed(1)}s`}
                    </td>
                    <td className="px-4 py-3 text-[var(--fp-text-2)]">{ex.attempts}</td>
                    <td className="px-4 py-3 text-[var(--fp-text-2)]">{ex.steps.length}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setExpanded(expanded === ex.id ? null : ex.id)}
                        className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10"
                      >
                        {expanded === ex.id ? "Collapse" : "Steps"}
                      </button>
                    </td>
                  </tr>
                  {expanded === ex.id && (
                    <tr className="border-b border-[var(--fp-border)] bg-black/20">
                      <td colSpan={6} className="px-4 py-4">
                        {ex.steps.length === 0 ? (
                          <p className="text-sm text-[var(--fp-text-2)]">No steps recorded — no trigger matched this event.</p>
                        ) : (
                          <ol className="space-y-3">
                            {ex.steps.map((s, i) => (
                              <li key={s.id} className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-3">
                                <div className="mb-2 flex items-center gap-3">
                                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/5 text-xs font-semibold">
                                    {i + 1}
                                  </span>
                                  <span className="font-medium">{s.nodeLabel || s.nodeId}</span>
                                  <StatusBadge status={s.status} />
                                  {s.error && <span className="text-xs text-red-400">{s.error}</span>}
                                </div>
                                <div className="grid gap-2 md:grid-cols-2">
                                  <div>
                                    <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--fp-text-2)]">Input</p>
                                    <JsonBlock value={s.input} />
                                  </div>
                                  <div>
                                    <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--fp-text-2)]">Output</p>
                                    <JsonBlock value={s.output} />
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ol>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
