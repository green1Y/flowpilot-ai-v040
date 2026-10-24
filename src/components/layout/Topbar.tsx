"use client";

import { Bell, ChevronDown, LogOut, Moon, Plus, Search, Settings, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, useAccountSelection, useWorkspaces, type Workspace } from "@/lib/api-client";
import { useDict } from "@/i18n/client";
import { LanguageSelector } from "@/components/i18n/LanguageSelector";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { NAV_ITEMS, type SidebarUser } from "./Sidebar";

export interface NotificationItem {
  id: string;
  title: string;
  message?: string;
  createdAt?: string;
  read?: boolean;
}

interface NotificationsResponse {
  notifications?: NotificationItem[];
  demo?: boolean;
}

/** Apply the theme to <html> and persist the choice. */
export function applyTheme(theme: "dark" | "light") {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("light", theme === "light");
  document.documentElement.classList.toggle("dark", theme !== "light");
  try {
    localStorage.setItem("fp_theme", theme);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent<"dark" | "light">("fp:theme-change", { detail: theme }));
}

/** Read the persisted theme (dark when unset/unreadable). */
export function readTheme(): "dark" | "light" {
  try {
    return localStorage.getItem("fp_theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function ThemeToggle() {
  const t = useDict();
  // Lazy init from storage (no useEffect correction): avoids a first-frame
  // icon mismatch when the saved theme is light. The root layout's
  // pre-paint init script already applied the matching <html> class.
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);

  useEffect(() => {
    // Stay in sync with other theme controls (e.g. Settings → Preferences).
    const onChange = (e: Event) => setTheme((e as CustomEvent<"dark" | "light">).detail);
    window.addEventListener("fp:theme-change", onChange);
    return () => window.removeEventListener("fp:theme-change", onChange);
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  return (
    <button
      onClick={toggle}
      aria-label={theme === "dark" ? t.topbar.switchToLight : t.topbar.switchToDark}
      className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] text-[var(--fp-text-2)] transition-colors hover:text-[var(--fp-text)]"
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function useDismissOnOutside() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { open, setOpen, ref };
}

function WorkspaceSwitcher() {
  const t = useDict();
  const { workspaces, current, setCurrent, loading } = useWorkspaces();
  const { open, setOpen, ref } = useDismissOnOutside();

  const pick = (w: Workspace) => {
    setCurrent(w);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex max-w-[220px] items-center gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] px-3 py-2 text-sm font-medium text-[var(--fp-text)] transition-colors hover:border-[var(--fp-accent)]"
      >
        <span className="truncate">{loading ? t.topbar.loading : current?.name ?? t.topbar.selectWorkspace}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--fp-text-2)]" aria-hidden />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t.topbar.workspaces}
          className="absolute start-0 top-full z-40 mt-2 w-64 overflow-hidden rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] shadow-card"
        >
          {workspaces.length === 0 && (
            <p className="px-4 py-3 text-sm text-[var(--fp-text-2)]">{t.topbar.noWorkspaces}</p>
          )}
          {workspaces.map((w) => (
            <button
              key={w.id}
              role="option"
              aria-selected={current?.id === w.id}
              onClick={() => pick(w)}
              className={`flex w-full items-center justify-between px-4 py-2.5 text-sm transition-colors hover:bg-[var(--fp-bg-2)] ${
                current?.id === w.id ? "font-medium text-[var(--fp-text)]" : "text-[var(--fp-text-2)]"
              }`}
            >
              <span className="truncate">{w.name}</span>
              {current?.id === w.id && (
                <span className="ms-2 h-2 w-2 shrink-0 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]" aria-hidden />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface IntegrationAccount {
  id: string;
  provider: string;
  displayName: string;
  accountName: string | null;
  externalAccountId: string | null;
  status: string;
}

interface IntegrationsResponse {
  integrations?: Record<string, unknown>[];
}

/** Shorten a provider-side account id for display ("1234567890…" → "12345678"). */
function shortExternalId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function accountLabel(a: IntegrationAccount): string {
  if (a.accountName) return `${a.displayName} · ${a.accountName}`;
  if (a.externalAccountId) return `${a.displayName} · ${shortExternalId(a.externalAccountId)}`;
  return a.displayName;
}

function accountStatusDot(status: string): string {
  if (status === "CONNECTED") return "bg-[#34D399]";
  if (status === "NEEDS_ATTENTION") return "bg-[#FBBF24]";
  return "bg-[var(--fp-text-2)]";
}

/**
 * Batch B — connected-account switcher (mirrors WorkspaceSwitcher).
 * Lists the ACTIVE workspace's real accounts from GET /api/integrations
 * (the response never contains credentials): rows that carry a
 * provider-side account id, or are CONNECTED / NEEDS_ATTENTION. Pure
 * placeholder rows (seeded DEMO/DISCONNECTED catalog entries) are skipped.
 * "All accounts" (null) is the default; the selection is global via
 * useAccountSelection() and persisted per workspace.
 */
function AccountSwitcher() {
  const { current } = useWorkspaces();
  const { accountId, setAccountId } = useAccountSelection();
  const { open, setOpen, ref } = useDismissOnOutside();
  const [accounts, setAccounts] = useState<IntegrationAccount[]>([]);
  const [loaded, setLoaded] = useState(false);

  const workspaceId = current?.id ?? null;
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        const raw = await api<IntegrationsResponse | Record<string, unknown>[]>("/api/integrations");
        if (cancelled) return;
        const list = Array.isArray(raw) ? raw : (raw?.integrations ?? []);
        const parsed: IntegrationAccount[] = [];
        const seen = new Set<string>();
        for (const row of list) {
          const id = typeof row.id === "string" ? row.id : null;
          if (!id || seen.has(id)) continue;
          const provider = typeof row.provider === "string" ? row.provider : "";
          const status = typeof row.status === "string" ? row.status : "DISCONNECTED";
          const externalAccountId =
            (typeof row.externalAccountId === "string" && row.externalAccountId) ||
            (typeof row.accountId === "string" && row.accountId) ||
            null;
          // Skip pure placeholder rows: no provider identity and not in a
          // live/attention state.
          if (!externalAccountId && status !== "CONNECTED" && status !== "NEEDS_ATTENTION") continue;
          seen.add(id);
          parsed.push({
            id,
            provider,
            displayName:
              typeof row.displayName === "string" && row.displayName
                ? row.displayName
                : provider
                  ? provider.charAt(0).toUpperCase() + provider.slice(1)
                  : "Account",
            accountName: typeof row.accountName === "string" ? row.accountName : null,
            externalAccountId,
            status,
          });
        }
        setAccounts(parsed);
      } catch {
        if (!cancelled) setAccounts([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // A persisted selection that no longer exists in this workspace (account
  // disconnected/removed elsewhere) is dropped instead of 403-looping.
  useEffect(() => {
    if (loaded && accountId && !accounts.some((a) => a.id === accountId)) {
      setAccountId(null);
    }
  }, [loaded, accounts, accountId, setAccountId]);

  // No real accounts in this workspace — render nothing (the filter would
  // have nothing to filter by).
  if (loaded && accounts.length === 0) return null;

  const selected = accountId ? (accounts.find((a) => a.id === accountId) ?? null) : null;
  const buttonLabel = selected ? accountLabel(selected) : "All accounts";

  const pick = (id: string | null) => {
    setAccountId(id);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Connected account"
        className="flex max-w-[220px] items-center gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] px-3 py-2 text-sm font-medium text-[var(--fp-text)] transition-colors hover:border-[var(--fp-accent)]"
      >
        {selected && <span className={`h-2 w-2 shrink-0 rounded-full ${accountStatusDot(selected.status)}`} aria-hidden />}
        <span className="truncate">{buttonLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--fp-text-2)]" aria-hidden />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Accounts"
          className="absolute start-0 top-full z-40 mt-2 w-64 overflow-hidden rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] shadow-card"
        >
          <button
            role="option"
            aria-selected={accountId === null}
            onClick={() => pick(null)}
            className={`flex w-full items-center justify-between px-4 py-2.5 text-sm transition-colors hover:bg-[var(--fp-bg-2)] ${
              accountId === null ? "font-medium text-[var(--fp-text)]" : "text-[var(--fp-text-2)]"
            }`}
          >
            <span className="truncate">All accounts</span>
            {accountId === null && (
              <span className="ms-2 h-2 w-2 shrink-0 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]" aria-hidden />
            )}
          </button>
          {accounts.map((a) => (
            <button
              key={a.id}
              role="option"
              aria-selected={accountId === a.id}
              onClick={() => pick(a.id)}
              className={`flex w-full items-center justify-between px-4 py-2.5 text-sm transition-colors hover:bg-[var(--fp-bg-2)] ${
                accountId === a.id ? "font-medium text-[var(--fp-text)]" : "text-[var(--fp-text-2)]"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${accountStatusDot(a.status)}`} aria-hidden />
                <span className="truncate">{accountLabel(a)}</span>
              </span>
              <span className="ms-2 shrink-0 text-[11px] text-[var(--fp-text-2)]">{a.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GlobalSearch() {
  const t = useDict();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const { ref } = useDismissOnOutside();

  const q = query.trim().toLowerCase();
  const results =
    q.length > 0
      ? NAV_ITEMS.filter((n) => t.sidebar[n.labelKey].toLowerCase().includes(q))
      : [];

  const go = (href: string) => {
    setQuery("");
    setFocused(false);
    router.push(href);
  };

  return (
    <div className="relative hidden w-full max-w-sm md:block" ref={ref}>
      <div className="relative">
        <Search
          className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fp-text-2)]"
          aria-hidden
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results.length > 0) go(results[0].href);
          }}
          placeholder={t.topbar.searchPlaceholder}
          aria-label={t.topbar.searchAria}
          className="w-full rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] py-2 pe-3 ps-9 text-sm text-[var(--fp-text)] placeholder:text-[var(--fp-text-2)] focus:border-[var(--fp-accent)] focus:outline-none"
        />
      </div>
      {focused && query.trim().length > 0 && (
        <div className="absolute start-0 end-0 top-full z-40 mt-2 overflow-hidden rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] shadow-card">
          {results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-[var(--fp-text-2)]">{t.topbar.noMatchingSections}</p>
          ) : (
            results.map((r) => {
              const Icon = r.icon;
              return (
                <button
                  key={r.href}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(r.href)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-[var(--fp-text)] transition-colors hover:bg-[var(--fp-bg-2)]"
                >
                  <Icon className="h-4 w-4 text-[var(--fp-text-2)]" aria-hidden />
                  {t.sidebar[r.labelKey]}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function NotificationBell() {
  const t = useDict();
  const { open, setOpen, ref } = useDismissOnOutside();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [demo, setDemo] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      try {
        const raw = await api<unknown>("/api/notifications");
        const r = raw as NotificationsResponse | NotificationItem[] | null;
        if (Array.isArray(r)) {
          setItems(r);
        } else if (r && typeof r === "object") {
          setItems(Array.isArray(r.notifications) ? r.notifications : []);
          setDemo(r.demo === true);
        }
      } catch {
        setItems([]);
      } finally {
        setLoaded(true);
      }
    })();
  }, [open, loaded]);

  const unread = items.filter((n) => !n.read).length;
  const ariaLabel =
    unread > 0
      ? `${t.topbar.notifications}, ${t.topbar.unreadSuffix.replace("{count}", String(unread))}`
      : t.topbar.notifications;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        aria-haspopup="true"
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] text-[var(--fp-text-2)] transition-colors hover:text-[var(--fp-text)]"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && (
          <span className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#FB7185] px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute end-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] shadow-card">
          <div className="flex items-center justify-between border-b border-[var(--fp-border)] px-4 py-3">
            <span className="text-sm font-semibold text-[var(--fp-text)]">{t.topbar.notifications}</span>
            {demo && <Badge tone="amber">{t.topbar.demo}</Badge>}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {!loaded && <p className="px-4 py-6 text-center text-sm text-[var(--fp-text-2)]">{t.topbar.loading}</p>}
            {loaded && items.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-[var(--fp-text-2)]">
                {t.topbar.caughtUp}
              </p>
            )}
            {items.map((n) => (
              <div
                key={n.id}
                className="border-b border-[var(--fp-border)] px-4 py-3 transition-colors last:border-0 hover:bg-[var(--fp-bg-2)]"
              >
                <p className="text-sm font-medium text-[var(--fp-text)]">{n.title}</p>
                {n.message && <p className="mt-0.5 text-xs text-[var(--fp-text-2)] line-clamp-2">{n.message}</p>}
                {n.createdAt && (
                  <p className="mt-1 text-[11px] text-[var(--fp-text-2)]">
                    {new Date(n.createdAt).toLocaleString()}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileMenu({ user }: { user: SidebarUser | null }) {
  const t = useDict();
  const router = useRouter();
  const { open, setOpen, ref } = useDismissOnOutside();
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    setLoggingOut(true);
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
      window.location.href = "/login";
    }
  };

  const initials =
    user?.name
      ?.split(" ")
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() ?? "?";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={t.topbar.accountMenu}
        aria-haspopup="true"
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-full btn-gradient text-xs font-bold text-white"
      >
        {initials}
      </button>
      {open && (
        <div className="absolute end-0 top-full z-40 mt-2 w-64 overflow-hidden rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] shadow-card">
          <div className="border-b border-[var(--fp-border)] px-4 py-3">
            <p className="truncate text-sm font-medium text-[var(--fp-text)]">{user?.name ?? t.topbar.account}</p>
            <p className="truncate text-xs text-[var(--fp-text-2)]">{user?.email ?? ""}</p>
          </div>
          <button
            onClick={() => {
              setOpen(false);
              router.push("/app/settings");
            }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-[var(--fp-text-2)] transition-colors hover:bg-[var(--fp-bg-2)] hover:text-[var(--fp-text)]"
          >
            <Settings className="h-4 w-4" aria-hidden />
            {t.topbar.settings}
          </button>
          <button
            onClick={logout}
            disabled={loggingOut}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-[#FB7185] transition-colors hover:bg-[var(--fp-bg-2)] disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {loggingOut ? t.topbar.signingOut : t.topbar.logout}
          </button>
        </div>
      )}
    </div>
  );
}

export function Topbar({ user }: { user: SidebarUser | null }) {
  const t = useDict();
  const router = useRouter();

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-4 sm:px-6">
      <WorkspaceSwitcher />
      <AccountSwitcher />
      <GlobalSearch />
      <div className="ms-auto flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => router.push("/app/automations/new")}
          className="hidden sm:inline-flex"
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t.topbar.createAutomation}
        </Button>
        <LanguageSelector className="hidden sm:inline-flex" />
        <NotificationBell />
        <ThemeToggle />
        <ProfileMenu user={user} />
      </div>
    </header>
  );
}
