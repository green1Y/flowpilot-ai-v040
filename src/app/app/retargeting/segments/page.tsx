"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import {
  ArrowLeft, Plus, Pencil, Trash2, Play, AlertTriangle, Users, X,
} from "lucide-react";

/* Client-safe copy of the segment field catalog (see src/lib/retargeting/segments.ts). */
const FIELDS: Array<{ field: string; label: string; operators: string[] }> = [
  { field: "tag", label: "Contact tag", operators: ["contains", "not_contains"] },
  { field: "channel", label: "Source channel", operators: ["eq", "neq"] },
  { field: "leadStatus", label: "Lead status", operators: ["eq", "neq"] },
  { field: "lastInboundAt", label: "Last inbound message", operators: ["older_than_days", "newer_than_days"] },
  { field: "messageCount", label: "Inbound message count", operators: ["eq", "neq", "gt", "gte", "lt", "lte"] },
  { field: "purchaseCount", label: "Purchase count", operators: ["eq", "neq", "gt", "gte", "lt", "lte"] },
  { field: "abandonedCart", label: "Abandoned cart", operators: ["is_true", "is_false"] },
  { field: "optedOut", label: "Opted out", operators: ["is_true", "is_false"] },
  { field: "email", label: "Email address", operators: ["exists", "not_exists"] },
  { field: "phone", label: "Phone number", operators: ["exists", "not_exists"] },
];

const VALUELESS = new Set(["is_true", "is_false", "exists", "not_exists"]);

interface Rule { field: string; operator: string; value?: string }
interface Group { op: "and" | "or"; rules: Array<Rule | Group> }
interface Segment {
  id: string; name: string; description: string;
  conditions: Group; createdAt: string;
}
interface Preview {
  count: number;
  sample: Array<{ contactId: string; name: string; channel: string; leadStatus: string; tags: string[] }>;
  summary: string;
  availabilityWarnings: string[];
}

const isGroup = (r: Rule | Group): r is Group =>
  typeof (r as Group).op === "string" && Array.isArray((r as Group).rules);

const newRule = (): Rule => ({ field: "tag", operator: "contains", value: "" });
const newGroup = (): Group => ({ op: "and", rules: [newRule()] });

function RuleEditor({
  rule, onChange, onRemove,
}: {
  rule: Rule; onChange: (r: Rule) => void; onRemove: () => void;
}) {
  const field = FIELDS.find((f) => f.field === rule.field) ?? FIELDS[0];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg)] px-2 py-2">
      <select
        value={rule.field}
        onChange={(e) => {
          const f = FIELDS.find((x) => x.field === e.target.value) ?? FIELDS[0];
          onChange({ field: f.field, operator: f.operators[0], value: "" });
        }}
        className="rounded-lg bg-[var(--fp-bg-2)] border border-[var(--fp-border)] px-2 py-1.5 text-xs"
      >
        {FIELDS.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
      </select>
      <select
        value={rule.operator}
        onChange={(e) => onChange({ ...rule, operator: e.target.value, value: VALUELESS.has(e.target.value) ? undefined : (rule.value ?? "") })}
        className="rounded-lg bg-[var(--fp-bg-2)] border border-[var(--fp-border)] px-2 py-1.5 text-xs"
      >
        {field.operators.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {!VALUELESS.has(rule.operator) && (
        <input
          value={rule.value ?? ""}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          placeholder="value"
          className="rounded-lg bg-[var(--fp-bg-2)] border border-[var(--fp-border)] px-2 py-1.5 text-xs w-32"
        />
      )}
      <button onClick={onRemove} className="text-[var(--fp-text-2)] hover:text-red-400" title="Remove rule">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function GroupEditor({
  group, depth, onChange,
}: {
  group: Group; depth: number; onChange: (g: Group) => void;
}) {
  const updateRule = (i: number, r: Rule | Group) => {
    const rules = group.rules.slice();
    rules[i] = r;
    onChange({ ...group, rules });
  };
  const removeRule = (i: number) => {
    onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) });
  };
  return (
    <div className={`rounded-xl border p-3 space-y-2 ${depth > 0 ? "border-dashed ml-4" : "border-[var(--fp-border)] bg-[var(--fp-bg-2)]"}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--fp-text-2)]">Match</span>
        <div className="flex rounded-lg overflow-hidden border border-[var(--fp-border)]">
          {(["and", "or"] as const).map((op) => (
            <button
              key={op}
              onClick={() => onChange({ ...group, op })}
              className={`px-3 py-1 text-xs font-medium uppercase ${group.op === op ? "bg-[var(--fp-accent)] text-white" : "text-[var(--fp-text-2)]"}`}
            >
              {op === "and" ? "All" : "Any"}
            </button>
          ))}
        </div>
        <span className="text-xs text-[var(--fp-text-2)]">of the following</span>
      </div>
      {group.rules.map((r, i) => (
        <div key={i}>
          {isGroup(r) ? (
            <GroupEditor group={r} depth={depth + 1} onChange={(g) => updateRule(i, g)} />
          ) : (
            <RuleEditor rule={r} onChange={(nr) => updateRule(i, nr)} onRemove={() => removeRule(i)} />
          )}
          {i < group.rules.length - 1 && (
            <p className="text-[10px] uppercase tracking-wide text-[var(--fp-text-2)] my-1 ml-1">{group.op}</p>
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => onChange({ ...group, rules: [...group.rules, newRule()] })}>
          <Plus className="h-3 w-3 mr-1" /> Rule
        </Button>
        {depth < 1 && (
          <Button variant="ghost" size="sm" onClick={() => onChange({ ...group, rules: [...group.rules, newGroup()] })}>
            <Plus className="h-3 w-3 mr-1" /> Group
          </Button>
        )}
      </div>
    </div>
  );
}

export default function SegmentsPage() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Segment | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tree, setTree] = useState<Group>({ op: "and", rules: [newRule()] });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ segments: Segment[] }>("/api/retargeting/segments");
      setSegments(res.segments);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load segments");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setTree({ op: "and", rules: [newRule()] });
    setPreview(null);
    setModalOpen(true);
  };

  const openEdit = (s: Segment) => {
    setEditing(s);
    setName(s.name);
    setDescription(s.description);
    setTree(s.conditions?.rules ? s.conditions : { op: "and", rules: [newRule()] });
    setPreview(null);
    setModalOpen(true);
  };

  const save = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await api(`/api/retargeting/segments/${editing.id}`, {
          method: "PUT",
          body: { name: name.trim(), description, conditions: tree },
        });
      } else {
        await api("/api/retargeting/segments", {
          method: "POST",
          body: { name: name.trim(), description, conditions: tree },
        });
      }
      setModalOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to save segment");
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    const id = editing?.id;
    if (!id) { setError("Save the segment first to preview it against live data."); return; }
    setPreviewing(true);
    try {
      const res = await api<Preview>(`/api/retargeting/segments/${id}/preview`, { method: "POST" });
      setPreview(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this segment? Campaigns using it must be reassigned first.")) return;
    setDeleting(id);
    try {
      await api(`/api/retargeting/segments/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Delete failed");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audiences"
        description="Define who a retargeting campaign reaches. Conditions evaluate against your real contact, message, order, and suppression data."
        actions={
          <>
            <Link href="/app/retargeting">
              <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1.5" /> Campaigns</Button>
            </Link>
            <Button onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> New segment</Button>
          </>
        }
      />

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-[#FB7185]/40 bg-[#FB7185]/10 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-[#FB7185]" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : segments.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No audience segments yet"
          description="Example: tag contains vip AND last inbound older than 30 days — your win-back list."
          action={<Button onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Create a segment</Button>}
        />
      ) : (
        <div className="grid gap-4">
          {segments.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-[var(--fp-text)]">{s.name}</p>
                  {s.description && <p className="text-sm text-[var(--fp-text-2)] truncate">{s.description}</p>}
                  <p className="text-xs text-[var(--fp-text-2)] mt-1">
                    {s.conditions?.rules?.length ?? 0} rule{(s.conditions?.rules?.length ?? 0) === 1 ? "" : "s"}
                    {" "}({s.conditions?.op === "or" ? "any" : "all"} must match)
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => openEdit(s)}>
                    <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit
                  </Button>
                  <Button variant="danger" size="sm" disabled={deleting === s.id} onClick={() => remove(s.id)}>
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? "Edit segment" : "New segment"}>
        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="VIP win-back" />
          <Textarea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          <div>
            <p className="text-sm font-medium mb-2">Conditions</p>
            <GroupEditor group={tree} depth={0} onChange={setTree} />
          </div>
          <div className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3 text-xs text-[var(--fp-text-2)] space-y-1">
            <p className="font-medium text-[var(--fp-text)]">Data honesty</p>
            <p>purchaseCount needs ContactOrder rows (connected store or imports) — Meta doesn’t expose purchases.</p>
            <p>abandonedCart needs a connected store — Meta doesn’t expose cart data.</p>
            <p>lastInboundAt / messageCount accumulate from inbound webhooks on connected channels.</p>
          </div>
          {editing && (
            <div>
              <Button variant="secondary" size="sm" disabled={previewing} onClick={runPreview}>
                <Play className="h-3.5 w-3.5 mr-1.5" /> {previewing ? "Previewing…" : "Preview against live data"}
              </Button>
              {preview && (
                <div className="mt-3 rounded-xl border border-[var(--fp-border)] p-3 text-sm space-y-2">
                  <p><Badge tone="green">{preview.count} matching</Badge> <span className="text-[var(--fp-text-2)] ml-2">{preview.summary}</span></p>
                  {preview.availabilityWarnings.map((w) => (
                    <p key={w} className="text-xs text-amber-500 flex gap-1"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{w}</p>
                  ))}
                  {preview.sample.map((c) => (
                    <p key={c.contactId} className="text-xs">{c.name} <span className="text-[var(--fp-text-2)]">· {c.channel} · {c.leadStatus} · {c.tags.join(", ") || "no tags"}</span></p>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button disabled={saving} onClick={save}>{saving ? "Saving…" : editing ? "Save changes" : "Create segment"}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
