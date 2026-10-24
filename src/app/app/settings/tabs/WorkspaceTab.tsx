"use client";

/**
 * Phase 4 — Settings · Workspace tab.
 * Name + brand color (PATCH /api/workspaces/[id]), team members + invites +
 * role assignment (Team APIs), audit history (GET /api/audit).
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, useWorkspaces } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { PageSpinner } from "@/components/ui/Spinner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { automationDefaults } from "@/lib/workspace-settings";
import { roleAtLeast, Toggle, Row, Msg, type SettingsDict } from "../ui";

interface Member {
  id: string;
  role: string;
  user: { id: string; name: string; email: string };
}

interface AuditEvent {
  id: string;
  action: string;
  entity: Record<string, unknown>;
  actor: { id: string; name: string; email: string } | null;
  createdAt: string;
}

const ROLES = ["OWNER", "ADMIN", "MANAGER", "AGENT", "ANALYST"] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AutomationSettings {
  maxRetries: number;
  backoffBaseMs: number;
  rateLimitPerMinute: number;
  dedupeEnabled: boolean;
}

/** Automation execution defaults card (moved from the old Automation tab). */
function AutomationDefaultsCard({ t }: { t: SettingsDict }) {
  const a = t.automation;
  const w = t.workspace;
  const { current } = useWorkspaces();
  const canEdit = roleAtLeast(current?.role, "MANAGER");

  const [s, setS] = useState<AutomationSettings>({ ...automationDefaults });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await api<{ settings: { automation: AutomationSettings } }>("/api/workspace/settings");
      setS({ ...automationDefaults, ...raw.settings.automation });
    } catch {
      /* keep defaults */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const raw = await api<{ settings: { automation: AutomationSettings } }>("/api/workspace/settings", {
        method: "PUT",
        body: { automation: s },
      });
      setS(raw.settings.automation);
      setMsg(a.saved);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : t.common.retry);
    } finally {
      setSaving(false);
    }
  };

  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : fallback;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{w.automationTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-[var(--fp-text-2)]">{a.hint}</p>
        <p className="rounded-lg border border-dashed border-[var(--fp-border)] bg-[var(--fp-bg)] p-3 text-xs text-[var(--fp-text-2)]">
          {w.automationNote}
        </p>
        {loading ? (
          <Spinner label={t.common.loading} className="py-8" />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                label={a.maxRetries}
                type="number"
                min={0}
                max={10}
                value={String(s.maxRetries)}
                onChange={(e) => setS({ ...s, maxRetries: Math.min(10, Math.max(0, num(e.target.value, s.maxRetries))) })}
                disabled={!canEdit}
              />
              <Input
                label={a.backoff}
                type="number"
                min={1000}
                max={300000}
                step={1000}
                value={String(s.backoffBaseMs)}
                onChange={(e) => setS({ ...s, backoffBaseMs: Math.min(300000, Math.max(1000, num(e.target.value, s.backoffBaseMs))) })}
                disabled={!canEdit}
              />
              <Input
                label={a.rateLimit}
                type="number"
                min={1}
                max={10000}
                value={String(s.rateLimitPerMinute)}
                onChange={(e) => setS({ ...s, rateLimitPerMinute: Math.min(10000, Math.max(1, num(e.target.value, s.rateLimitPerMinute))) })}
                disabled={!canEdit}
              />
            </div>
            <p className="text-xs text-[var(--fp-text-2)]">{a.maxRetriesHint}</p>
            <p className="text-xs text-[var(--fp-text-2)]">{a.backoffHint}</p>
            <p className="text-xs text-[var(--fp-text-2)]">{a.rateLimitHint}</p>
            <Row label={a.dedupe} hint={a.dedupeHint}>
              <Toggle checked={s.dedupeEnabled} onChange={(v) => setS({ ...s, dedupeEnabled: v })} label={a.dedupe} disabled={!canEdit} />
            </Row>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => void save()} loading={saving} disabled={!canEdit}>
                {a.save}
              </Button>
              <Msg text={msg} tone="info" />
              {!canEdit && <span className="text-xs text-[var(--fp-text-2)]">{a.restricted}</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function WorkspaceTab({ t }: { t: SettingsDict }) {
  const w = t.workspace;
  const { current } = useWorkspaces();
  const role = current?.role;
  const canManage = roleAtLeast(role, "ADMIN");
  const canEdit = roleAtLeast(role, "MANAGER");

  const [wsName, setWsName] = useState("");
  const [brandColor, setBrandColor] = useState("#8B5CF6");
  const [wsSaving, setWsSaving] = useState(false);
  const [wsMsg, setWsMsg] = useState<string | null>(null);

  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("AGENT");
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);

  useEffect(() => {
    if (current) {
      setWsName(current.name);
    }
  }, [current]);

  const fetchMembers = useCallback(async () => {
    setMembersLoading(true);
    try {
      const raw = await api<{ members: Member[] }>("/api/team");
      setMembers(raw.members ?? []);
    } catch {
      setMembers([]);
    } finally {
      setMembersLoading(false);
    }
  }, []);

  const fetchAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const raw = await api<{ events: AuditEvent[] }>("/api/audit?limit=25");
      setAudit(raw.events ?? []);
    } catch {
      setAudit([]);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMembers();
    void fetchAudit();
  }, [fetchMembers, fetchAudit]);

  const saveWorkspace = async () => {
    if (!current) return;
    setWsSaving(true);
    setWsMsg(null);
    try {
      await api(`/api/workspaces/${current.id}`, {
        method: "PATCH",
        body: { name: wsName.trim(), brandColor },
      });
      setWsMsg(w.saved);
    } catch (e) {
      setWsMsg(e instanceof ApiError ? e.message : t.common.retry);
    } finally {
      setWsSaving(false);
    }
  };

  const invite = async () => {
    const trimmed = inviteEmail.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setInviteMsg(w.inviteEmailInvalid);
      return;
    }
    setInviting(true);
    setInviteMsg(null);
    try {
      const raw = await api<{ member: Member }>("/api/team", {
        method: "POST",
        body: { email: trimmed, role: inviteRole },
      });
      setMembers((m) => [...m, raw.member]);
      setInviteEmail("");
      setInviteMsg(w.inviteSent);
    } catch (e) {
      setInviteMsg(e instanceof ApiError ? e.message : t.common.retry);
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (id: string, newRole: string) => {
    try {
      await api(`/api/team/${id}`, { method: "PATCH", body: { role: newRole } });
      setMembers((ms) => ms.map((m) => (m.id === id ? { ...m, role: newRole } : m)));
      setInviteMsg(w.roleUpdated);
    } catch (e) {
      setInviteMsg(e instanceof ApiError ? e.message : t.common.retry);
    }
  };

  const removeMember = async (id: string) => {
    try {
      await api(`/api/team/${id}`, { method: "DELETE" });
      setMembers((ms) => ms.filter((m) => m.id !== id));
      setInviteMsg(w.removed);
    } catch (e) {
      setInviteMsg(e instanceof ApiError ? e.message : t.common.retry);
    }
  };

  if (!current) return <PageSpinner />;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{w.general}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input label={w.name} value={wsName} onChange={(e) => setWsName(e.target.value)} disabled={!canEdit} />
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--fp-text)]">{w.brandColor}</label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                disabled={!canEdit}
                className="h-10 w-14 cursor-pointer rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-1 disabled:opacity-40"
                aria-label={w.brandColor}
              />
              <span className="font-mono text-sm text-[var(--fp-text-2)]">{brandColor}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => void saveWorkspace()} loading={wsSaving} disabled={!canEdit}>
              {w.save}
            </Button>
            <Msg text={wsMsg} tone="info" />
            {!canEdit && <span className="text-xs text-[var(--fp-text-2)]">{t.common.noAccess}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{w.members}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {membersLoading ? (
            <Spinner label={t.common.loading} className="py-4" />
          ) : (
            <ul className="space-y-2">
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-4 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--fp-text)]">{m.user.name}</p>
                    <p className="truncate text-xs text-[var(--fp-text-2)]">{m.user.email}</p>
                  </div>
                  {canManage ? (
                    <select
                      value={m.role}
                      onChange={(e) => void changeRole(m.id, e.target.value)}
                      className="rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg)] px-2 py-1.5 text-xs text-[var(--fp-text)]"
                      aria-label={w.inviteRole}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Badge tone="gray">{m.role}</Badge>
                  )}
                  {canManage && (
                    <Button size="sm" variant="danger" onClick={() => void removeMember(m.id)}>
                      {w.remove}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canManage ? (
            <div className="rounded-xl border border-dashed border-[var(--fp-border)] p-4">
              <p className="mb-2 text-sm font-medium text-[var(--fp-text)]">{w.invite}</p>
              <p className="mb-3 text-xs text-[var(--fp-text-2)]">{w.inviteHint}</p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Input label={w.inviteEmail} type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@example.com" />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[var(--fp-text)]">{w.inviteRole}</label>
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    className="rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-3 py-2 text-sm text-[var(--fp-text)]"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                <Button size="sm" onClick={() => void invite()} loading={inviting} disabled={!inviteEmail.trim()}>
                  {w.invite}
                </Button>
              </div>
              <div className="mt-2">
                <Msg text={inviteMsg} tone="info" />
              </div>
            </div>
          ) : (
            <p className="text-xs text-[var(--fp-text-2)]">{t.common.noAccess}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{w.audit}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-[var(--fp-text-2)]">{w.auditHint}</p>
          {auditLoading ? (
            <Spinner label={t.common.loading} className="py-4" />
          ) : audit.length === 0 ? (
            <p className="text-sm text-[var(--fp-text-2)]">{w.noAudit}</p>
          ) : (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto">
              {audit.map((e) => (
                <li key={e.id} className="flex items-baseline gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--fp-bg-2)]">
                  <span className="shrink-0 font-mono text-xs text-[var(--fp-text-2)]">{fmtDate(e.createdAt)}</span>
                  <span className="font-medium text-[var(--fp-text)]">{e.action}</span>
                  <span className="truncate text-xs text-[var(--fp-text-2)]">
                    {e.actor ? `${e.actor.name} <${e.actor.email}>` : "system"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AutomationDefaultsCard t={t} />
    </div>
  );
}
