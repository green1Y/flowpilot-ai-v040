"use client";

/**
 * Comment-to-DM module page (Wave 2C).
 *
 * Dedicated module UI — the Sidebar is NOT edited here (the coordinator
 * wires navigation). Everything comes from the Wave 2C API routes:
 * accounts + media from /api/comment-dm/media, rules from
 * /api/comment-dm/rules, history from /api/comment-dm/rules/[id]/events,
 * per-rule analytics from /api/comment-dm/analytics.
 *
 * Eligibility explainer and dry-run badges are part of the page copy:
 * Meta allows ONE private reply per comment, only within 7 days of the
 * comment (error 551 after expiry). Dry-run rules never send.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";

interface Account {
  id: string;
  status: string;
  accountName: string | null;
  externalAccountId: string | null;
  isDefault: boolean;
}

interface MediaItem {
  id: string;
  caption?: string;
  media_type?: string;
  permalink?: string;
  timestamp?: string;
  thumbnail_url?: string;
}

interface Rule {
  id: string;
  integrationId: string;
  name: string;
  mediaId: string;
  mediaPermalink: string | null;
  keywords: string[];
  matchMode: string;
  caseSensitive: boolean;
  commentReply: string | null;
  dmTemplate: string | null;
  timezone: string;
  enabled: boolean;
  dryRun: boolean;
}

interface RuleEvent {
  id: string;
  commentId: string;
  matched: boolean;
  keyword: string | null;
  actions: { type: string; status: string; detail?: string }[];
  status: string;
  error: string | null;
  createdAt: string;
}

interface RuleAnalytics {
  ruleId: string;
  ruleName: string | null;
  mediaId: string | null;
  comments: number;
  matches: number;
  sent: number;
  failed: number;
  dryRuns: number;
  skipped: number;
  duplicatesPrevented: number;
  replyRate: number | null;
}

const emptyForm = {
  name: "",
  mediaId: "",
  keywords: "",
  matchMode: "contains",
  caseSensitive: false,
  commentReply: "",
  dmTemplate: "",
  dryRun: true,
  enabled: true,
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Request failed";
}

function statusTone(status: string): "green" | "red" | "amber" | "gray" | "violet" {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  if (status === "DRY_RUN") return "violet";
  if (status === "SKIPPED") return "amber";
  return "gray";
}

export default function CommentToDmPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mediaBlocked, setMediaBlocked] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [analytics, setAnalytics] = useState<RuleAnalytics[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [events, setEvents] = useState<RuleEvent[]>([]);
  const [form, setForm] = useState({ ...emptyForm });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRules = useCallback(async (acct: string) => {
    const res = await api<{ items: Rule[] }>("/api/comment-dm/rules", {
      params: acct ? { integrationId: acct } : {},
    });
    setRules(res.items);
  }, []);

  const loadAnalytics = useCallback(async () => {
    try {
      const res = await api<{ rules: RuleAnalytics[] }>("/api/comment-dm/analytics");
      setAnalytics(res.rules);
    } catch {
      setAnalytics([]);
    }
  }, []);

  const loadMedia = useCallback(async (acct: string) => {
    setMediaBlocked(null);
    if (!acct) {
      setMedia([]);
      return;
    }
    try {
      const res = await api<{ items: MediaItem[] }>("/api/comment-dm/media", {
        params: { integrationId: acct },
      });
      setMedia(res.items);
    } catch (e) {
      // BLOCKED responses carry the prerequisite as the message.
      setMedia([]);
      setMediaBlocked(errMsg(e));
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await api<{ accounts: Account[] }>("/api/comment-dm/media");
        setAccounts(res.accounts);
        const connected = res.accounts.filter((a) => a.status === "CONNECTED");
        const first = connected.find((a) => a.isDefault) ?? connected[0];
        if (first) {
          setAccountId(first.id);
          await Promise.all([loadMedia(first.id), loadRules(first.id)]);
        } else {
          await loadRules("");
        }
        await loadAnalytics();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadMedia, loadRules, loadAnalytics]);

  const onAccountChange = async (id: string) => {
    setAccountId(id);
    setForm((f) => ({ ...f, mediaId: "" }));
    await Promise.all([loadMedia(id), loadRules(id)]);
  };

  const onSelectRule = async (id: string) => {
    setSelectedRuleId(id);
    try {
      const res = await api<{ items: RuleEvent[] }>(`/api/comment-dm/rules/${id}/events`);
      setEvents(res.items);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onEdit = (rule: Rule) => {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      mediaId: rule.mediaId,
      keywords: rule.keywords.join(", "),
      matchMode: rule.matchMode,
      caseSensitive: rule.caseSensitive,
      commentReply: rule.commentReply ?? "",
      dmTemplate: rule.dmTemplate ?? "",
      dryRun: rule.dryRun,
      enabled: rule.enabled,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onSubmit = async () => {
    setError(null);
    setNotice(null);
    const keywords = form.keywords.split(",").map((k) => k.trim()).filter(Boolean);
    if (!accountId) return setError("Select a connected Instagram account first.");
    if (!form.name.trim()) return setError("Rule name is required.");
    if (!form.mediaId) return setError("Select a post or Reel.");
    if (keywords.length === 0) return setError("At least one keyword is required.");
    setSaving(true);
    try {
      const body = {
        integrationId: accountId,
        name: form.name.trim(),
        mediaId: form.mediaId,
        keywords,
        matchMode: form.matchMode,
        caseSensitive: form.caseSensitive,
        commentReply: form.commentReply.trim() || null,
        dmTemplate: form.dmTemplate.trim() || null,
        dryRun: form.dryRun,
        enabled: form.enabled,
      };
      if (editingId) {
        await api(`/api/comment-dm/rules/${editingId}`, { method: "PATCH", body });
        setNotice("Rule updated.");
      } else {
        await api("/api/comment-dm/rules", { method: "POST", body });
        setNotice("Rule created. It runs on new comments from now on — past comments are not reprocessed.");
      }
      setEditingId(null);
      setForm({ ...emptyForm, mediaId: form.mediaId });
      await Promise.all([loadRules(accountId), loadAnalytics()]);
    } catch (e) {
      if (e instanceof ApiError && e.issues) {
        setError(e.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
      } else {
        setError(errMsg(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async (rule: Rule, patch: { enabled?: boolean; dryRun?: boolean }) => {
    try {
      await api(`/api/comment-dm/rules/${rule.id}`, { method: "PATCH", body: patch });
      await Promise.all([loadRules(accountId), loadAnalytics()]);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onDelete = async (rule: Rule) => {
    if (!window.confirm(`Delete rule "${rule.name}"? Its event history is deleted too.`)) return;
    try {
      await api(`/api/comment-dm/rules/${rule.id}`, { method: "DELETE" });
      if (selectedRuleId === rule.id) {
        setSelectedRuleId(null);
        setEvents([]);
      }
      await Promise.all([loadRules(accountId), loadAnalytics()]);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const selectedRule = rules.find((r) => r.id === selectedRuleId) ?? null;
  const selectedAnalytics = analytics.find((a) => a.ruleId === selectedRuleId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Comment to DM"
        description="When someone comments a keyword on your post or Reel, reply publicly and send them a private message — automatically, through Meta's official API."
      />

      <Card>
        <CardContent>
          <p className="text-sm leading-relaxed">
            <strong>How eligibility works:</strong> Meta allows <strong>one private reply per
            comment</strong>, and only within <strong>7 days</strong> of the comment. After the
            window expires, or once a comment already has a private reply, the rule records a
            SKIPPED event and sends nothing. A redelivered comment can never double-send: each
            comment is processed once per rule. Meta does <em>not</em> permit unrestricted DMs,
            repeated replies to the same comment, or replies after expiry — this module enforces
            all three limits.
          </p>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800" role="status">
          {notice}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Account &amp; post</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <Select
              label="Instagram account"
              value={accountId}
              onChange={(e) => void onAccountChange(e.target.value)}
              placeholder="Select an account"
              options={accounts.map((a) => ({
                value: a.id,
                label: `${a.accountName ?? a.externalAccountId ?? a.id} — ${a.status}${a.isDefault ? " (default)" : ""}`,
              }))}
            />
            <Select
              label="Post / Reel to watch"
              value={form.mediaId}
              onChange={(e) => setForm((f) => ({ ...f, mediaId: e.target.value }))}
              placeholder={mediaBlocked ? "Unavailable — see note below" : "Select a post or Reel"}
              options={media.map((m) => ({
                value: m.id,
                label: `${m.media_type ?? "POST"} · ${(m.caption ?? "").slice(0, 60) || m.id}`,
              }))}
            />
          </div>
          {mediaBlocked && (
            <p className="mt-3 text-sm text-amber-800">
              Post list unavailable: {mediaBlocked}
            </p>
          )}
          {accountId && !mediaBlocked && media.length === 0 && (
            <p className="mt-3 text-sm text-gray-600">This account has no posts or Reels to list.</p>
          )}
          {accounts.length === 0 && (
            <p className="mt-3 text-sm text-gray-600">
              No Instagram accounts in this workspace yet — connect one from the Integrations page first.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{editingId ? "Edit rule" : "New rule"}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label="Rule name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Link requests"
            />
            <Input
              label="Keywords (comma-separated)"
              value={form.keywords}
              onChange={(e) => setForm((f) => ({ ...f, keywords: e.target.value }))}
              placeholder="link, price, details"
              hint="At least one keyword is required."
            />
            <Select
              label="Match mode"
              value={form.matchMode}
              onChange={(e) => setForm((f) => ({ ...f, matchMode: e.target.value }))}
              options={[
                { value: "contains", label: "Contains — keyword appears anywhere (default)" },
                { value: "exact", label: "Exact — whole comment equals the keyword" },
                { value: "startsWith", label: "Starts with — comment begins with the keyword" },
              ]}
            />
            <div className="flex items-end gap-4 pb-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.caseSensitive}
                  onChange={(e) => setForm((f) => ({ ...f, caseSensitive: e.target.checked }))}
                />
                Case sensitive
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.dryRun}
                  onChange={(e) => setForm((f) => ({ ...f, dryRun: e.target.checked }))}
                />
                Dry run (record only, never send)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                />
                Enabled
              </label>
            </div>
            <Textarea
              label="Public comment reply (optional)"
              value={form.commentReply}
              onChange={(e) => setForm((f) => ({ ...f, commentReply: e.target.value }))}
              placeholder="Thanks! Check your DMs."
              hint="Posted as a public reply via the official replies endpoint."
            />
            <Textarea
              label="DM template (optional)"
              value={form.dmTemplate}
              onChange={(e) => setForm((f) => ({ ...f, dmTemplate: e.target.value }))}
              placeholder="Hi {{name}}, here is your {{keyword}}!"
              hint="Sent as the one private reply. Only {{name}} (from the contact record) and {{keyword}} are personalized — nothing else is invented."
            />
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => void onSubmit()} disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Create rule"}
            </Button>
            {editingId && (
              <Button variant="secondary" onClick={() => { setEditingId(null); setForm({ ...emptyForm }); }}>
                Cancel edit
              </Button>
            )}
          </div>
          <p className="mt-3 text-xs text-gray-500">
            New rules are created in dry-run mode by default so you can verify matching in the
            event history before any real message is sent. Turn dry run off when ready.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rules</CardTitle>
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <EmptyState
              title="No rules yet"
              description="Create a rule above to start automating comment replies for this account."
            />
          ) : (
            <ul className="divide-y">
              {rules.map((rule) => {
                const a = analytics.find((x) => x.ruleId === rule.id);
                return (
                  <li key={rule.id} className="py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>{rule.name}</strong>
                      {rule.dryRun && <Badge tone="violet">Dry run</Badge>}
                      <Badge tone={rule.enabled ? "green" : "gray"}>
                        {rule.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      <span className="text-sm text-gray-500">
                        {rule.matchMode} · {rule.keywords.join(", ")}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-500">
                      Post: {rule.mediaId}
                      {a && (
                        <>
                          {" · "}Matched {a.comments} · Sent {a.sent} · Failed {a.failed} ·
                          Dry runs {a.dryRuns} · Duplicates prevented {a.duplicatesPrevented}
                          {a.replyRate !== null && <> · Reply rate {a.replyRate.toFixed(1)}%</>}
                        </>
                      )}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={() => void onSelectRule(rule.id)}>
                        History
                      </Button>
                      <Button variant="secondary" onClick={() => onEdit(rule)}>
                        Edit
                      </Button>
                      <Button variant="secondary" onClick={() => void onToggle(rule, { enabled: !rule.enabled })}>
                        {rule.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button variant="secondary" onClick={() => void onToggle(rule, { dryRun: !rule.dryRun })}>
                        {rule.dryRun ? "Turn dry run off" : "Turn dry run on"}
                      </Button>
                      <Button variant="danger" onClick={() => void onDelete(rule)}>
                        Delete
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {selectedRule && (
        <Card>
          <CardHeader>
            <CardTitle>History — {selectedRule.name}</CardTitle>
          </CardHeader>
          <CardContent>
            {selectedAnalytics && (
              <p className="mb-4 text-sm text-gray-600">
                Matched {selectedAnalytics.comments} · Sent {selectedAnalytics.sent} · Failed{" "}
                {selectedAnalytics.failed} · Dry runs {selectedAnalytics.dryRuns} · Skipped{" "}
                {selectedAnalytics.skipped} · Duplicates prevented {selectedAnalytics.duplicatesPrevented}
              </p>
            )}
            {events.length === 0 ? (
              <EmptyState
                title="No events yet"
                description="Matching comments will appear here as they are processed."
              />
            ) : (
              <ul className="divide-y">
                {events.map((ev) => (
                  <li key={ev.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={statusTone(ev.status)}>{ev.status}</Badge>
                      <span className="text-sm">Comment {ev.commentId}</span>
                      {ev.keyword && <span className="text-sm text-gray-500">keyword: {ev.keyword}</span>}
                      <span className="text-sm text-gray-400">
                        {new Date(ev.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {ev.actions.map((act, i) => (
                      <p key={i} className="mt-1 text-sm text-gray-600">
                        {act.type}: {act.status}
                        {act.detail ? ` — ${act.detail}` : ""}
                      </p>
                    ))}
                    {ev.error && <p className="mt-1 text-sm text-red-700">{ev.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
