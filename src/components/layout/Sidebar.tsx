"use client";

import {
  Activity,
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  CreditCard,
  Inbox,
  LayoutDashboard,
  Megaphone,
  MessageCircle,
  Plug,
  Settings,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  Telescope,
  Users,
  UsersRound,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useDict } from "@/i18n/client";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { LanguageSelector } from "@/components/i18n/LanguageSelector";

export interface NavItem {
  /** Key into the `sidebar` dictionary namespace — labels resolve via useDict(). */
  labelKey: keyof Dictionary["sidebar"];
  href: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { labelKey: "overview", href: "/app/overview", icon: LayoutDashboard },
  { labelKey: "activity", href: "/app/activity", icon: Activity },
  { labelKey: "inbox", href: "/app/inbox", icon: Inbox },
  { labelKey: "automations", href: "/app/automations", icon: Workflow },
  { labelKey: "aiAssistant", href: "/app/ai-assistant", icon: Sparkles },
  { labelKey: "contacts", href: "/app/contacts", icon: Users },
  { labelKey: "campaigns", href: "/app/campaigns", icon: Megaphone },
  { labelKey: "retargeting", href: "/app/retargeting", icon: Target },
  { labelKey: "followUps", href: "/app/follow-ups", icon: Send },
  { labelKey: "analytics", href: "/app/analytics", icon: BarChart3 },
  { labelKey: "integrations", href: "/app/integrations", icon: Plug },
  { labelKey: "healthCenter", href: "/app/health-center", icon: Activity },
  { labelKey: "commentToDm", href: "/app/comment-to-dm", icon: MessageCircle },
  { labelKey: "prospecting", href: "/app/prospecting", icon: Telescope },
  { labelKey: "consent", href: "/app/consent", icon: ShieldCheck },
  { labelKey: "team", href: "/app/team", icon: UsersRound },
  { labelKey: "settings", href: "/app/settings", icon: Settings },
  { labelKey: "billing", href: "/app/billing", icon: CreditCard },
];

export interface SidebarUser {
  name: string;
  email: string;
}

export function Sidebar({ user }: { user: SidebarUser | null }) {
  const t = useDict();
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  const isActive = (href: string) => pathname === href || pathname?.startsWith(href + "/");

  const initials =
    user?.name
      ?.split(" ")
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() ?? "?";

  return (
    <aside
      className={`relative flex h-full flex-col border-e border-[var(--fp-border)] bg-[var(--fp-bg-2)] transition-all duration-200 ${
        collapsed ? "w-20" : "w-64"
      }`}
    >
      {/* Logo (never mirrored — brand mark) */}
      <div className="flex h-16 items-center gap-3 border-b border-[var(--fp-border)] px-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl btn-gradient shadow-glow">
          <Zap className="h-5 w-5 text-white" aria-hidden />
        </div>
        {!collapsed && (
          <span className="whitespace-nowrap text-base font-bold text-[var(--fp-text)]">
            FlowPilot <span className="text-gradient">AI</span>
          </span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label={t.sidebar.primaryNav}>
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          const label = t.sidebar[item.labelKey];
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? label : undefined}
              aria-current={active ? "page" : undefined}
              className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-[var(--fp-card)] text-[var(--fp-text)]"
                  : "text-[var(--fp-text-2)] hover:bg-[var(--fp-card)] hover:text-[var(--fp-text)]"
              } ${collapsed ? "justify-center" : ""}`}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute start-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-e-full bg-gradient-to-b from-[#8B5CF6] to-[#22D3EE]"
                />
              )}
              <Icon className="h-5 w-5 shrink-0" aria-hidden />
              {!collapsed && <span className="whitespace-nowrap">{label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Bottom: language, collapse toggle + user chip */}
      <div className="space-y-2 border-t border-[var(--fp-border)] p-3">
        <div className={collapsed ? "flex justify-center" : ""}>
          <LanguageSelector className={collapsed ? "" : "w-full justify-center"} />
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? t.sidebar.expand : t.sidebar.collapse}
          aria-expanded={!collapsed}
          className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--fp-text-2)] transition-colors hover:bg-[var(--fp-card)] hover:text-[var(--fp-text)] ${
            collapsed ? "justify-center" : ""
          }`}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
              <span>{t.sidebar.collapse}</span>
            </>
          )}
        </button>
        <div
          className={`flex items-center gap-2.5 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] px-3 py-2 ${
            collapsed ? "justify-center" : ""
          }`}
          title={collapsed ? `${user?.name ?? t.sidebar.account} — ${user?.email ?? ""}` : undefined}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full btn-gradient text-xs font-bold text-white">
            {initials}
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[var(--fp-text)]">
                {user?.name ?? t.sidebar.account}
              </p>
              <p className="truncate text-xs text-[var(--fp-text-2)]">{user?.email ?? ""}</p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
