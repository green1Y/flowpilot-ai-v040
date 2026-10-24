"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

export type AlertVariant = "success" | "warning" | "danger" | "info";

const config: Record<
  AlertVariant,
  { icon: LucideIcon; box: string; iconClass: string }
> = {
  success: {
    icon: CheckCircle2,
    box: "border-success/30 bg-success/10",
    iconClass: "text-success",
  },
  warning: {
    icon: AlertTriangle,
    box: "border-warning/30 bg-warning/10",
    iconClass: "text-warning",
  },
  danger: {
    icon: XCircle,
    box: "border-danger/30 bg-danger/10",
    iconClass: "text-danger",
  },
  info: {
    icon: Info,
    box: "border-info/30 bg-info/10",
    iconClass: "text-info",
  },
};

export interface AlertProps {
  variant?: AlertVariant;
  /** Bold lead-in text. */
  title?: string;
  /** Body content. */
  children?: ReactNode;
  /** Optional action (e.g. a Button) rendered on the right. */
  action?: ReactNode;
  /** Shows a dismiss button; hides the alert on click. */
  dismissible?: boolean;
  onDismiss?: () => void;
  className?: string;
}

/** Semantic inline alert — success / warning / danger / info. */
export function Alert({
  variant = "info",
  title,
  children,
  action,
  dismissible = false,
  onDismiss,
  className = "",
}: AlertProps) {
  const [visible, setVisible] = useState(true);
  const c = config[variant];
  const Icon = c.icon;

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    onDismiss?.();
  };

  return (
    <div
      role={variant === "danger" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${c.box} ${className}`}
    >
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${c.iconClass}`} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        {title && (
          <p className="font-semibold text-[var(--fp-text)]">{title}</p>
        )}
        {children && (
          <div className={`text-[var(--fp-text-2)] ${title ? "mt-0.5" : ""}`}>
            {children}
          </div>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
      {dismissible && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-lg p-1 text-[var(--fp-text-2)] transition-colors hover:bg-[var(--fp-bg-2)] hover:text-[var(--fp-text)]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
