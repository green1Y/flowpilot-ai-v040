"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { Search, Plus, Download, Trash2, AlertTriangle } from "lucide-react";

/* ------------------------------------------------------------------ */

interface Prospect {
  id: string;
  businessName: string;
  industry?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  region?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
  sourceType: string;
  qualificationScore?: number | null;
  qualificationReasons: string[];
  status: string;
  verified: boolean;
}

interface ProspectSearchRow {
  id: string;
  industry: string;
  country?: string | null;
  region?: string | null;
  status: string;
  error?: string | null;
  targetCount: number;
  createdAt: string;
}

const STATUSES = ["NEW", "QUALIFIED", "REJECTED", "CONTACTED"];

export default function ProspectingPage() {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [searches, setSearches] = useState<ProspectSearchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [filterSearch, setFilterSearch] = useState("");

  // Search creation form
  const [industry, setIndustry] = useState("");
  const [country, setCountry] = useState("");
  const [region, setRegion] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [keywords, setKeywords] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [targetCount, setTargetCount] = useState("25");
  const [submittingSearch, setSubmittingSearch] = useState(false);

  // Manual-add form
  const [showManual, setShowManual] = useState(false);
  const [mName, setMName] = useState("");
  const [mIndustry, setMIndustry] = useState("");
  const [mWebsite, setMWebsite] = useState("");
  const [mEmail, setMEmail] = useState("");
  const [mPhone, setMPhone] = useState("");
  const [mCountry, setMCountry] = useState("");
  const [mRegion, setMRegion] = useState("");
  const [mSourceUrl, setMSourceUrl] = useState("");
  const [mDescription, setMDescription] = useState("");
  const [submittingManual, setSubmittingManual] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, s] = await Promise.all([
        api<{ prospects: Prospect[] }>("/api/prospects", {
          params: {
            ...(filterStatus ? { status: filterStatus } : {}),
            ...(filterCountry ? { country: filterCountry } : {}),
            ...(filterSearch ? { search: filterSearch } : {}),
          },
        }),
        api<{ searches: ProspectSearchRow[] }>("/api/prospects/searches").catch(() => ({ searches: [] })),
      ]);
      setProspects(p.prospects ?? []);
      setSearches(s.searches ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load prospects");
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterCountry, filterSearch]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setSubmittingSearch(true);
    setBlocked(null);
    setNotice(null);
    try {
      const res = await api<{ search: ProspectSearchRow; blocked: boolean; prerequisite?: string }>(
        "/api/prospects/searches",
        {
          method: "POST",
          body: {
            industry,
            country: country || null,
            region: region || null,
            businessType: businessType || null,
            keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
            exclusions: exclusions.split(",").map((k) => k.trim()).filter(Boolean),
            targetCount: parseInt(targetCount, 10) || 25,
          },
        }
      );
      // v0.4.0: no provider is configured, so this is always the blocked state.
      if (res.blocked) setBlocked(res.prerequisite ?? "No search provider is configured.");
      setSearches((prev) => [res.search, ...prev]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to create search");
    } finally {
      setSubmittingSearch(false);
    }
  }

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    setSubmittingManual(true);
    setNotice(null);
    try {
      const res = await api<{ prospect: Prospect }>("/api/prospects", {
        method: "POST",
        body: {
          businessName: mName,
          industry: mIndustry || null,
          website: mWebsite || null,
          email: mEmail || null,
          phone: mPhone || null,
          country: mCountry || null,
          region: mRegion || null,
          description: mDescription || null,
          sourceUrl: mSourceUrl || null,
          sourceType: "manual",
        },
      });
      setProspects((prev) => [res.prospect, ...prev]);
      setNotice(`Added “${res.prospect.businessName}”.`);
      setShowManual(false);
      setMName(""); setMIndustry(""); setMWebsite(""); setMEmail(""); setMPhone("");
      setMCountry(""); setMRegion(""); setMSourceUrl(""); setMDescription("");
    } catch (e) {
      if (e instanceof ApiError && e.code === "DUPLICATE_PROSPECT") {
        setNotice("That prospect already exists (same website, or same name + country). No duplicate was created.");
      } else {
        setError(e instanceof ApiError ? e.message : "Failed to add prospect");
      }
    } finally {
      setSubmittingManual(false);
    }
  }

  async function removeProspect(id: string) {
    if (!confirm("Delete this prospect?")) return;
    try {
      await api(`/api/prospects/${id}`, { method: "DELETE" });
      setProspects((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to delete prospect");
    }
  }

  function exportCsv() {
    // Authenticated file download: same-origin fetch, then a blob download.
    window.location.href = "/api/prospects/export";
  }

  return (
    <div>
      <PageHeader
        title="Prospecting"
        description="Find and qualify businesses to reach out to. Prospect data here is user-entered or imported only — never AI-invented."
        actions={
          <>
            <Button variant="secondary" onClick={() => setShowManual((v) => !v)}>
              <Plus size={16} /> Add prospect manually
            </Button>
            <Button variant="secondary" onClick={exportCsv}>
              <Download size={16} /> Export CSV
            </Button>
          </>
        }
      />

      <div className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-[var(--fp-text)] flex gap-2">
        <AlertTriangle size={18} className="shrink-0 mt-0.5" />
        <span>
          <strong>Data honesty:</strong> prospect records are created only from what you type,
          what you import, or a real provider response with a source link. FlowPilot never
          invents an email, phone number, revenue figure, employee, or company fact. A prospect
          without a source link is labeled <em>unverified — user-entered</em>.
        </span>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm">
          {notice}
        </div>
      )}

      {/* Search creation */}
      <section className="mb-8 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-5">
        <h2 className="text-base font-semibold mb-1 flex items-center gap-2">
          <Search size={18} /> New prospect search
        </h2>
        <p className="text-sm text-[var(--fp-text-2)] mb-4">
          Automated search is blocked in v0.4.0: no search/business-data provider is configured.
          Submitting saves the search as BLOCKED_NO_SOURCE so it can run once a provider is configured.
        </p>
        <form onSubmit={submitSearch} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input label="Industry *" value={industry} onChange={(e) => setIndustry(e.target.value)} required placeholder="e.g. Plumbing" />
          <Input label="Country" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. EG" />
          <Input label="Region" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="e.g. Cairo" />
          <Input label="Business type" value={businessType} onChange={(e) => setBusinessType(e.target.value)} placeholder="e.g. Service company" />
          <Input label="Keywords (comma-separated)" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="emergency, residential" />
          <Input label="Exclusions (comma-separated)" value={exclusions} onChange={(e) => setExclusions(e.target.value)} placeholder="franchise" />
          <Input label="Target count" type="number" min={1} max={500} value={targetCount} onChange={(e) => setTargetCount(e.target.value)} />
          <div className="flex items-end">
            <Button type="submit" disabled={submittingSearch || !industry.trim()}>
              {submittingSearch ? "Saving…" : "Create search"}
            </Button>
          </div>
        </form>
        {blocked && (
          <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm" role="status">
            <strong>Search blocked — no provider configured.</strong> {blocked}
          </div>
        )}
        {searches.length > 0 && (
          <div className="mt-4 space-y-2">
            {searches.slice(0, 5).map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={s.status === "BLOCKED_NO_SOURCE" ? "amber" : "gray"}>{s.status}</Badge>
                <span>{s.industry}</span>
                {s.region && <span className="text-[var(--fp-text-2)]">{s.region}</span>}
                {s.country && <span className="text-[var(--fp-text-2)]">{s.country}</span>}
                <span className="text-[var(--fp-text-2)]">target {s.targetCount}</span>
                {s.error && <span className="text-[var(--fp-text-2)]">{s.error}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Manual add */}
      {showManual && (
        <section className="mb-8 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-5">
          <h2 className="text-base font-semibold mb-4">Add a prospect manually</h2>
          <form onSubmit={submitManual} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input label="Business name *" value={mName} onChange={(e) => setMName(e.target.value)} required />
            <Input label="Industry" value={mIndustry} onChange={(e) => setMIndustry(e.target.value)} />
            <Input label="Website" value={mWebsite} onChange={(e) => setMWebsite(e.target.value)} placeholder="https://…" />
            <Input label="Email" type="email" value={mEmail} onChange={(e) => setMEmail(e.target.value)} />
            <Input label="Phone" value={mPhone} onChange={(e) => setMPhone(e.target.value)} />
            <Input label="Country" value={mCountry} onChange={(e) => setMCountry(e.target.value)} />
            <Input label="Region" value={mRegion} onChange={(e) => setMRegion(e.target.value)} />
            <Input label="Source URL (verification link)" value={mSourceUrl} onChange={(e) => setMSourceUrl(e.target.value)} placeholder="https://… where you found this business" />
            <div className="sm:col-span-2 lg:col-span-3">
              <Textarea label="Description" value={mDescription} onChange={(e) => setMDescription(e.target.value)} rows={3} />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <Button type="submit" disabled={submittingManual || !mName.trim()}>
                {submittingManual ? "Adding…" : "Add prospect"}
              </Button>
            </div>
          </form>
          <p className="mt-3 text-xs text-[var(--fp-text-2)]">
            Only enter facts you actually know or can link to. Duplicates (same website, or same
            name + country) are rejected with a warning instead of creating a second record.
          </p>
        </section>
      )}

      {/* Filters + list */}
      <section>
        <div className="mb-4 flex flex-wrap gap-3">
          <Input label="Search by name" value={filterSearch} onChange={(e) => setFilterSearch(e.target.value)} placeholder="Business name…" />
          <Input label="Country filter" value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)} placeholder="EG" />
          <Select
            label="Status filter"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            options={STATUSES.map((s) => ({ value: s, label: s }))}
            placeholder="All statuses"
          />
          <div className="flex items-end">
            <Button variant="secondary" onClick={load}>Apply filters</Button>
          </div>
        </div>

        {loading ? (
          <Spinner />
        ) : prospects.length === 0 ? (
          <EmptyState title="No prospects yet" description="Add one manually above, or create a search (blocked until a provider is configured)." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-[var(--fp-border)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--fp-text-2)]">
                  <th className="px-4 py-3">Business</th>
                  <th className="px-4 py-3">Industry / Location</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {prospects.map((p) => (
                  <tr key={p.id} className="border-t border-[var(--fp-border)] align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{p.businessName}</div>
                      {p.website && <div className="text-xs text-[var(--fp-text-2)] break-all">{p.website}</div>}
                      {p.description && <div className="text-xs text-[var(--fp-text-2)] mt-1">{p.description}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {p.industry ?? "—"}
                      <div className="text-xs text-[var(--fp-text-2)]">{[p.region, p.country].filter(Boolean).join(", ") || "—"}</div>
                    </td>
                    <td className="px-4 py-3">
                      {p.email ?? "—"}
                      <div className="text-xs text-[var(--fp-text-2)]">{p.phone ?? ""}</div>
                    </td>
                    <td className="px-4 py-3">
                      {p.qualificationScore ?? "—"}
                      {p.qualificationReasons.length > 0 && (
                        <div className="text-xs text-[var(--fp-text-2)]">{p.qualificationReasons.join(" · ")}</div>
                      )}
                    </td>
                    <td className="px-4 py-3"><Badge>{p.status}</Badge></td>
                    <td className="px-4 py-3">
                      {p.verified ? (
                        <span className="text-xs">Verified — <span className="break-all">{p.sourceUrl}</span></span>
                      ) : (
                        <span className="text-xs text-amber-500">unverified — user-entered</span>
                      )}
                      <div className="text-xs text-[var(--fp-text-2)]">{p.sourceType}</div>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        aria-label={`Delete ${p.businessName}`}
                        onClick={() => removeProspect(p.id)}
                        className="text-[var(--fp-text-2)] hover:text-red-500"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
