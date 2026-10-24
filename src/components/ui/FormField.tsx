"use client";

import { useId, type ReactNode } from "react";

export interface FormFieldProps {
  /** Label text (or node). Pairs with `htmlFor` when the child control has an id. */
  label?: ReactNode;
  /** Id of the wrapped control; falls back to an auto-generated id. */
  htmlFor?: string;
  /** Helper text shown under the control when there is no error. */
  hint?: ReactNode;
  /** Error text shown under the control (role="alert"). */
  error?: string;
  /** Shows a required asterisk next to the label. */
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Generic form-field wrapper for custom controls (checkboxes, radios,
 * toggles, date pickers, …). Native Input / Select / Textarea already
 * render their own label + error + hint — use FormField for everything else
 * so labels, hints, and errors stay visually and semantically consistent.
 */
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  className = "",
  children,
}: FormFieldProps) {
  const autoId = useId();
  const fieldId = htmlFor ?? autoId;
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  return (
    <div className={`w-full ${className}`}>
      {label && (
        <label
          htmlFor={htmlFor ? fieldId : undefined}
          className="mb-1.5 block text-sm font-medium text-[var(--fp-text)]"
        >
          {label}
          {required && (
            <span aria-hidden className="ml-1 text-danger">
              *
            </span>
          )}
          {required && <span className="sr-only">(required)</span>}
        </label>
      )}
      {children}
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
      {!error && hint && (
        <p id={hintId} className="mt-1.5 text-xs text-[var(--fp-text-2)]">
          {hint}
        </p>
      )}
    </div>
  );
}
