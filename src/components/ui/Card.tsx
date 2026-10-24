"use client";

import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {}

export function Card({ className = "", children, ...rest }: CardProps) {
  return (
    <div
      className={`bg-[var(--fp-card)] border border-[var(--fp-border)] rounded-2xl shadow-card ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className = "", children, ...rest }: CardProps) {
  return (
    <div className={`px-5 pt-5 pb-3 ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({ className = "", children, ...rest }: CardProps) {
  return (
    <h3 className={`text-base font-semibold text-[var(--fp-text)] ${className}`} {...rest}>
      {children}
    </h3>
  );
}

export function CardContent({ className = "", children, ...rest }: CardProps) {
  return (
    <div className={`px-5 pb-5 ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function CardDescription({ children }: { children: ReactNode }) {
  return <p className="text-sm text-[var(--fp-text-2)] mt-1">{children}</p>;
}
