"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { PageHeader } from "@/components/ui/PageHeader";

/**
 * Import batches: preview -> confirm (v0.4.0, Wave 2B).
 * Paste CSV, create a PREVIEW batch, review each row (VALID / INVALID /
 * DUPLICATE with the conflicting-field diff), choose a resolution per
 * row, then confirm. DUPLICATE rows default to skip — they are never
 * silently merged. The existing direct import on the contacts page is
 * untouched; this is the additive batch flow.
 */

interface PreviewRow {
  id: string;
  rowIndex: number;
  raw: Record<string, string>;
  mapped: Record<string, unknown>;
  status: string;
  errors: string[];
  matchedContactId?: string | null;
  diff?: { field: string; existing: string; incoming: string }[];
  duplicateInBatch?: boolean;
}

interface BatchItem {
  id: string;
  filename: string;
  status: string;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  createdAt: string;
}

function statusTone(s: string): "green" | "red" | "amber" | "gray" | "cyan" {
  switch (s) {
    case "VALID":
    case "IMPORTED":
      return "green";
    case "INVALID":
      return "red";
    case "DUPLICATE":
      return "amber";
    case "SKIPPED":
      return "gray";
    default:
      return "cyan";
  }
}

export default function ImportBatchesPage() {
  const [batches, setBatches] = useState<BatchItem[]>([]);
  const [csv, setCsv] = useState("name,email,phone,tags\nJane Doe,jane@example.com,+15551234567,vip");
  const [filename, setFilename] = useState("contacts.csv");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [counts, setCounts] = useState<{ total: number; valid: number; invalid: number; duplicate: number } | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [report, setReport] = useState<{ imported: number; skipped: number; failed: number; errors: { rowId: string; error: string }[] } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [loadingBatch, setLoadingBatch] = useState(false);

  const fetchBatches = useCallback(async () => {
    try {
      const data = await api<{ items: BatchItem[] }>("/api/contacts/imports");
      setBatches(data.items ?? []);
    } catch {
      // Batch list is a convenience — never break the create form if it fails.
    }
  }, []);

  useEffect(() => {
    void fetchBatches();
  }, [fetchBatches]);

  const loadBatch = async (id: string) => {
    setLoadingBatch(true);
    setReport(null);
    setConfirmError(null);
    try {
      const data = await api<{ batch: BatchItem; rows: PreviewRow[] }>("/api/contacts/imports", {
        params: { id },
      });
      setBatchId(data.batch.id);
      setRows(data.rows ?? []);
      setResolutions({});
    } catch (e) {
      setConfirmError(e instanceof ApiError ? e.message : "Failed to load batch");
    } finally {
      setLoadingBatch(false);
    }
  };

  const createBatch = async () => {
    setCreating(true);
    setCreateError(null);
    setReport(null);
    try {
      const data = await api<{
        batchId: string;
        counts: { total: number; valid: number; invalid: number; duplicate: number };
        rows: PreviewRow[];
      }>("/api/contacts/imports", { method: "POST", body: { filename, csv } });
      setBatchId(data.batchId);
      setCounts(data.counts);
      setRows(data.rows ?? []);
      setResolutions({});
      void fetchBatches();
    } catch (e) {
      setCreateError(e instanceof ApiError ? e.message : "Failed to create batch");
    } finally {
      setCreating(false);
    }
  };

  const confirmBatch = async () => {
    if (!batchId) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await api<{
        imported: number;
        skipped: number;
        failed: number;
        errors: { rowId: string; error: string }[];
      }>(`/api/contacts/imports/${batchId}/confirm`, { method: "POST", body: { resolutions } });
      setReport(res);
      void fetchBatches();
    } catch (e) {
      setConfirmError(e instanceof ApiError ? e.message : "Confirm failed");
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Import batches"
        description="Preview a CSV, resolve duplicates explicitly, then confirm. Duplicates are never silently merged."
      />

      <section className="mb-6 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-4">
        <div className="space-y-3">
          <Input label="Filename" value={filename} onChange={(e) => setFilename(e.target.value)} />
          <Textarea label="CSV data" value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} hint="Columns: name, email, phone, channel, tags, company, consent, consent_channel. Quoted fields supported." />
          {createError && <p className="text-sm text-[#FB7185]" role="alert">{createError}</p>}
          <Button size="sm" onClick={() => void createBatch()} loading={creating}>Create preview batch</Button>
        </div>
      </section>

      {counts && (
        <p className="mb-4 text-sm text-[var(--fp-text-2)]">
          Preview: {counts.total} rows · {counts.valid} valid · {counts.invalid} invalid · {counts.duplicate} duplicate
        </p>
      )}

      {loadingBatch ? (
        <Spinner label="Loading batch" />
      ) : batchId && rows.length > 0 && (
        <section className="mb-6">
          <div className="overflow-x-auto rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
            <table className="w-full min-w-[760px] text-start text-sm">
              <thead>
                <tr className="border-b border-[var(--fp-border)] text-xs uppercase tracking-wide text-[var(--fp-text-2)]">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Name / email</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Issues / diff</th>
                  <th className="px-4 py-3">Resolution</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--fp-border)] last:border-0">
                    <td className="px-4 py-3 text-xs text-[var(--fp-text-2)]">{r.rowIndex}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-[var(--fp-text)]">{String(r.mapped.name ?? "—")}</p>
                      <p className="text-xs text-[var(--fp-text-2)]">{String(r.mapped.email ?? "")}</p>
                    </td>
                    <td className="px-4 py-3"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                    <td className="px-4 py-3 text-xs text-[var(--fp-text-2)]">
                      {r.errors.map((e, i) => <p key={i} className="text-[#FB7185]">{e}</p>)}
                      {(r.diff ?? []).map((d) => (
                        <p key={d.field}>{d.field}: existing “{d.existing}” → incoming “{d.incoming}”</p>
                      ))}
                      {r.duplicateInBatch && <p>Duplicate within this file.</p>}
                      {r.errors.length === 0 && (r.diff ?? []).length === 0 && !r.duplicateInBatch && <span>—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="w-32">
                        <Select
                          value={resolutions[r.id] ?? ""}
                          onChange={(e) => setResolutions({ ...resolutions, [r.id]: e.target.value })}
                          options={[
                            { value: "create", label: "create" },
                            { value: "merge", label: "merge" },
                            { value: "skip", label: "skip" },
                          ]}
                          placeholder={r.status === "DUPLICATE" ? "skip (default)" : r.status === "VALID" ? "create (default)" : "skip (default)"}
                          aria-label={`Resolution for row ${r.rowIndex}`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {confirmError && <p className="mt-2 text-sm text-[#FB7185]" role="alert">{confirmError}</p>}
          {report && (
            <div className="mt-3 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3 text-sm">
              <p>Imported <span className="font-bold text-[#34D399]">{report.imported}</span> · Skipped {report.skipped} · Failed {report.failed}</p>
              {report.errors.map((e) => <p key={e.rowId} className="text-xs text-[#FB7185]">{e.error}</p>)}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={() => void confirmBatch()} loading={confirming}>Confirm import</Button>
          </div>
        </section>
      )}

      <h2 className="mb-2 text-sm font-semibold text-[var(--fp-text)]">Recent batches</h2>
      {batches.length === 0 ? (
        <p className="text-sm text-[var(--fp-text-2)]">No batches yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
          <table className="w-full min-w-[640px] text-start text-sm">
            <thead>
              <tr className="border-b border-[var(--fp-border)] text-xs uppercase tracking-wide text-[var(--fp-text-2)]">
                <th className="px-4 py-3">Filename</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Rows</th>
                <th className="px-4 py-3">Imported</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-b border-[var(--fp-border)] last:border-0">
                  <td className="px-4 py-3">{b.filename}</td>
                  <td className="px-4 py-3"><Badge tone={statusTone(b.status)}>{b.status}</Badge></td>
                  <td className="px-4 py-3">{b.totalRows}</td>
                  <td className="px-4 py-3">{b.importedCount}</td>
                  <td className="px-4 py-3"><Button size="sm" variant="ghost" onClick={() => void loadBatch(b.id)}>Preview / confirm</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
