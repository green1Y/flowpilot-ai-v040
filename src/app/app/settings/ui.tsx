"use client";

/**
 * Phase 4 — Settings shared client UI: locale hook, role helpers,
 * Toggle, and small message/row primitives.
 */
import { useEffect, useState } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { en, ar } from "@/i18n/fragments/settings";

export type SettingsDict = typeof en.settingsExt;

/** Resolve the UI locale from the fp_locale cookie (no I18nProvider in /app). */
export function useSettingsLocale(): { locale: Locale; t: SettingsDict } {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  useEffect(() => {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=(en|ar)`));
    setLocale(m?.[1] === "ar" ? "ar" : "en");
  }, []);
  const dict = locale === "ar" ? ar : en;
  return { locale, t: dict.settingsExt };
}

const ROLE_RANK: Record<string, number> = { OWNER: 4, ADMIN: 3, MANAGER: 2, AGENT: 1, ANALYST: 0 };

/** True when the member's role meets or exceeds minRole. */
export function roleAtLeast(role: string | undefined, minRole: string): boolean {
  if (!role) return false;
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[minRole] ?? 99);
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        checked
          ? "bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]"
          : "border border-[var(--fp-border)] bg-[var(--fp-bg-2)]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
          // Logical properties: the knob slides toward the inline end in both
          // LTR and RTL (physical `left-*` slid the wrong way in Arabic).
          checked ? "end-0.5" : "start-0.5"
        }`}
      />
    </button>
  );
}

/** Honest "not implemented yet" marker for controls that can't work yet. */
export function NotYet({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-dashed border-[var(--fp-border)] bg-[var(--fp-bg)] px-2.5 py-0.5 text-xs font-medium text-[var(--fp-text-2)]">
      {label}
    </span>
  );
}

export function Msg({ text, tone }: { text: string | null; tone?: "ok" | "err" | "info" }) {
  if (!text) return null;
  const color =
    tone === "ok" ? "text-emerald-400" : tone === "err" ? "text-[#FB7185]" : "text-[var(--fp-text-2)]";
  return <p className={`text-sm ${color}`}>{text}</p>;
}

export function Row({
  children,
  label,
  hint,
}: {
  children: React.ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-4 py-3">
      {children}
      <div>
        <p className="text-sm font-medium text-[var(--fp-text)]">{label}</p>
        {hint && <p className="text-xs text-[var(--fp-text-2)]">{hint}</p>}
      </div>
    </div>
  );
}
