"use client";

/**
 * Settings · Preferences section.
 * Theme (dark/light via applyTheme — persisted in localStorage as fp_theme),
 * language (PUT /api/account/locale + cookie → reload), timezone
 * (PATCH /api/auth/me), personal notification toggles (PATCH /api/auth/me),
 * and workspace-wide alert toggles (GET/PUT /api/workspace/settings,
 * MANAGER+ to change).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, useWorkspaces } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Moon, Sun } from "lucide-react";
import { setLocaleClient } from "@/i18n/client";
import { LOCALES, type Locale } from "@/i18n/config";
import { workspaceNotifDefaults } from "@/lib/workspace-settings";
import { applyTheme, readTheme } from "@/components/layout/Topbar";
import { roleAtLeast, Toggle, Row, Msg, type SettingsDict } from "../ui";

interface MeUser {
  id: string;
  name: string;
  email: string;
  locale?: string;
  timezone?: string;
  notificationPrefs?: Record<string, boolean>;
}

type NotifKey = "newMessage" | "aiApproval" | "mention" | "weeklyDigest";

interface WorkspaceNotif {
  workflowFailures: boolean;
  integrationDisconnected: boolean;
  quotaWarnings: boolean;
  emailAlerts: boolean;
}

function ThemeCard({ t }: { t: SettingsDict }) {
  const p = t.preferences;
  // Mirrors the topbar toggle; applyTheme broadcasts fp:theme-change so both
  // controls stay in sync.
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);

  useEffect(() => {
    const onChange = (e: Event) => setTheme((e as CustomEvent<"dark" | "light">).detail);
    window.addEventListener("fp:theme-change", onChange);
    return () => window.removeEventListener("fp:theme-change", onChange);
  }, []);

  const pick = (v: "dark" | "light") => {
    if (v === theme) return;
    setTheme(v);
    applyTheme(v);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{p.theme}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-[var(--fp-text-2)]">{p.themeHint}</p>
        <div
          role="radiogroup"
          aria-label={p.theme}
          className="inline-flex items-center gap-0.5 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-0.5"
        >
          {(
            [
              { v: "dark", label: p.dark, Icon: Moon },
              { v: "light", label: p.light, Icon: Sun },
            ] as const
          ).map(({ v, label, Icon }) => {
            const active = theme === v;
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => pick(v)}
                className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE] text-white"
                    : "text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function PreferencesTab({ t, locale }: { t: SettingsDict; locale: Locale }) {
  const p = t.preferences;
  const n = t.notifications;
  const { current } = useWorkspaces();
  const canEditAlerts = roleAtLeast(current?.role, "MANAGER");

  const [me, setMe] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);

  const [timezone, setTimezone] = useState("UTC");
  const [tzSaving, setTzSaving] = useState(false);
  const [tzMsg, setTzMsg] = useState<string | null>(null);

  const [prefs, setPrefs] = useState<Record<NotifKey, boolean>>({
    newMessage: true,
    aiApproval: true,
    mention: true,
    weeklyDigest: false,
  });

  const [alerts, setAlerts] = useState<WorkspaceNotif>({ ...workspaceNotifDefaults });
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [alertsSaving, setAlertsSaving] = useState(false);
  const [alertsMsg, setAlertsMsg] = useState<string | null>(null);

  const timezones = useMemo(() => {
    try {
      const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
      if (typeof f === "function") return f("timeZone");
    } catch {
      /* fall through */
    }
    return ["UTC"];
  }, []);

  const fetchMe = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await api<{ user?: MeUser }>("/api/auth/me");
      const u = raw.user;
      if (u) {
        setMe(u);
        setTimezone(u.timezone ?? "UTC");
        setPrefs((prev) => ({ ...prev, ...u.notificationPrefs }));
      }
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
    setAlertsLoading(true);
    try {
      const raw = await api<{ settings: { notifications: WorkspaceNotif } }>("/api/workspace/settings");
      setAlerts({ ...workspaceNotifDefaults, ...raw.settings.notifications });
    } catch {
      /* keep defaults */
    } finally {
      setAlertsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMe();
    void fetchAlerts();
  }, [fetchMe, fetchAlerts]);

  const saveTimezone = async (tz: string) => {
    setTimezone(tz);
    setTzSaving(true);
    setTzMsg(null);
    try {
      await api("/api/auth/me", { method: "PATCH", body: { timezone: tz } });
      setTzMsg(t.common.save + " ✓");
    } catch (e) {
      setTzMsg(e instanceof ApiError ? e.message : t.common.retry);
    } finally {
      setTzSaving(false);
    }
  };

  const updatePref = async (key: NotifKey, v: boolean) => {
    const prev = prefs;
    setPrefs({ ...prev, [key]: v });
    try {
      await api("/api/auth/me", { method: "PATCH", body: { notificationPrefs: { [key]: v } } });
    } catch {
      setPrefs(prev); // revert on failure
    }
  };

  const saveAlerts = async () => {
    setAlertsSaving(true);
    setAlertsMsg(null);
    try {
      const raw = await api<{ settings: { notifications: WorkspaceNotif } }>("/api/workspace/settings", {
        method: "PUT",
        body: { notifications: alerts },
      });
      setAlerts(raw.settings.notifications);
      setAlertsMsg(n.saved);
    } catch (e) {
      setAlertsMsg(e instanceof ApiError ? e.message : t.common.retry);
    } finally {
      setAlertsSaving(false);
    }
  };

  const personalRows: { key: NotifKey; label: string; hint: string }[] = [
    { key: "newMessage", label: p.newMessage, hint: p.newMessageHint },
    { key: "aiApproval", label: p.aiApproval, hint: p.aiApprovalHint },
    { key: "mention", label: p.mention, hint: p.mentionHint },
    { key: "weeklyDigest", label: p.weeklyDigest, hint: p.weeklyDigestHint },
  ];

  const alertRows: { key: keyof WorkspaceNotif; label: string; hint: string }[] = [
    { key: "workflowFailures", label: n.workflowFailures, hint: n.workflowFailuresHint },
    { key: "integrationDisconnected", label: n.integrationDisconnected, hint: n.integrationDisconnectedHint },
    { key: "quotaWarnings", label: n.quotaWarnings, hint: n.quotaWarningsHint },
    { key: "emailAlerts", label: n.emailAlerts, hint: n.emailAlertsHint },
  ];

  return (
    <div className="space-y-4">
      <ThemeCard t={t} />

      <Card>
        <CardHeader>
          <CardTitle>{p.language}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-[var(--fp-text-2)]">{p.languageHint}</p>
          <div className="flex gap-2">
            {LOCALES.map((l) => (
              <Button
                key={l}
                size="sm"
                variant={locale === l ? "primary" : "secondary"}
                onClick={() => setLocaleClient(l)}
              >
                {l === "ar" ? "العربية" : "English"}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{p.timezone}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-[var(--fp-text-2)]">{p.timezoneHint}</p>
          <div className="flex items-center gap-3">
            <select
              value={timezone}
              onChange={(e) => void saveTimezone(e.target.value)}
              className="w-full max-w-xs rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-3 py-2 text-sm text-[var(--fp-text)]"
              aria-label={p.timezone}
            >
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            {tzSaving ? <Spinner /> : <Msg text={tzMsg} tone="info" />}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{p.personal}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-[var(--fp-text-2)]">{p.personalHint}</p>
          {loading ? (
            <Spinner label={t.common.loading} className="py-4" />
          ) : !me ? (
            <p className="text-sm text-[var(--fp-text-2)]">{t.common.retry}</p>
          ) : (
            personalRows.map((r) => (
              <Row key={r.key} label={r.label} hint={r.hint}>
                <Toggle checked={prefs[r.key]} onChange={(v) => void updatePref(r.key, v)} label={r.label} />
              </Row>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{n.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-[var(--fp-text-2)]">{n.hint}</p>
          {alertsLoading ? (
            <Spinner label={t.common.loading} className="py-4" />
          ) : (
            <>
              {alertRows.map((r) => (
                <Row key={r.key} label={r.label} hint={r.hint}>
                  <Toggle
                    checked={alerts[r.key]}
                    onChange={(v) => setAlerts({ ...alerts, [r.key]: v })}
                    label={r.label}
                    disabled={!canEditAlerts}
                  />
                </Row>
              ))}
              <div className="flex items-center gap-3 pt-1">
                <Button size="sm" onClick={() => void saveAlerts()} loading={alertsSaving} disabled={!canEditAlerts}>
                  {n.save}
                </Button>
                <Msg text={alertsMsg} tone="info" />
                {!canEditAlerts && <span className="text-xs text-[var(--fp-text-2)]">{n.restricted}</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
