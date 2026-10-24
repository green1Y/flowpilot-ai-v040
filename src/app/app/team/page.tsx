"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { UserPlus, Users, Trash2 } from "lucide-react";

/* ------------------------------------------------------------------ */

interface Member {
  id: string;
  role: string;
  user: { id: string; name: string; email: string };
}

const ROLES = ["OWNER", "ADMIN", "MANAGER", "AGENT", "ANALYST"];

function roleTone(role: string): "violet" | "cyan" | "blue" | "gray" | "green" {
  switch (role) {
    case "OWNER":
      return "violet";
    case "ADMIN":
      return "cyan";
    case "MANAGER":
      return "blue";
    case "AGENT":
      return "green";
    default:
      return "gray";
  }
}

/* ------------------------------------------------------------------ */

export default function TeamPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("AGENT");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const [roleBusy, setRoleBusy] = useState<Record<string, boolean>>({});
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [removing, setRemoving] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const fetchTeam = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ items: Member[] }>("/api/team");
      setMembers(data.items ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTeam();
  }, [fetchTeam]);

  const invite = async () => {
    setInviteError(null);
    if (!inviteEmail.trim()) {
      setInviteError("Email is required.");
      return;
    }
    setInviting(true);
    try {
      await api("/api/team", {
        method: "POST",
        body: { email: inviteEmail.trim(), role: inviteRole },
      });
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("AGENT");
      setActionMsg("Invitation sent.");
      void fetchTeam();
    } catch (e) {
      setInviteError(
        e instanceof ApiError
          ? e.status === 404
            ? `Invite endpoint not found (404): ${e.message}`
            : e.message
          : "Failed to send invite",
      );
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (m: Member, role: string) => {
    if (role === m.role) return;
    setRoleBusy((b) => ({ ...b, [m.id]: true }));
    setActionMsg(null);
    try {
      await api(`/api/team/${m.id}`, { method: "PATCH", body: { role } });
      setMembers((prev) => prev.map((x) => (x.id === m.id ? { ...x, role } : x)));
      setActionMsg(`${m.user.name}'s role changed to ${role}.`);
    } catch (e) {
      setActionMsg(e instanceof ApiError ? `Role change failed: ${e.message}` : "Role change failed");
    } finally {
      setRoleBusy((b) => ({ ...b, [m.id]: false }));
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api(`/api/team/${removeTarget.id}`, { method: "DELETE" });
      setActionMsg(`${removeTarget.user.name} removed from the workspace.`);
      setRemoveTarget(null);
      void fetchTeam();
    } catch (e) {
      setActionMsg(e instanceof ApiError ? `Remove failed: ${e.message}` : "Remove failed");
      setRemoveTarget(null);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Team"
        description="Who can access this workspace and what they can do."
        actions={
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus className="h-4 w-4" /> Invite member
          </Button>
        }
      />

      {actionMsg && (
        <p className="mb-4 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-4 py-2 text-sm text-[var(--fp-text-2)]">
          {actionMsg}
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-4 py-2 text-sm text-[#FB7185]">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
        {loading ? (
          <Spinner label="Loading team…" />
        ) : members.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No team members"
            description="Invite someone to collaborate on this workspace."
            action={<Button size="sm" onClick={() => setInviteOpen(true)}><UserPlus className="h-4 w-4" /> Invite member</Button>}
          />
        ) : (
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--fp-border)] text-xs uppercase tracking-wide text-[var(--fp-text-2)]">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-[var(--fp-border)] last:border-0 hover:bg-[var(--fp-bg-2)]">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#8B5CF6] to-[#22D3EE] text-xs font-bold text-white">
                        {m.user.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
                      </div>
                      <span className="font-medium text-[var(--fp-text)]">{m.user.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[var(--fp-text-2)]">{m.user.email}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Badge tone={roleTone(m.role)}>{m.role}</Badge>
                      <div className="w-36">
                        <Select
                          value={m.role}
                          onChange={(e) => void changeRole(m, e.target.value)}
                          options={ROLES.map((r) => ({ value: r, label: r }))}
                          disabled={roleBusy[m.id]}
                          aria-label={`Change role for ${m.user.name}`}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant="danger" onClick={() => setRemoveTarget(m)} aria-label={`Remove ${m.user.name}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Invite modal */}
      <Modal open={inviteOpen} onClose={() => { setInviteOpen(false); setInviteError(null); }} title="Invite team member">
        <div className="space-y-3">
          <Input label="Email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@company.com" />
          <Select label="Role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} options={ROLES.map((r) => ({ value: r, label: r }))} />
          <p className="text-xs text-[var(--fp-text-2)]">
            Owners manage billing and can delete the workspace. Admins manage integrations and team. Agents handle conversations.
          </p>
          {inviteError && <p className="text-sm text-[#FB7185]">{inviteError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button onClick={() => void invite()} loading={inviting}><UserPlus className="h-4 w-4" /> Send invite</Button>
          </div>
        </div>
      </Modal>

      {/* Remove confirm */}
      <Modal open={!!removeTarget} onClose={() => setRemoveTarget(null)} title="Remove member">
        <p className="text-sm text-[var(--fp-text-2)]">
          Remove <span className="font-semibold text-[var(--fp-text)]">{removeTarget?.user.name}</span> ({removeTarget?.user.email}) from this workspace?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoveTarget(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirmRemove()} loading={removing}>Remove</Button>
        </div>
      </Modal>
    </div>
  );
}
