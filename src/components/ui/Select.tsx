"use client";

import { useId, type SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
}

export function Select({ label, error, options, placeholder, id, className = "", ...rest }: SelectProps) {
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
      <select
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`w-full rounded-xl bg-[var(--fp-bg-2)] border text-[var(--fp-text)] px-3.5 py-2.5 text-sm transition-colors focus:border-[var(--fp-accent)] focus:outline-none appearance-none cursor-pointer ${
          error ? "border-[#FB7185]" : "border-[var(--fp-border)]"
        } ${className}`}
        {...rest}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={errorId} className="mt-1.5 text-xs text-[#FB7185]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
