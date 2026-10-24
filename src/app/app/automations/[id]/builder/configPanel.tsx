"use client";

/**
 * Node / edge configuration panel.
 * - Schema-driven form from the node's Zod config schema
 * - Credential picker (server-side integration names/ids only — never secrets)
 * - {{variable}} insertion from trigger outputs + upstream steps
 * - Input/output preview (upstream chain)
 * - Test Step for condition nodes (server-side, side-effect free)
 * - Permission warnings
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Edge } from "@xyflow/react";
import { Trash2, FlaskConical, Variable, ChevronDown, CircleAlert } from "lucide-react";
import { z } from "zod";
import { NODE_TYPES } from "@/lib/workflows/nodeRegistry";
import type { BuilderNode, IntegrationRef } from "./types";
import { useBuilderLocale } from "./i18n";

// ── Zod schema → form fields (same introspection as the original builder) ─

type FieldKind = "text" | "textarea" | "number" | "boolean" | "select" | "stringlist" | "json";

interface FieldDesc {
  key: string;
  kind: FieldKind;
  required: boolean;
  options?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapZod(t: any): any {
  let cur = t;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const tn = cur._def?.typeName;
    if (tn === "ZodOptional" || tn === "ZodDefault" || tn === "ZodNullable") cur = cur._def.innerType;
    else break;
  }
  return cur;
}

function introspect(schema: z.ZodType): FieldDesc[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = schema as any;
  if (raw?._def?.typeName !== "ZodObject" || typeof raw.shape !== "object") return [];
  return Object.entries(raw.shape).map(([key, fieldRaw]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = fieldRaw as any;
    const wrapped = f?._def?.typeName;
    const required = wrapped !== "ZodOptional" && wrapped !== "ZodDefault";
    const inner = unwrapZod(f);
    const tn = inner?._def?.typeName;
    let kind: FieldKind = "text";
    let options: string[] | undefined;
    if (tn === "ZodNumber") kind = "number";
    else if (tn === "ZodBoolean") kind = "boolean";
    else if (tn === "ZodEnum") {
      kind = "select";
      options = inner._def.values as string[];
    } else if (tn === "ZodArray") {
      const elem = unwrapZod(inner._def.type);
      kind = elem?._def?.typeName === "ZodString" ? "stringlist" : "json";
    } else if (tn === "ZodString") {
      const longHint = /body|note|message|instructions|description|reply|subject/i.test(key);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const maxCheck = (inner._def.checks ?? []).find((c: any) => c.kind === "max");
      kind = longHint || (maxCheck && maxCheck.value > 160) ? "textarea" : "text";
    } else {
      kind = "json";
    }
    return { key, kind, required, options };
  });
}

function fieldInputClass() {
  return "w-full rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--fp-accent)]";
}

/** Variables a trigger exposes for {{placeholders}} in message bodies. */
const TRIGGER_VARS: Record<string, string[]> = {
  "trigger.new_message": ["name", "text", "from", "channel", "email"],
  "trigger.new_comment": ["name", "text", "from", "channel", "commentId"],
  "trigger.new_conversation": ["name", "from", "channel"],
  "trigger.new_lead": ["name", "email", "phone", "leadScore"],
  "trigger.keyword": ["name", "text", "from", "channel"],
  "trigger.tag_added": ["name", "tag"],
  "trigger.commerce_event": ["orderId", "amount", "name"],
  "trigger.webhook": ["type"],
  "trigger.scheduled": ["type"],
  "trigger.manual": ["type"],
};

const PERMISSION_HINTS: Record<string, string> = {
  "messages:send": "send messages on the channel",
  "ai:generate": "use the AI provider",
  "crm:write": "write to the CRM",
  "conversations:assign": "assign conversations",
  "conversations:write": "write conversation notes",
  "team:notify": "notify the team",
  "approvals:request": "request approvals",
  "integrations:invoke": "call external integrations",
};

interface NodeConfigPanelProps {
  node: BuilderNode;
  allNodes: BuilderNode[];
  edges: Edge[];
  integrations: IntegrationRef[];
  onApply: (label: string, config: Record<string, unknown>, disabled?: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
  onJumpToNode: (nodeId: string) => void;
  workflowId: string;
}

export function NodeConfigPanel({
  node,
  allNodes,
  edges,
  integrations,
  onApply,
  onDelete,
  onClose,
  onJumpToNode,
  workflowId,
}: NodeConfigPanelProps) {
  const { t } = useBuilderLocale();
  const def = NODE_TYPES[node.data.nodeType];
  const [label, setLabel] = useState(node.data.label);
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    structuredClone(node.data.config)
  );
  const [disabled, setDisabled] = useState(!!node.data.disabled);
  const [schemaError, setSchemaError] = useState("");
  const [showVars, setShowVars] = useState<string | null>(null);
  const [showUpstream, setShowUpstream] = useState(false);
  // Test step
  const [testOpen, setTestOpen] = useState(false);
  const [testEvent, setTestEvent] = useState(
    JSON.stringify({ type: "new_message", channel: "instagram", from: "user_1", name: "Alex", text: "What are your prices?" }, null, 2)
  );
  const [testBusy, setTestBusy] = useState(false);
  const [testVerdict, setTestVerdict] = useState<null | { matched: boolean; note?: string; error?: string }>(null);
  const activeInputRef = useRef<{ el: HTMLInputElement | HTMLTextAreaElement; key: string } | null>(null);

  const fields = useMemo(() => (def ? introspect(def.configSchema) : []), [def]);
  const hasIntegrationField = useMemo(
    () => fields.some((f) => f.key === "integrationId"),
    [fields]
  );

  const availableVars = useMemo(() => {
    const vars = new Set<string>();
    for (const n of allNodes) {
      if (n.data.kind === "trigger") {
        for (const v of TRIGGER_VARS[n.data.nodeType] ?? []) vars.add(v);
      }
    }
    return [...vars];
  }, [allNodes]);

  const upstream = useMemo(() => {
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const chain: BuilderNode[] = [];
    const seen = new Set<string>([node.id]);
    let frontier = edges.filter((e) => e.target === node.id).map((e) => e.source);
    while (frontier.length && chain.length < 8) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const n = byId.get(id);
        if (n) {
          chain.unshift(n);
          next.push(...edges.filter((e) => e.target === id).map((e) => e.source));
        }
      }
      frontier = next;
    }
    return chain;
  }, [allNodes, edges, node.id]);

  useEffect(() => {
    setLabel(node.data.label);
    setDraft(structuredClone(node.data.config));
    setDisabled(!!node.data.disabled);
    setSchemaError("");
    setTestVerdict(null);
  }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!def) {
    return (
      <div>
        <p className="text-sm text-red-300">Unknown node type: {String(node.data.nodeType)}</p>
        <button onClick={onClose} className="mt-4 rounded-lg bg-white/5 px-3 py-1.5 text-sm">
          {t.builder.cancel}
        </button>
      </div>
    );
  }

  function setField(key: string, value: unknown) {
    setDraft((d) => ({ ...d, [key]: value }));
    setSchemaError("");
  }

  function insertVariable(varName: string) {
    const ref = activeInputRef.current;
    if (!ref) {
      setField(showVars!, `${String(draft[showVars!] ?? "")}{{${varName}}}`);
      return;
    }
    const { el, key } = ref;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const token = `{{${varName}}}`;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    setField(key, next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function apply() {
    const parsed = def.configSchema.safeParse({ ...def.defaults, ...draft });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setSchemaError(`${issue.path.join(".") || "config"}: ${issue.message}`);
      return;
    }
    onApply(label.trim() || def.label, parsed.data as Record<string, unknown>, disabled);
  }

  async function runTestStep() {
    setTestBusy(true);
    setTestVerdict(null);
    try {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(testEvent);
      } catch {
        setTestVerdict({ matched: false, error: "Invalid JSON in sample event" });
        return;
      }
      const res = await fetch(`/api/workflows/${workflowId}/test-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeType: node.data.nodeType, config: draft, event }),
      });
      const json = await res.json();
      if (!json.ok) {
        setTestVerdict({ matched: false, error: json.error ?? "Test failed" });
        return;
      }
      setTestVerdict({ matched: json.data.matched, note: json.data.note ?? undefined });
    } catch (e) {
      setTestVerdict({ matched: false, error: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTestBusy(false);
    }
  }

  const canTestStep = def.kind === "condition" || node.data.nodeType === "flow.if_else";

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">{t.builder.config.title}</h3>
        <button
          onClick={onClose}
          aria-label="Close panel"
          className="rounded-lg px-2 py-1 text-[var(--fp-text-2)] hover:text-[var(--fp-text)] focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)]"
        >
          ✕
        </button>
      </div>
      <p className="mb-3 text-xs text-[var(--fp-text-2)]">{def.description}</p>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium text-[var(--fp-text-2)]">
          {t.builder.config.label}
        </span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} className={fieldInputClass()} />
      </label>

      <label className="mb-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={disabled}
          onChange={(e) => setDisabled(e.target.checked)}
          className="h-4 w-4 accent-[var(--fp-accent)]"
        />
        {disabled ? t.builder.nodeStates.disabled : t.builder.nodeMenu.disable}
      </label>

      {fields.length === 0 && (
        <p className="mb-3 text-xs text-[var(--fp-text-2)]">This node has no configuration.</p>
      )}

      {fields
        .filter((f) => f.key !== "integrationId")
        .map((f) => (
          <div key={f.key} className="mb-3">
            <span className="mb-1 block text-xs font-medium text-[var(--fp-text-2)]">
              {f.key}
              {f.required && <span className="text-red-400"> *</span>}
            </span>
            <FieldInput
              field={f}
              value={draft[f.key]}
              onChange={(v) => setField(f.key, v)}
              onFocus={(el) => {
                activeInputRef.current = { el, key: f.key };
              }}
            />
            {(f.kind === "text" || f.kind === "textarea") && availableVars.length > 0 && (
              <div className="mt-1">
                <button
                  onClick={() => setShowVars(showVars === f.key ? null : f.key)}
                  className="inline-flex items-center gap-1 text-xs text-[var(--fp-accent-2)] hover:underline"
                >
                  <Variable size={12} /> {t.builder.config.variables}
                </button>
                {showVars === f.key && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {availableVars.map((v) => (
                      <button
                        key={v}
                        onClick={() => insertVariable(v)}
                        className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-xs hover:bg-white/10"
                      >
                        {`{{${v}}}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

      {hasIntegrationField && (
        <div className="mb-3">
          <span className="mb-1 block text-xs font-medium text-[var(--fp-text-2)]">
            {t.builder.config.credential}
          </span>
          <select
            value={String(draft.integrationId ?? "")}
            onChange={(e) => setField("integrationId", e.target.value)}
            className={fieldInputClass()}
          >
            <option value="">{t.builder.config.noCredential}</option>
            {integrations.map((i) => (
              <option key={i.id ?? i.provider} value={i.id ?? ""}>
                {i.displayName} — {i.connectionState}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-[var(--fp-text-2)]">{t.builder.config.credentialHint}</p>
        </div>
      )}

      {/* Upstream preview */}
      <button
        onClick={() => setShowUpstream(!showUpstream)}
        className="mb-2 flex w-full items-center justify-between text-xs font-medium text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
      >
        <span>
          {t.builder.config.upstream} ({upstream.length})
        </span>
        <ChevronDown size={14} className={showUpstream ? "rotate-180" : ""} />
      </button>
      {showUpstream && (
        <div className="mb-3 space-y-1">
          {upstream.length === 0 && (
            <p className="text-xs text-[var(--fp-text-2)]">{t.builder.config.noUpstream}</p>
          )}
          {upstream.map((n) => (
            <button
              key={n.id}
              onClick={() => onJumpToNode(n.id)}
              className="flex w-full items-center justify-between rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg)] px-2.5 py-1.5 text-left text-xs hover:border-[var(--fp-accent)]"
            >
              <span className="truncate font-medium">{n.data.label}</span>
              <span className="ms-2 shrink-0 font-mono text-[var(--fp-text-2)]">{n.data.nodeType}</span>
            </button>
          ))}
        </div>
      )}

      {/* Test step */}
      {canTestStep && (
        <div className="mb-3 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg)] p-3">
          <button
            onClick={() => setTestOpen(!testOpen)}
            className="flex w-full items-center gap-2 text-sm font-medium"
          >
            <FlaskConical size={14} className="text-[var(--fp-accent-2)]" />
            {t.builder.config.testStep}
            <ChevronDown size={14} className={`ms-auto ${testOpen ? "rotate-180" : ""}`} />
          </button>
          {testOpen && (
            <div className="mt-2">
              <p className="mb-1 text-[11px] text-[var(--fp-text-2)]">{t.builder.config.testStepHint}</p>
              <textarea
                value={testEvent}
                onChange={(e) => setTestEvent(e.target.value)}
                rows={5}
                spellCheck={false}
                className={`${fieldInputClass()} font-mono text-xs`}
              />
              <button
                onClick={runTestStep}
                disabled={testBusy}
                className="mt-2 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10 disabled:opacity-50"
              >
                {testBusy ? "…" : t.builder.config.runTestStep}
              </button>
              {testVerdict && (
                <p
                  className={`mt-2 rounded-lg p-2 text-xs ${
                    testVerdict.error
                      ? "bg-red-500/10 text-red-300"
                      : testVerdict.matched
                        ? "bg-emerald-500/10 text-emerald-300"
                        : "bg-white/5 text-[var(--fp-text-2)]"
                  }`}
                >
                  {testVerdict.error ??
                    (testVerdict.matched ? t.builder.config.testStepMatched : t.builder.config.testStepNotMatched)}
                  {testVerdict.note ? ` — ${testVerdict.note}` : ""}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {def.requiredPermissions.length > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-2.5">
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-amber-300" />
          <p className="text-xs text-amber-200/90">
            {t.builder.config.permissions}:{" "}
            {def.requiredPermissions.map((p) => PERMISSION_HINTS[p] ?? p).join(", ")}
          </p>
        </div>
      )}

      {schemaError && <p className="mb-3 text-xs text-red-400">{schemaError}</p>}

      <div className="flex gap-2">
        <button
          onClick={apply}
          className="btn-gradient flex-1 rounded-xl px-4 py-2 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)]"
        >
          {t.builder.config.apply}
        </button>
        <button
          onClick={onDelete}
          title={t.builder.nodeMenu.delete}
          aria-label={t.builder.nodeMenu.delete}
          className="rounded-xl bg-red-500/15 px-3 py-2 text-red-300 hover:bg-red-500/25 focus:outline-none focus:ring-2 focus:ring-red-400"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  onFocus,
}: {
  field: FieldDesc;
  value: unknown;
  onChange: (v: unknown) => void;
  onFocus?: (el: HTMLInputElement | HTMLTextAreaElement) => void;
}) {
  const cls = fieldInputClass();
  switch (field.kind) {
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 accent-[var(--fp-accent)]"
          />
          {value === true ? "Enabled" : "Disabled"}
        </label>
      );
    case "number":
      return (
        <input
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          className={cls}
        />
      );
    case "select":
      return (
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={cls}>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "textarea":
      return (
        <textarea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => onFocus?.(e.target)}
          rows={4}
          className={cls}
        />
      );
    case "stringlist":
      return (
        <input
          value={Array.isArray(value) ? (value as string[]).join(", ") : ""}
          onChange={(e) =>
            onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))
          }
          onFocus={(e) => onFocus?.(e.target)}
          placeholder="comma, separated, values"
          className={cls}
        />
      );
    case "json":
      return (
        <textarea
          value={typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2)}
          onChange={(e) => {
            const raw = e.target.value;
            try {
              onChange(JSON.parse(raw));
            } catch {
              onChange(raw); // keep raw; validation will flag it
            }
          }}
          rows={4}
          spellCheck={false}
          placeholder="JSON value"
          className={`${cls} font-mono text-xs`}
        />
      );
    default:
      return (
        <input
          value={typeof value === "string" ? value : value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => onFocus?.(e.target)}
          className={cls}
        />
      );
  }
}

export function EdgeConfigPanel({
  edge,
  onApply,
  onDelete,
  onClose,
}: {
  edge: Edge;
  onApply: (label: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useBuilderLocale();
  const [label, setLabel] = useState(typeof edge.label === "string" ? edge.label : "");
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">{t.builder.edge.title}</h3>
        <button
          onClick={onClose}
          aria-label="Close panel"
          className="rounded-lg px-2 py-1 text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
        >
          ✕
        </button>
      </div>
      <p className="mb-3 text-xs text-[var(--fp-text-2)]">{t.builder.edge.hint}</p>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium text-[var(--fp-text-2)]">
          {t.builder.edge.label}
        </span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder='e.g. "true" / "false"'
          className={fieldInputClass()}
        />
      </label>
      <div className="flex gap-2">
        <button
          onClick={() => onApply(label.trim())}
          className="btn-gradient flex-1 rounded-xl px-4 py-2 text-sm font-semibold text-white"
        >
          {t.builder.edge.apply}
        </button>
        <button
          onClick={onDelete}
          title={t.builder.nodeMenu.delete}
          aria-label={t.builder.nodeMenu.delete}
          className="rounded-xl bg-red-500/15 px-3 py-2 text-red-300 hover:bg-red-500/25"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
