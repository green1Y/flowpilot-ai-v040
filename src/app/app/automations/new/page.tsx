"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TEMPLATES, TEMPLATE_CATEGORIES } from "@/lib/workflows/templates";

export default function NewWorkflowPage() {
  const router = useRouter();
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState("");

  const filtered = useMemo(
    () =>
      TEMPLATES.filter(
        (t) =>
          (category === "All" || t.category === category) &&
          (search.trim() === "" ||
            `${t.name} ${t.description}`.toLowerCase().includes(search.trim().toLowerCase()))
      ),
    [category, search]
  );

  async function useTemplate(templateId: string) {
    const template = TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    setCreating(templateId);
    setError("");
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: template.name,
          description: template.description,
          nodes: template.nodes.map((n) => ({
            id: n.id,
            kind: n.kind,
            type: n.type,
            label: n.label,
            config: n.config,
            position: n.position,
          })),
          edges: template.edges.map((e) => ({
            id: e.id,
            sourceId: e.sourceId,
            targetId: e.targetId,
            label: e.label,
            condition: {},
          })),
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Failed to create workflow");
      router.push(`/app/automations/${json.data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create workflow");
      setCreating(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <nav className="mb-4 text-sm text-[var(--fp-text-2)]">
        <Link href="/app/automations" className="hover:text-[var(--fp-text)]">Automations</Link>
        <span className="mx-2">/</span>
        <span className="font-medium text-[var(--fp-text)]">New workflow</span>
      </nav>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">Start from a template</h1>
        <p className="text-sm text-[var(--fp-text-2)]">
          Pick a playbook — it opens in the builder where you can tweak every step before publishing.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-1">
          {["All", ...TEMPLATE_CATEGORIES].map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                category === c ? "bg-[var(--fp-accent)] text-white" : "text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search templates…"
          className="w-64 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] px-3 py-2 text-sm outline-none placeholder:text-[var(--fp-text-2)] focus:border-[var(--fp-accent)]"
        />
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((t) => (
          <div key={t.id} className="flex flex-col rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-5">
            <div className="mb-1 flex items-center justify-between">
              <span className="rounded-full bg-[var(--fp-accent)]/15 px-2.5 py-0.5 text-xs font-medium text-[var(--fp-accent-2)]">
                {t.category}
              </span>
              <span className="text-xs text-[var(--fp-text-2)]">{t.nodes.length} steps</span>
            </div>
            <h3 className="font-semibold">{t.name}</h3>
            <p className="mb-3 mt-1 line-clamp-3 text-sm text-[var(--fp-text-2)]">{t.description}</p>
            {t.requiredIntegrations.length > 0 && (
              <p className="mb-3 text-xs text-[var(--fp-text-2)]">
                Needs: {t.requiredIntegrations.join(", ")}
              </p>
            )}
            <button
              onClick={() => useTemplate(t.id)}
              disabled={creating !== null}
              className="btn-gradient mt-auto rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {creating === t.id ? "Creating…" : "Use template"}
            </button>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="py-12 text-center text-sm text-[var(--fp-text-2)]">No templates match your search.</p>
      )}
    </div>
  );
}
