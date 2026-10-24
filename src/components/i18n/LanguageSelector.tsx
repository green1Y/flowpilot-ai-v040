"use client";

/**
 * LanguageSelector — EN / العربية toggle.
 *
 * Uses setLocaleClient() from @/i18n/client: persists the fp_locale cookie
 * (+ best-effort persist to the user record) and reloads so the server
 * renders with the new locale, including <html lang dir>.
 *
 * Deliberately does NOT use useDict(): language names are shown in their
 * own language ("EN" / "العربية") and the group label is derived from the
 * current locale, so this control also works outside an I18nProvider.
 */
import { Globe } from "lucide-react";
import { LOCALES, type Locale } from "@/i18n/config";
import { setLocaleClient, useLocale } from "@/i18n/client";

const LABELS: Record<Locale, string> = { en: "EN", ar: "العربية" };
const GROUP_LABEL: Record<Locale, string> = { en: "Choose language", ar: "اختر اللغة" };

export function LanguageSelector({ className = "" }: { className?: string }) {
  const locale = useLocale();

  return (
    <div
      role="group"
      aria-label={GROUP_LABEL[locale]}
      className={`inline-flex items-center gap-0.5 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-0.5 ${className}`}
    >
      <Globe className="mx-1 h-3.5 w-3.5 shrink-0 text-[var(--fp-text-2)]" aria-hidden />
      {LOCALES.map((l) => {
        const active = l === locale;
        return (
          <button
            key={l}
            type="button"
            onClick={() => {
              if (!active) setLocaleClient(l);
            }}
            aria-pressed={active}
            aria-label={l === "ar" ? "العربية" : "English"}
            className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
              active
                ? "bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE] text-white"
                : "text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
            }`}
          >
            {LABELS[l]}
          </button>
        );
      })}
    </div>
  );
}
