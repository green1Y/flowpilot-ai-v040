"use client";

import { useEffect, useState } from "react";
import { api, ApiError, AccountProvider, WorkspaceProvider } from "@/lib/api-client";
import { PageSpinner } from "@/components/ui/Spinner";
import { Sidebar, type SidebarUser } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";

function isUser(v: unknown): v is SidebarUser {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.email === "string";
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [user, setUser] = useState<SidebarUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await api<unknown>("/api/auth/me");
        if (cancelled) return;
        // Handlers may return { user } or the user object directly.
        const u =
          raw && typeof raw === "object" && "user" in raw
            ? (raw as { user: unknown }).user
            : raw;
        setUser(isUser(u) ? { name: u.name, email: u.email } : null);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          window.location.href = "/login";
          return;
        }
        // Non-auth failure (backend warming up, etc.): still render the shell
        // so pages can show their own error states instead of hanging forever.
        setStatus("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "loading") return <PageSpinner label="Loading your workspace…" />;

  return (
    <WorkspaceProvider>
      <AccountProvider>
        <div className="flex h-screen overflow-hidden bg-[var(--fp-bg)] text-[var(--fp-text)]">
          <Sidebar user={user} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar user={user} />
            <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">{children}</main>
          </div>
        </div>
      </AccountProvider>
    </WorkspaceProvider>
  );
}
