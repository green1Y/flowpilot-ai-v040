"use client";

/**
 * Settings · Account section.
 * Profile (PATCH /api/auth/me), password change (PUT /api/auth/password),
 * email verification status (honestly labeled — no verification flow exists
 * yet), and session controls (stateless JWT sessions: only "sign out this
 * device" is possible; sign-out-all is honestly labeled unavailable).
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LogOut, MonitorSmartphone } from "lucide-react";
import { Msg, NotYet, Row, type SettingsDict } from "../ui";

interface MeUser {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean;
  emailVerifiedAt?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AccountTab({ t }: { t: SettingsDict }) {
  const a = t.account;
  const router = useRouter();
  const [me, setMe] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwTone, setPwTone] = useState<"ok" | "err" | "info">("info");

  const [signingOut, setSigningOut] = useState(false);

  // Email verification (POST /api/auth/verify-email[/resend] — 6-digit code).
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [resending, setResending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [codeMsg, setCodeMsg] = useState<string | null>(null);
  const [codeTone, setCodeTone] = useState<"ok" | "err" | "info">("info");

  const resendCode = async () => {
    setResending(true);
    setCodeMsg(null);
    try {
      await api("/api/auth/verify-email/resend", { method: "POST" });
      setCodeSent(true);
      setCodeTone("info");
      setCodeMsg(a.codeSent);
    } catch (e) {
      // 429 cooldown/rate-limit and honest 503 EMAIL_NOT_CONFIGURED surface here.
      setCodeTone("err");
      setCodeMsg(e instanceof ApiError ? e.message : t.common.retry);
    } finally {
      setResending(false);
    }
  };

  const verifyCode = async () => {
    if (!/^\d{6}$/.test(code.trim())) return;
    setVerifying(true);
    setCodeMsg(null);
    try {
      await api<{ verified: boolean }>("/api/auth/verify-email", {
        method: "POST",
        body: { code: code.trim() },
      });
      setMe((m) => (m ? { ...m, emailVerified: true, emailVerifiedAt: new Date().toISOString() } : m));
      setCode("");
      setCodeSent(false);
      setCodeTone("ok");
      setCodeMsg(a.verified);
    } catch (e) {
      setCodeTone("err");
      setCodeMsg(e instanceof ApiError ? e.message : t.common.retry);
    } finally {
      setVerifying(false);
    }
  };

  const fetchMe = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await api<{ user?: MeUser }>("/api/auth/me");
      const u = raw.user;
      if (u) {
        setMe(u);
        setName(u.name ?? "");
        setEmail(u.email ?? "");
      }
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMe();
  }, [fetchMe]);

  const saveProfile = async () => {
    const nErr = name.trim() ? null : a.nameRequired;
    const eErr = EMAIL_RE.test(email.trim()) ? null : a.emailInvalid;
    setNameErr(nErr);
    setEmailErr(eErr);
    if (nErr || eErr) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const raw = await api<{ user: MeUser }>("/api/auth/me", {
        method: "PATCH",
        body: { name: name.trim(), email: email.trim() },
      });
      setMe(raw.user);
      setSaveMsg(a.profileSaved);
    } catch (e) {
      setSaveMsg(e instanceof ApiError ? e.message : t.common.retry);
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    setPwSaving(true);
    setPwMsg(null);
    try {
      await api("/api/auth/password", {
        method: "PUT",
        body: { currentPassword: curPw, newPassword: newPw },
      });
      setCurPw("");
      setNewPw("");
      setPwTone("ok");
      setPwMsg(a.passwordChanged);
    } catch (e) {
      setPwTone("err");
      setPwMsg(e instanceof ApiError ? e.message : t.common.retry);
    } finally {
      setPwSaving(false);
    }
  };

  const signOutThisDevice = async () => {
    setSigningOut(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* proceed to login regardless */
    } finally {
      try {
        localStorage.removeItem("fp_workspace_id");
      } catch {
        /* ignore */
      }
      router.push("/login");
    }
  };

  if (loading) return <Spinner label={t.common.loading} className="py-8" />;
  if (!me) return <p className="py-8 text-sm text-[var(--fp-text-2)]">{t.common.retry}</p>;

  const initials = me.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{a.profile}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#8B5CF6] to-[#22D3EE] text-base font-bold text-white">
              {initials}
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <Input label={a.name} value={name} onChange={(e) => setName(e.target.value)} error={nameErr ?? undefined} />
              <Input label={a.email} value={email} onChange={(e) => setEmail(e.target.value)} type="email" error={emailErr ?? undefined} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => void saveProfile()} loading={saving}>
              {a.saveProfile}
            </Button>
            <Msg text={saveMsg} tone="info" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{a.emailVerification}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-[var(--fp-text-2)]">{a.emailVerificationHint}</p>
          <div className="flex flex-wrap items-center gap-3">
            {me.emailVerified ? (
              <>
                <Badge tone="green">{a.verified}</Badge>
                {me.emailVerifiedAt && (
                  <span className="text-xs text-[var(--fp-text-2)]">
                    {a.verifiedOn} {new Date(me.emailVerifiedAt).toLocaleDateString()}
                  </span>
                )}
              </>
            ) : (
              <>
                <Badge tone="amber">{a.notVerified}</Badge>
                <Button size="sm" variant="secondary" onClick={() => void resendCode()} loading={resending}>
                  {resending ? a.resending : a.resendCode}
                </Button>
              </>
            )}
            <Msg text={codeMsg} tone={codeTone} />
          </div>
          {!me.emailVerified && codeSent && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-44">
                <Input
                  label={a.codeLabel}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  dir="ltr"
                />
              </div>
              <Button
                size="sm"
                onClick={() => void verifyCode()}
                loading={verifying}
                disabled={!/^\d{6}$/.test(code.trim())}
              >
                {a.verifyCode}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{a.password}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label={a.currentPassword} type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" />
            <Input label={a.newPassword} type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => void changePassword()} loading={pwSaving} disabled={!curPw || newPw.length < 8}>
              {a.changePassword}
            </Button>
            <Msg text={pwMsg} tone={pwTone} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{a.sessions}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-[var(--fp-text-2)]">{a.sessionsHint}</p>
          <Row label={a.currentSession} hint={a.currentSessionHint}>
            <MonitorSmartphone className="h-5 w-5 shrink-0 text-[var(--fp-text-2)]" aria-hidden />
          </Row>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary" onClick={() => void signOutThisDevice()} loading={signingOut}>
              <LogOut className="h-4 w-4" aria-hidden />
              {a.signOutThisDevice}
            </Button>
            <Button size="sm" variant="secondary" disabled title={a.signOutAllUnavailable}>
              {a.signOutAll}
            </Button>
            <NotYet label={t.common.notYetAvailable} />
          </div>
          <p className="text-xs text-[var(--fp-text-2)]">{a.signOutAllUnavailable}</p>
        </CardContent>
      </Card>
    </div>
  );
}
