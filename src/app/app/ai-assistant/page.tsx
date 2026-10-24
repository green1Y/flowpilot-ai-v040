"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import {
  Settings2,
  BookOpen,
  FlaskConical,
  Activity,
  Plus,
  Trash2,
  Send,
  Bot,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
} from "lucide-react";

/* ------------------------------------------------------------------ */

interface AiConfig {
  assistantName: string;
  businessName: string;
  businessDescription: string;
  brandVoice: string;
  tone: string;
  responseLength: string;
  languages: string[];
  confidenceThreshold: number;
  requireApproval: boolean;
  fallbackResponse: string;
  prohibitedTopics: string[];
  escalationRules: Record<string, unknown>;
}

interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  chunkCount?: number;
}

interface Escalation {
  id: string;
  conversationId: string | null;
  contact: { id: string; name: string } | null;
  reason: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

interface TestResult {
  reply: string;
  mocked: boolean;
  confidence: number;
  sources?: string[];
}

interface NotificationItem {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  action?: string;
}

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
  { value: "nl", label: "Dutch" },
  { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" },
];

const defaultConfig: AiConfig = {
  assistantName: "FlowPilot Assistant",
  businessName: "",
  businessDescription: "",
  brandVoice: "friendly",
  tone: "professional",
  responseLength: "concise",
  languages: ["en"],
  confidenceThreshold: 0.7,
  requireApproval: true,
  fallbackResponse: "Thanks for reaching out! A team member will get back to you shortly.",
  prohibitedTopics: [],
  escalationRules: {},
};

function parseRules(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const p = JSON.parse(String(raw)) as unknown;
    return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]" : "bg-[var(--fp-bg-2)] border border-[var(--fp-border)]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
          checked ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */

export default function AiAssistantPage() {
  const [tab, setTab] = useState("configure");
  const [config, setConfig] = useState<AiConfig>(defaultConfig);
  const [rulesText, setRulesText] = useState("{}");
  const [topicsText, setTopicsText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [docOpen, setDocOpen] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");
  const [docSaving, setDocSaving] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [docDelete, setDocDelete] = useState<KnowledgeDoc | null>(null);

  const [question, setQuestion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const [activity, setActivity] = useState<NotificationItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<string | null>(null);

  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [escLoading, setEscLoading] = useState(false);
  const [escFilter, setEscFilter] = useState<"OPEN" | "RESOLVED" | "ALL">("OPEN");
  const [escError, setEscError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  /* ------------------------------- load ------------------------------- */
  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ config: Partial<AiConfig>; knowledgeDocs: KnowledgeDoc[] }>(
        "/api/ai-config",
      );
      const c = { ...defaultConfig, ...(data.config ?? {}) };
      setConfig({
        ...c,
        languages: Array.isArray(c.languages) ? c.languages : ["en"],
        prohibitedTopics: Array.isArray(c.prohibitedTopics) ? c.prohibitedTopics : [],
        escalationRules: parseRules(c.escalationRules),
      });
      setRulesText(JSON.stringify(parseRules(c.escalationRules), null, 2));
      setTopicsText((Array.isArray(c.prohibitedTopics) ? c.prohibitedTopics : []).join(", "));
      setDocs(data.knowledgeDocs ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load AI configuration");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  const fetchActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const data = await api<{ items: NotificationItem[] }>("/api/notifications");
      const items = data.items ?? [];
      setActivity(
        items.filter(
          (n) =>
            (n.action && n.action.startsWith("ai.")) ||
            /(\bai\b|assistant|workflow|automation|approval)/i.test(
              `${n.title} ${n.body}`,
            ),
        ),
      );
    } catch {
      setActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "activity") void fetchActivity();
  }, [tab, fetchActivity]);

  /* ----------------------------- escalations --------------------------- */
  const fetchEscalations = useCallback(async (filter: "OPEN" | "RESOLVED" | "ALL") => {
    setEscLoading(true);
    setEscError(null);
    try {
      const data = await api<{ escalations: Escalation[] }>(
        `/api/ai-config/escalations?status=${filter}`,
      );
      setEscalations(data.escalations ?? []);
    } catch (e) {
      setEscError(e instanceof ApiError ? e.message : "Failed to load escalations");
    } finally {
      setEscLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "escalations") void fetchEscalations(escFilter);
  }, [tab, escFilter, fetchEscalations]);

  const resolveEscalation = async (id: string) => {
    setResolvingId(id);
    try {
      await api(`/api/ai-config/escalations/${id}/resolve`, { method: "POST" });
      setEscalations((prev) =>
        escFilter === "OPEN" ? prev.filter((e) => e.id !== id) : prev.map((e) => (e.id === id ? { ...e, status: "RESOLVED", resolvedAt: new Date().toISOString() } : e)),
      );
    } catch (e) {
      setEscError(e instanceof ApiError ? e.message : "Failed to resolve escalation");
    } finally {
      setResolvingId(null);
    }
  };

  /* ------------------------------ reindex ------------------------------ */
  const reindexDocs = async () => {
    setReindexing(true);
    setReindexMsg(null);
    try {
      const res = await api<{ docs: Array<{ id: string; title: string; chunkCount: number }> }>(
        "/api/ai-config/knowledge/reindex",
        { method: "POST" },
      );
      const counts = new Map(res.docs.map((d) => [d.id, d.chunkCount]));
      setDocs((prev) => prev.map((d) => ({ ...d, chunkCount: counts.get(d.id) ?? d.chunkCount })));
      const total = res.docs.reduce((n, d) => n + d.chunkCount, 0);
      setReindexMsg(`Reindexed ${res.docs.length} doc(s) → ${total} chunks.`);
    } catch (e) {
      setReindexMsg(e instanceof ApiError ? `Reindex failed: ${e.message}` : "Reindex failed");
    } finally {
      setReindexing(false);
    }
  };

  /* -------------------------------- save ------------------------------- */
  const saveConfig = async () => {
    setError(null);
    setSavedMsg(null);
    let rules: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rulesText || "{}") as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Escalation rules must be a JSON object");
      }
      rules = parsed as Record<string, unknown>;
    } catch (e) {
      setError(e instanceof Error ? `Invalid escalation rules JSON: ${e.message}` : "Invalid JSON");
      return;
    }
    setSaving(true);
    try {
      await api("/api/ai-config", {
        method: "PUT",
        body: {
          ...config,
          prohibitedTopics: topicsText.split(",").map((t) => t.trim()).filter(Boolean),
          escalationRules: rules,
        },
      });
      setConfig((c) => ({
        ...c,
        prohibitedTopics: topicsText.split(",").map((t) => t.trim()).filter(Boolean),
        escalationRules: rules,
      }));
      setSavedMsg("AI configuration saved.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };

  /* ------------------------------ knowledge ---------------------------- */
  const addDoc = async () => {
    setDocError(null);
    if (!docTitle.trim() || !docContent.trim()) {
      setDocError("Title and content are required.");
      return;
    }
    setDocSaving(true);
    try {
      const created = await api<KnowledgeDoc>("/api/ai-config/knowledge", {
        method: "POST",
        body: { title: docTitle.trim(), content: docContent.trim() },
      });
      setDocs((prev) => [created, ...prev]);
      setDocOpen(false);
      setDocTitle("");
      setDocContent("");
    } catch (e) {
      setDocError(e instanceof ApiError ? e.message : "Failed to add document");
    } finally {
      setDocSaving(false);
    }
  };

  const deleteDoc = async () => {
    if (!docDelete) return;
    try {
      await api(`/api/ai-config/knowledge/${docDelete.id}`, { method: "DELETE" });
      setDocs((prev) => prev.filter((d) => d.id !== docDelete.id));
      setDocDelete(null);
    } catch (e) {
      setDocError(e instanceof ApiError ? e.message : "Failed to delete document");
      setDocDelete(null);
    }
  };

  /* ------------------------------ playground --------------------------- */
  const runTest = async () => {
    if (!question.trim() || testing) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const res = await api<TestResult>("/api/ai-config/test", {
        method: "POST",
        body: { question: question.trim() },
      });
      setTestResult(res);
    } catch (e) {
      setTestError(e instanceof ApiError ? e.message : "Test failed");
    } finally {
      setTesting(false);
    }
  };

  const toggleLang = (v: string) =>
    setConfig((c) => ({
      ...c,
      languages: c.languages.includes(v)
        ? c.languages.filter((l) => l !== v)
        : [...c.languages, v],
    }));

  if (loading) return <Spinner label="Loading AI configuration…" />;

  return (
    <div>
      <PageHeader
        title="AI Assistant"
        description="Configure how your AI talks, what it knows, and test it before it goes live."
      />

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "configure", label: "Configure", icon: Settings2 },
          { id: "knowledge", label: "Knowledge", icon: BookOpen },
          { id: "playground", label: "Playground", icon: FlaskConical },
          { id: "escalations", label: "Escalations", icon: AlertTriangle },
          { id: "activity", label: "Activity", icon: Activity },
        ]}
      />

      {error && (
        <p className="mb-4 rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-4 py-2 text-sm text-[#FB7185]">
          {error}
        </p>
      )}

      {/* ------------------------------- Configure ------------------------------- */}
      {tab === "configure" && (
        <Card>
          <CardHeader>
            <CardTitle>Assistant behavior</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Assistant name" value={config.assistantName} onChange={(e) => setConfig({ ...config, assistantName: e.target.value })} />
              <Input label="Business name" value={config.businessName} onChange={(e) => setConfig({ ...config, businessName: e.target.value })} />
            </div>
            <Textarea label="Business description" value={config.businessDescription} onChange={(e) => setConfig({ ...config, businessDescription: e.target.value })} rows={3} hint="What you sell, who you serve, and what makes you different." />
            <div className="grid gap-4 sm:grid-cols-3">
              <Select label="Brand voice" value={config.brandVoice} onChange={(e) => setConfig({ ...config, brandVoice: e.target.value })} options={["friendly", "playful", "formal", "bold", "empathetic"].map((v) => ({ value: v, label: v }))} />
              <Select label="Tone" value={config.tone} onChange={(e) => setConfig({ ...config, tone: e.target.value })} options={["professional", "casual", "warm", "concise"].map((v) => ({ value: v, label: v }))} />
              <Select label="Response length" value={config.responseLength} onChange={(e) => setConfig({ ...config, responseLength: e.target.value })} options={["concise", "balanced", "detailed"].map((v) => ({ value: v, label: v }))} />
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-[var(--fp-text)]">Languages</p>
              <div className="flex flex-wrap gap-2">
                {LANGUAGES.map((l) => {
                  const on = config.languages.includes(l.value);
                  return (
                    <button
                      key={l.value}
                      type="button"
                      onClick={() => toggleLang(l.value)}
                      aria-pressed={on}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                        on
                          ? "border-[#8B5CF6] bg-[#8B5CF6]/15 text-[#A78BFA]"
                          : "border-[var(--fp-border)] text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
                      }`}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--fp-text)]">
                  Confidence threshold: <span className="text-gradient font-bold">{Math.round(config.confidenceThreshold * 100)}%</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(config.confidenceThreshold * 100)}
                  onChange={(e) => setConfig({ ...config, confidenceThreshold: Number(e.target.value) / 100 })}
                  className="w-full accent-[#8B5CF6]"
                  aria-label="Confidence threshold"
                />
                <p className="mt-1 text-xs text-[var(--fp-text-2)]">Below this confidence the assistant uses the fallback response or escalates.</p>
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-4 py-3">
                <Toggle checked={config.requireApproval} onChange={(v) => setConfig({ ...config, requireApproval: v })} label="Require approval" />
                <div>
                  <p className="text-sm font-medium text-[var(--fp-text)]">Require approval</p>
                  <p className="text-xs text-[var(--fp-text-2)]">Hold AI replies for human review before sending.</p>
                </div>
              </div>
            </div>

            <Textarea label="Fallback response" value={config.fallbackResponse} onChange={(e) => setConfig({ ...config, fallbackResponse: e.target.value })} rows={2} hint="Used when the assistant is unsure or a topic is prohibited." />
            <Input label="Prohibited topics" value={topicsText} onChange={(e) => setTopicsText(e.target.value)} placeholder="refunds, legal advice (comma separated)" hint="The assistant will refuse or escalate these topics." />
            <Textarea label="Escalation rules (JSON)" value={rulesText} onChange={(e) => setRulesText(e.target.value)} rows={5} hint='e.g. {"angry_customer": "assign to human", "vip": "notify owner"}' />

            <div className="flex items-center gap-3">
              <Button onClick={() => void saveConfig()} loading={saving}>Save configuration</Button>
              {savedMsg && <span className="text-sm text-[#34D399]">{savedMsg}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ------------------------------- Knowledge ------------------------------- */}
      {tab === "knowledge" && (
        <div>
          <div className="mb-4 flex items-center justify-end gap-2">
            {reindexMsg && <span className="mr-auto text-xs text-[var(--fp-text-2)]">{reindexMsg}</span>}
            <Button size="sm" variant="ghost" onClick={() => void reindexDocs()} loading={reindexing} title="Rebuild the chunk index for all documents">
              <RefreshCw className="h-4 w-4" /> Reindex
            </Button>
            <Button size="sm" onClick={() => setDocOpen(true)}>
              <Plus className="h-4 w-4" /> Add document
            </Button>
          </div>
          {docs.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No knowledge documents"
              description="Add FAQs, policies and product info so the assistant answers from your content."
              action={<Button size="sm" onClick={() => setDocOpen(true)}><Plus className="h-4 w-4" /> Add document</Button>}
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {docs.map((d) => (
                <Card key={d.id}>
                  <CardHeader>
                    <CardTitle>{d.title}</CardTitle>
                    <Button variant="danger" size="sm" onClick={() => setDocDelete(d)} aria-label={`Delete ${d.title}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <p className="line-clamp-4 whitespace-pre-wrap text-sm text-[var(--fp-text-2)]">{d.content}</p>
                    <div className="mt-2 flex items-center gap-2 text-xs text-[var(--fp-text-2)]">
                      <Badge tone={d.chunkCount ? "green" : "amber"}>
                        {d.chunkCount ?? 0} {(d.chunkCount ?? 0) === 1 ? "chunk" : "chunks"} indexed
                      </Badge>
                      <span>Added {new Date(d.createdAt).toLocaleDateString()}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <Modal open={docOpen} onClose={() => { setDocOpen(false); setDocError(null); }} title="Add knowledge document">
            <div className="space-y-3">
              <Input label="Title" value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder="Shipping policy" />
              <Textarea label="Content" value={docContent} onChange={(e) => setDocContent(e.target.value)} rows={8} placeholder="Paste the facts the assistant should use…" />
              {docError && <p className="text-sm text-[#FB7185]">{docError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDocOpen(false)}>Cancel</Button>
                <Button onClick={() => void addDoc()} loading={docSaving}>Add document</Button>
              </div>
            </div>
          </Modal>

          <Modal open={!!docDelete} onClose={() => setDocDelete(null)} title="Delete document">
            <p className="text-sm text-[var(--fp-text-2)]">
              Delete <span className="font-semibold text-[var(--fp-text)]">“{docDelete?.title}”</span>? The assistant will no longer use it.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDocDelete(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => void deleteDoc()}>Delete</Button>
            </div>
          </Modal>
        </div>
      )}

      {/* ------------------------------- Playground ------------------------------ */}
      {tab === "playground" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Ask your assistant</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={4}
                placeholder="e.g. What are your opening hours?"
                aria-label="Test question"
              />
              <Button onClick={() => void runTest()} loading={testing} disabled={!question.trim()}>
                <Send className="h-4 w-4" /> Test reply
              </Button>
              {testError && <p className="text-sm text-[#FB7185]">{testError}</p>}
              <p className="text-xs text-[var(--fp-text-2)]">
                Playground calls the same test endpoint used for drafting — responses here are never sent to contacts.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Response</CardTitle>
              {testResult?.mocked && <Badge tone="amber">mock</Badge>}
            </CardHeader>
            <CardContent>
              {!testResult ? (
                <EmptyState icon={FlaskConical} title="No test yet" description="Ask a question to preview how the assistant responds." />
              ) : (
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#8B5CF6] to-[#22D3EE]">
                      <Bot className="h-4 w-4 text-white" />
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-[var(--fp-text)]">{testResult.reply}</p>
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-xs text-[var(--fp-text-2)]">
                      <span>Confidence</span>
                      <span>{Math.round((testResult.confidence ?? 0) * 100)}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-[var(--fp-bg-2)]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]"
                        style={{ width: `${Math.round((testResult.confidence ?? 0) * 100)}%` }}
                      />
                    </div>
                  </div>
                  {testResult.sources && testResult.sources.length > 0 ? (
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">Sources</p>
                      <ul className="list-disc pl-5 text-xs text-[var(--fp-text-2)]">
                        {testResult.sources.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-xs italic text-[var(--fp-text-2)]">
                      No knowledge sources grounded this answer — add documents so the assistant answers from your content.
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ------------------------------ Escalations ----------------------------- */}
      {tab === "escalations" && (
        <div>
          <div className="mb-4 flex items-center gap-2">
            {(["OPEN", "RESOLVED", "ALL"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setEscFilter(f)}
                aria-pressed={escFilter === f}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  escFilter === f
                    ? "border-[#8B5CF6] bg-[#8B5CF6]/15 text-[#A78BFA]"
                    : "border-[var(--fp-border)] text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
                }`}
              >
                {f === "OPEN" ? "Open" : f === "RESOLVED" ? "Resolved" : "All"}
              </button>
            ))}
            <p className="ml-auto text-xs text-[var(--fp-text-2)]">
              Replies held for review: low confidence or approval required.
            </p>
          </div>
          {escError && (
            <p className="mb-4 rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-4 py-2 text-sm text-[#FB7185]">
              {escError}
            </p>
          )}
          {escLoading ? (
            <Spinner label="Loading escalations…" />
          ) : escalations.length === 0 ? (
            <EmptyState
              icon={AlertTriangle}
              title={escFilter === "OPEN" ? "No open escalations" : "No escalations"}
              description="When the AI holds a reply for review — low confidence or approval required — it appears here."
            />
          ) : (
            <div className="space-y-3">
              {escalations.map((e) => (
                <Card key={e.id}>
                  <CardContent className="flex items-start gap-3 pt-5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FBBF24]/15">
                      <AlertTriangle className="h-4 w-4 text-[#FCD34D]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-[var(--fp-text)]">{e.reason}</p>
                        <Badge tone={e.status === "OPEN" ? "amber" : "green"}>{e.status}</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--fp-text-2)]">
                        {e.contact && <span>Contact: {e.contact.name}</span>}
                        {e.conversationId && (
                          <a href="/app/inbox" className="text-[#A78BFA] hover:underline">
                            View in inbox ↗
                          </a>
                        )}
                        <span>{new Date(e.createdAt).toLocaleString()}</span>
                        {e.resolvedAt && <span>Resolved {new Date(e.resolvedAt).toLocaleString()}</span>}
                      </div>
                    </div>
                    {e.status === "OPEN" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void resolveEscalation(e.id)}
                        loading={resolvingId === e.id}
                      >
                        <CheckCircle2 className="h-4 w-4" /> Resolve
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* -------------------------------- Activity ------------------------------- */}
      {tab === "activity" && (
        <div>
          <div className="mb-4 rounded-xl border border-[#8B5CF6]/30 bg-[#8B5CF6]/10 px-4 py-3 text-sm text-[var(--fp-text-2)]">
            AI activity from workflow executions appears here — auto-replies, approvals and escalations.
          </div>
          {activityLoading ? (
            <Spinner label="Loading activity…" />
          ) : activity.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No AI activity yet"
              description="When your assistant starts handling conversations, its actions will show up here."
            />
          ) : (
            <div className="space-y-3">
              {activity.map((n) => (
                <Card key={n.id}>
                  <CardContent className="flex items-start gap-3 pt-5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#8B5CF6]/15">
                      <Bot className="h-4 w-4 text-[#A78BFA]" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--fp-text)]">{n.title}</p>
                      <p className="mt-0.5 text-sm text-[var(--fp-text-2)]">{n.body}</p>
                      <p className="mt-1 text-xs text-[var(--fp-text-2)]">
                        {new Date(n.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
