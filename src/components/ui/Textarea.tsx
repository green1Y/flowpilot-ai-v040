"use client";

import { useId, type TextareaHTMLAttributes } from "react";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export function Textarea({ label, error, hint, id, className = "", rows = 4, ...rest }: TextareaProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-[var(--fp-text)] mb-1.5">
          {label}
        </label>
      )}
      <textarea
        id={inputId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`w-full rounded-xl bg-[var(--fp-bg-2)] border text-[var(--fp-text)] placeholder:text-[var(--fp-text-2)] px-3.5 py-2.5 text-sm transition-colors focus:border-[var(--fp-accent)] focus:outline-none resize-y ${
          error ? "border-[#FB7185]" : "border-[var(--fp-border)]"
        } ${className}`}
        {...rest}
      />
      {error && (
        <p id={errorId} className="mt-1.5 text-xs text-[#FB7185]" role="alert">
          {error}
        </p>
      )}
      {!error && hint && <p className="mt-1.5 text-xs text-[var(--fp-text-2)]">{hint}</p>}
    </div>
  );
}
