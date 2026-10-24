"use client";

import { AlertCircle, Eye, EyeOff, Zap } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api-client";
import { useDict } from "@/i18n/client";
import { LanguageSelector } from "@/components/i18n/LanguageSelector";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

function AuthShell({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--fp-bg)] px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(700px_circle_at_50%_0%,rgba(139,92,246,0.22),transparent_65%),radial-gradient(500px_circle_at_85%_90%,rgba(34,211,238,0.12),transparent_60%)]"
      />
      <div className="relative w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl btn-gradient shadow-glow">
            <Zap className="h-5 w-5 text-white" aria-hidden />
          </div>
          <span className="text-xl font-bold text-[var(--fp-text)]">
            FlowPilot <span className="text-gradient">AI</span>
          </span>
        </Link>
        <div className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-8 shadow-card">
          <h1 className="text-2xl font-bold text-[var(--fp-text)]">{title}</h1>
          <p className="mt-1.5 text-sm text-[var(--fp-text-2)]">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        <div className="mt-6 flex justify-center">
          <LanguageSelector />
        </div>
      </div>
    </div>
  );
}

export function SignupForm() {
  const t = useDict();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const validate = () => {
    const e: Record<string, string> = {};
    if (name.trim().length < 2) e.name = t.auth.nameRequired;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) e.email = t.validation.invalidEmail;
    if (password.length < 8) e.password = t.auth.passwordTooShort;
    if (workspaceName.trim().length < 2) e.workspaceName = t.auth.workspaceRequired;
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    setServerError(null);
    if (!validate()) return;
    setLoading(true);
    try {
      await api("/api/auth/signup", {
        method: "POST",
        body: {
          name: name.trim(),
          email: email.trim(),
          password,
          workspaceName: workspaceName.trim(),
        },
      });
      window.location.href = "/app/onboarding";
    } catch (err) {
      if (err instanceof ApiError && err.issues) {
        const mapped: Record<string, string> = {};
        for (const i of err.issues) mapped[i.path] = i.message;
        setErrors(mapped);
      }
      setServerError(err instanceof ApiError ? err.message : t.auth.genericError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title={t.auth.createAccount} subtitle={t.auth.signUpSubtitle}>
      {serverError && (
        <div
          role="alert"
          className="mb-5 flex items-start gap-2.5 rounded-xl border border-[#FB7185]/30 bg-[#FB7185]/10 px-4 py-3 text-sm text-[#FDA4AF]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {serverError}
        </div>
      )}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Input
          label={t.auth.nameLabel}
          type="text"
          autoComplete="name"
          placeholder={t.auth.nameLabel}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
        />
        <Input
          label={t.auth.workEmail}
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <Input
          label={t.auth.passwordLabel}
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint={t.auth.passwordHint}
          trailing={
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t.auth.hidePassword : t.auth.showPassword}
              title={showPassword ? t.auth.hidePassword : t.auth.showPassword}
              tabIndex={-1}
              className="text-[var(--fp-text-2)] transition-colors hover:text-[var(--fp-text)]"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden />
              ) : (
                <Eye className="h-4 w-4" aria-hidden />
              )}
            </button>
          }
        />
        <Input
          label={t.auth.workspaceName}
          type="text"
          autoComplete="organization"
          placeholder={t.auth.workspaceName}
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
          error={errors.workspaceName}
        />
        <Button type="submit" loading={loading} className="w-full" size="lg">
          {t.auth.createAccountCta}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-[var(--fp-text-2)]">
        {t.auth.haveAccount}{" "}
        <Link href="/login" className="font-medium text-[var(--fp-accent-2)] hover:underline">
          {t.common.signIn}
        </Link>
      </p>
    </AuthShell>
  );
}
