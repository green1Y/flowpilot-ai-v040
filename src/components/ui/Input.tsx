"use client";

import { useId, type InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  /** Optional element rendered inside the input's right edge (e.g. a password visibility toggle). */
  trailing?: React.ReactNode;
}

export function Input({ label, error, hint, trailing, id, className = "", ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-[var(--fp-text)] mb-1.5"
        >
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`w-full rounded-xl bg-[var(--fp-bg-2)] border text-[var(--fp-text)] placeholder:text-[var(--fp-text-2)] px-3.5 py-2.5 text-sm transition-colors focus:border-[var(--fp-accent)] focus:outline-none ${
            error ? "border-[#FB7185]" : "border-[var(--fp-border)]"
          } ${trailing ? "pr-11" : ""} ${className}`}
          {...rest}
        />
        {trailing && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center">
            {trailing}
          </div>
        )}
      </div>
      {error && (
        <p id={errorId} className="mt-1.5 text-xs text-[#FB7185]" role="alert">
          {error}
        </p>
      )}
      {!error && hint && <p className="mt-1.5 text-xs text-[var(--fp-text-2)]">{hint}</p>}
    </div>
  );
}
