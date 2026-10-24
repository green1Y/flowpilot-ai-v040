"use client";

/**
 * Builder toolbar: editable name, autosave status, readiness indicator,
 * undo/redo, Test/Simulate/Runs, copilot toggle, Simple/Advanced toggle,
 * activate/deactivate (blocked on errors), settings menu.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Undo2, Redo2, Settings, Sparkles, FlaskConical, Play, History, LayoutList,
  Workflow as WorkflowIcon, Check, CircleAlert, TriangleAlert, Loader2, CloudOff,
  ChevronDown, Wrench,
} from "lucide-react";
import type { WorkflowMeta, SaveState } from "./types";
import type { ReadinessReport } from "@/lib/workflows/readiness";
import { useBuilderLocale, fmt } from "./i18n";
import { StatusBadge } from "../../components";

export interface ToolbarProps {
  meta: WorkflowMeta | null;
  saveState: SaveState;
  onRename: (name: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  readiness: ReadinessReport;
  onFixIssue: (nodeId?: string) => void;
  onValidate: () => void;
  onTest: () => void;
  onSimulate: () => void;
  onRuns: () => void;
  copilotOpen: boolean;
  onToggleCopilot: () => void;
  simpleMode: boolean;
  onToggleSimple: () => void;
  busy: string | null;
  onSaveDraft: () => void;
  onToggleActive: () => void;
  onOpenTemplates: () => void;
  onOpenDescription: () => void;
  onOpenShortcuts: () => void;
  onAutoLayout: () => void;
  onFitView: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function BuilderToolbar(p: ToolbarProps) {
  const { t, rtl } = useBuilderLocale();
  const b = t.builder;
  const [name, setName] = useState(p.meta?.name ?? "");
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const issuesRef = useRef<HTMLDivElement>(null);

  useEffect(() => setName(p.meta?.name ?? ""), [p.meta?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
      if (issuesRef.current && !issuesRef.current.contains(e.target as Node)) setIssuesOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const saveText =
    p.saveState === "idle" ? b.autosave.idle
    : p.saveState === "saving" ? b.autosave.saving
    : p.saveState === "saved" ? b.autosave.saved
    : p.saveState === "error" ? b.autosave.error
    : b.autosave.conflict;

  const errCount = p.readiness.errors.length;
  const warnCount = p.readiness.warnings.length;
  const isActive = p.meta?.status === "PUBLISHED";

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-[var(--fp-border)] bg-[var(--fp-card)] px-4 py-2.5">
      <nav className="flex items-center gap-2 text-sm text-[var(--fp-text-2)]">
        <Link href="/app/automations" className="hover:text-[var(--fp-text)] focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)] rounded">
          {b.back}
        </Link>
        <span aria-hidden>/</span>
      </nav>
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          p.onRename(e.target.value);
        }}
        aria-label="Workflow name"
        dir={rtl ? "rtl" : "ltr"}
        className="w-56 rounded-lg border border-transparent bg-transparent px-2 py-1 font-semibold outline-none hover:border-[var(--fp-border)] focus:border-[var(--fp-accent)]"
      />
      {p.meta && <StatusBadge status={p.meta.status} />}
      <span className="text-xs text-[var(--fp-text-2)]">{p.meta ? `v${p.meta.version}` : ""}</span>

      {/* Autosave indicator */}
      <span
        className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
          p.saveState === "error" || p.saveState === "conflict"
            ? "bg-red-500/15 text-red-300"
            : p.saveState === "saving"
              ? "bg-sky-500/15 text-sky-300"
              : "bg-white/5 text-[var(--fp-text-2)]"
        }`}
        role="status"
        aria-live="polite"
        title={saveText}
      >
        {p.saveState === "saving" ? (
          <Loader2 size={12} className="animate-spin" />
        ) : p.saveState === "error" || p.saveState === "conflict" ? (
          <CloudOff size={12} />
        ) : (
          <Check size={12} />
        )}
        {saveText}
      </span>

      {/* Readiness indicator */}
      <div className="relative" ref={issuesRef}>
        <button
          onClick={() => setIssuesOpen(!issuesOpen)}
          aria-expanded={issuesOpen}
          aria-label="Validation issues"
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)] ${
            errCount > 0
              ? "bg-red-500/15 text-red-300"
              : warnCount > 0
                ? "bg-amber-500/15 text-amber-300"
                : "bg-emerald-500/15 text-emerald-300"
          }`}
        >
          {errCount > 0 ? (
            <CircleAlert size={12} />
          ) : warnCount > 0 ? (
            <TriangleAlert size={12} />
          ) : (
            <Check size={12} />
          )}
          {errCount > 0
            ? fmt(b.readiness.errors, { n: errCount, s: errCount === 1 ? "" : "s" })
            : warnCount > 0
              ? fmt(b.readiness.warnings, { n: warnCount, s: warnCount === 1 ? "" : "s" })
              : b.readiness.ready}
          <ChevronDown size={12} />
        </button>
        {issuesOpen && (
          <div className="absolute start-0 top-full z-40 mt-2 max-h-80 w-96 overflow-y-auto rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-3 shadow-2xl">
            {errCount === 0 && warnCount === 0 ? (
              <p className="p-2 text-sm text-emerald-300">{b.readiness.noIssues}</p>
            ) : (
              <ul className="space-y-1.5">
                {p.readiness.errors.map((e, i) => (
                  <IssueRow key={`e${i}`} message={e.message} severity="error" fixNodeId={e.fixNodeId} onFix={p.onFixIssue} fixLabel={b.readiness.fix} />
                ))}
                {p.readiness.warnings.map((w, i) => (
                  <IssueRow key={`w${i}`} message={w.message} severity="warning" fixNodeId={w.fixNodeId} onFix={p.onFixIssue} fixLabel={b.readiness.fix} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="ms-auto flex flex-wrap items-center gap-1.5">
        <button onClick={p.onUndo} title={b.undo} aria-label={b.undo} disabled={!p.canUndo} className="rounded-lg p-2 hover:bg-white/5 disabled:opacity-30 focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)]">
          <Undo2 size={16} />
        </button>
        <button onClick={p.onRedo} title={b.redo} aria-label={b.redo} disabled={!p.canRedo} className="rounded-lg p-2 hover:bg-white/5 disabled:opacity-30 focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)]">
          <Redo2 size={16} />
        </button>

        <button onClick={p.onValidate} className="rounded-lg bg-white/5 px-3 py-1.5 text-sm font-medium hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)]">
          {b.validate}
        </button>
        <button onClick={p.onTest} className="flex items-center gap-1 rounded-lg bg-white/5 px-3 py-1.5 text-sm font-medium hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)]">
          <FlaskConical size={14} /> {b.test}
        </button>
        <button onClick={p.onSimulate} className="flex items-center gap-1 rounded-lg bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-300 hover:bg-sky-500/25 focus:outline-none focus:ring-2 focus:ring-sky-400">
          <Play size={14} /> {b.simulate}
        </button>
        <button onClick={p.onRuns} className="flex items-center gap-1 rounded-lg bg-white/5 px-3 py-1.5 text-sm font-medium hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)]">
          <History size={14} /> {b.runs}
        </button>
        <button
          onClick={p.onToggleCopilot}
          aria-pressed={p.copilotOpen}
          className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)] ${
            p.copilotOpen ? "bg-[var(--fp-accent)]/30 text-white" : "bg-violet-500/15 text-violet-300 hover:bg-violet-500/25"
          }`}
        >
          <Sparkles size={14} /> {t.copilot.title}
        </button>
        <button
          onClick={p.onToggleSimple}
          aria-pressed={p.simpleMode}
          title={p.simpleMode ? b.advancedMode : b.simpleMode}
          className="flex items-center gap-1 rounded-lg bg-white/5 px-3 py-1.5 text-sm font-medium hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)]"
        >
          {p.simpleMode ? <WorkflowIcon size={14} /> : <LayoutList size={14} />}
          {p.simpleMode ? b.advancedMode : b.simpleMode}
        </button>

        <button onClick={p.onSaveDraft} disabled={p.busy === "save"} className="rounded-lg bg-white/5 px-3 py-1.5 text-sm font-medium hover:bg-white/10 disabled:opacity-50">
          {p.busy === "save" ? b.saving : b.saveDraft}
        </button>

        {isActive ? (
          <button onClick={p.onToggleActive} disabled={p.busy === "pause"} title={b.deactivateHint} className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-sm font-medium text-amber-300 hover:bg-amber-500/30 disabled:opacity-50">
            {b.pause}
          </button>
        ) : (
          <button
            onClick={p.onToggleActive}
            disabled={p.busy === "publish"}
            title={errCount > 0 ? b.activateBlocked : b.activateConfirmHint}
            className="btn-gradient rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {p.busy === "publish" ? b.publishing : b.publish}
          </button>
        )}

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-label={b.settings}
            className="rounded-lg p-2 hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)]"
          >
            <Settings size={16} />
          </button>
          {menuOpen && (
            <div className="absolute end-0 top-full z-40 mt-2 w-60 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-2 shadow-2xl">
              <MenuItem label={b.editDescription} onClick={() => { setMenuOpen(false); p.onOpenDescription(); }} />
              <MenuItem label={b.templates} onClick={() => { setMenuOpen(false); p.onOpenTemplates(); }} />
              <MenuItem label={b.autoLayout} onClick={() => { setMenuOpen(false); p.onAutoLayout(); }} />
              <MenuItem label="Fit to screen" onClick={() => { setMenuOpen(false); p.onFitView(); }} />
              <MenuItem label={b.shortcuts} onClick={() => { setMenuOpen(false); p.onOpenShortcuts(); }} />
              <div className="my-1 border-t border-[var(--fp-border)]" />
              <MenuItem label={b.duplicate} onClick={() => { setMenuOpen(false); p.onDuplicate(); }} />
              <MenuItem label={b.deleteWorkflow} danger onClick={() => { setMenuOpen(false); p.onDelete(); }} />
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)] ${
        danger ? "text-red-300" : ""
      }`}
    >
      {danger ? <CircleAlert size={14} /> : <Wrench size={14} className="opacity-50" />}
      {label}
    </button>
  );
}

function IssueRow({ message, severity, fixNodeId, onFix, fixLabel }: { message: string; severity: "error" | "warning"; fixNodeId?: string; onFix: (nodeId?: string) => void; fixLabel: string }) {
  return (
    <li
      className={`flex items-start justify-between gap-2 rounded-xl border p-2.5 text-xs ${
        severity === "error" ? "border-red-500/25 bg-red-500/5 text-red-200" : "border-amber-500/25 bg-amber-500/5 text-amber-100"
      }`}
    >
      <span className="flex-1">{message}</span>
      {fixNodeId && (
        <button
          onClick={() => onFix(fixNodeId)}
          className="shrink-0 rounded-lg bg-white/10 px-2 py-1 font-medium hover:bg-white/20"
        >
          {fixLabel}
        </button>
      )}
    </li>
  );
}
