"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { ShieldCheck } from "lucide-react";

/**
 * Audience & Consent Manager (v0.4.0, Wave 2B).
 * Reads /api/consent: per-contact consent records by channel, the
 * suppression list with reasons, and the effective state per channel.
 * A suppression always beats a stale OPTED_IN record, and suppressions
 * survive re-import (imports merge into the existing contact, never
 * deleting its Suppression rows) — see docs/IMPORT_AND_CONSENT.md.
 */

interface ConsentRecordItem {
  id: string;
  contactId?: string;
  contactName?: string | null;
  channel: string;
  status: string;
  source: string;
  wordingVersion?: string | null;
  createdAt: string;
}

interface SuppressionItem {
  id: string;
  contactId: string;
  contactName?: string | null;
  channel: string | null;
  reason: string;
  createdAt: string;
}

const CHANNELS = ["instagram", "facebook", "whatsapp", "email", "sms"];

function stateTone(s: string): "green" | "red" | "gray" | "amber" {
  switch (s) {
    case "OPTED_IN":
      return "green";
    case "OPTED_OUT":
    case "SUPPRESSED":
      return "red";
    default:
      return "gray";
  }
}

export default function ConsentPage() {
  const [records, setRecords] = useState<ConsentRecordItem[]>([]);
  const [suppressions, setSuppressions] = useState<SuppressionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [contactId, setContactId] = useState("");
  const [lookup, setLookup] = useState<{
    contact: { id: string; name: string };
    records: ConsentRecordItem[];
    suppressions: SuppressionItem[];
    effective: Record<string, { state: string; suppressed: boolean }>;
  } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  const [form, setForm] = useState({ contactId: "", channel: "email", status: "OPTED_IN", source: "manual", wordingVersion: "" });
  const [saving, setSaving] = useState(false);
  const [formMsg, setFormMsg] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ records: ConsentRecordItem[]; suppressions: SuppressionItem[] }>("/api/consent");
      setRecords(data.records ?? []);
      setSuppressions(data.suppressions ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load consent data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const runLookup = async () => {
    if (!contactId.trim()) return;
    setLookupLoading(true);
    setLookupError(null);
    try {
      const data = await api<{
        contact: { id: string; name: string };
        records: ConsentRecordItem[];
        suppressions: SuppressionItem[];
        effective: Record<string, { state: string; suppressed: boolean }>;
      }>("/api/consent", { params: { contactId: contactId.trim() } });
      setLookup(data);
    } catch (e) {
      setLookup(null);
      setLookupError(e instanceof ApiError ? e.message : "Lookup failed");
    } finally {
      setLookupLoading(false);
    }
  };

  const submitRecord = async () => {
    if (!form.contactId.trim()) return;
    setSaving(true);
    setFormMsg(null);
    try {
      await api("/api/consent", {
        method: "POST",
        body: {
          contactId: form.contactId.trim(),
          channel: form.channel,
          status: form.status,
          source: form.source.trim() || "manual",
          ...(form.wordingVersion.trim() ? { wordingVersion: form.wordingVersion.trim() } : {}),
        },
      });
      setFormMsg(
        form.status === "OPTED_OUT"
          ? "Recorded as OPTED_OUT — a suppression was also created so enforcement and the ledger agree."
          : "Recorded as OPTED_IN. Note: an opt-in never removes an existing suppression."
      );
      void fetchAll();
    } catch (e) {
      setFormMsg(e instanceof ApiError ? e.message : "Failed to record consent");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Audience & Consent"
        description="Per-contact consent by channel, suppressions, and effective state. A suppression always beats a stale opt-in."
      />

      <p className="mb-4 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-4 py-3 text-sm text-[var(--fp-text-2)]">
        Suppressions survive re-import: importing a suppressed contact again merges into the
        existing contact instead of creating a second row, and merge never deletes Suppression
        rows — so the contact stays excluded from outbound sends.
      </p>

      {error && <p className="mb-4 rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-4 py-2 text-sm text-[#FB7185]" role="alert">{error}</p>}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        {/* Lookup */}
        <section className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-4">
          <h2 className="mb-3 text-sm font-semibold text-[var(--fp-text)]">Look up a contact</h2>
          <div className="flex gap-2">
            <Input value={contactId} onChange={(e) => setContactId(e.target.value)} placeholder="Contact id" aria-label="Contact id" className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => void runLookup()} loading={lookupLoading} disabled={!contactId.trim()}>Look up</Button>
          </div>
          {lookupError && <p className="mt-2 text-sm text-[#FB7185]" role="alert">{lookupError}</p>}
          {lookup && (
            <div className="mt-3 space-y-2 text-sm">
              <p className="font-medium text-[var(--fp-text)]">{lookup.contact.name}</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(lookup.effective).map(([ch, s]) => (
                  <Badge key={ch} tone={stateTone(s.state)}>{ch}: {s.state}</Badge>
                ))}
                {Object.keys(lookup.effective).length === 0 && <span className="text-[var(--fp-text-2)]">No consent data — effective state UNKNOWN on every channel.</span>}
              </div>
              <p className="text-xs text-[var(--fp-text-2)]">
                {lookup.records.length} consent record(s) · {lookup.suppressions.length} suppression(s)
              </p>
            </div>
          )}
        </section>

        {/* Record */}
        <section className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-4">
          <h2 className="mb-3 text-sm font-semibold text-[var(--fp-text)]">Record consent</h2>
          <div className="space-y-3">
            <Input label="Contact id" value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })} placeholder="Contact id" />
            <div className="grid grid-cols-2 gap-3">
              <Select label="Channel" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} options={CHANNELS.map((c) => ({ value: c, label: c }))} />
              <Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} options={[{ value: "OPTED_IN", label: "OPTED_IN" }, { value: "OPTED_OUT", label: "OPTED_OUT" }]} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Source" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
              <Input label="Wording version (optional)" value={form.wordingVersion} onChange={(e) => setForm({ ...form, wordingVersion: e.target.value })} />
            </div>
            {formMsg && <p className="text-sm text-[var(--fp-text-2)]">{formMsg}</p>}
            <Button size="sm" onClick={() => void submitRecord()} loading={saving} disabled={!form.contactId.trim()}>Record</Button>
          </div>
        </section>
      </div>

      {/* Suppressions */}
      <h2 className="mb-2 text-sm font-semibold text-[var(--fp-text)]">Suppressions</h2>
      {loading ? (
        <Spinner label="Loading consent data" />
      ) : suppressions.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No suppressions" description="Opted-out contacts will appear here with their reason." />
      ) : (
        <div className="mb-6 overflow-x-auto rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
          <table className="w-full min-w-[640px] text-start text-sm">
            <thead>
              <tr className="border-b border-[var(--fp-border)] text-xs uppercase tracking-wide text-[var(--fp-text-2)]">
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Channel</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {suppressions.map((s) => (
                <tr key={s.id} className="border-b border-[var(--fp-border)] last:border-0">
                  <td className="px-4 py-3">{s.contactName ?? s.contactId}</td>
                  <td className="px-4 py-3"><Badge tone="red">{s.channel ?? "all channels"}</Badge></td>
                  <td className="px-4 py-3 text-[var(--fp-text-2)]">{s.reason || "—"}</td>
                  <td className="px-4 py-3 text-xs text-[var(--fp-text-2)]">{new Date(s.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Records */}
      <h2 className="mb-2 text-sm font-semibold text-[var(--fp-text)]">Consent records</h2>
      {loading ? (
        <Spinner label="Loading consent data" />
      ) : records.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No consent records" description="Records from imports, manual entry, and the API will appear here." />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
          <table className="w-full min-w-[640px] text-start text-sm">
            <thead>
              <tr className="border-b border-[var(--fp-border)] text-xs uppercase tracking-wide text-[var(--fp-text-2)]">
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Channel</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Wording</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="border-b border-[var(--fp-border)] last:border-0">
                  <td className="px-4 py-3">{r.contactName ?? r.contactId}</td>
                  <td className="px-4 py-3"><Badge tone="cyan">{r.channel}</Badge></td>
                  <td className="px-4 py-3"><Badge tone={stateTone(r.status)}>{r.status}</Badge></td>
                  <td className="px-4 py-3 text-[var(--fp-text-2)]">{r.source}</td>
                  <td className="px-4 py-3 text-[var(--fp-text-2)]">{r.wordingVersion ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
