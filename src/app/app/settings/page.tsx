"use client";

/**
 * Settings: exactly 7 sections —
 * Account · Workspace · Preferences · Integrations · Plan & Usage ·
 * Help & Support · Privacy & Security.
 * Every section is wired to a real API (or honestly labeled when the
 * backend capability doesn't exist yet); tab labels come from the core
 * `settings.*` dictionary keys (reused) + the settingsExt fragment.
 */
import { useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import enDict from "@/i18n/dictionaries/en";
import arDict from "@/i18n/dictionaries/ar";
import { useSettingsLocale } from "./ui";
import { AccountTab } from "./tabs/AccountTab";
import { WorkspaceTab } from "./tabs/WorkspaceTab";
import { PreferencesTab } from "./tabs/PreferencesTab";
import { IntegrationsTab } from "./tabs/IntegrationsTab";
import { PlanTab } from "./tabs/PlanTab";
import { HelpTab } from "./tabs/HelpTab";
import { PrivacyTab } from "./tabs/PrivacyTab";
import {
  User,
  Users,
  SlidersHorizontal,
  Plug,
  CreditCard,
  LifeBuoy,
  ShieldCheck,
} from "lucide-react";

type TabId =
  | "account"
  | "workspace"
  | "preferences"
  | "integrations"
  | "plan"
  | "support"
  | "privacy";

const TABS: { id: TabId; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "account", icon: User },
  { id: "workspace", icon: Users },
  { id: "preferences", icon: SlidersHorizontal },
  { id: "integrations", icon: Plug },
  { id: "plan", icon: CreditCard },
  { id: "support", icon: LifeBuoy },
  { id: "privacy", icon: ShieldCheck },
];

export default function SettingsPage() {
  const { locale, t } = useSettingsLocale();
  const [tab, setTab] = useState<TabId>("account");
  // Core dictionary labels (settings.* namespace) — reused, not duplicated.
  const core = (locale === "ar" ? arDict : enDict).settings;

  const labels: Record<TabId, string> = {
    account: core.account,
    workspace: core.workspace,
    preferences: core.preferences,
    integrations: core.integrations,
    plan: core.plan,
    support: core.support,
    privacy: core.privacy,
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={core.title} description={core.subtitle} />

      <nav
        aria-label={core.title}
        className="mb-5 flex flex-wrap gap-1.5 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-bg-1)] p-1.5"
      >
        {TABS.map(({ id, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE] text-white shadow"
                  : "text-[var(--fp-text-2)] hover:bg-[var(--fp-bg-2)] hover:text-[var(--fp-text)]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {labels[id]}
            </button>
          );
        })}
      </nav>

      {tab === "account" && <AccountTab t={t} />}
      {tab === "workspace" && <WorkspaceTab t={t} />}
      {tab === "preferences" && <PreferencesTab t={t} locale={locale} />}
      {tab === "integrations" && <IntegrationsTab t={t} />}
      {tab === "plan" && <PlanTab t={t} />}
      {tab === "support" && <HelpTab t={t} locale={locale} />}
      {tab === "privacy" && <PrivacyTab t={t} />}
    </div>
  );
}
