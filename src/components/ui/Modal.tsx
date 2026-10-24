"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
}

export function Modal({ open, onClose, title, children, footer, maxWidth = "max-w-lg" }: ModalProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fp-modal-title"
    >
      <button
        aria-label="Close dialog"
        className="absolute inset-0 bg-[var(--fp-overlay)] backdrop-blur-sm cursor-default"
        onClick={onClose}
      />
      <div
        className={`relative flex w-full ${maxWidth} max-h-dvh sm:max-h-[90vh] flex-col overflow-hidden bg-[var(--fp-card)] border border-[var(--fp-border)] rounded-none sm:rounded-2xl shadow-card max-sm:min-h-dvh`}
      >
        <div className="flex shrink-0 items-center justify-between px-5 py-4 border-b border-[var(--fp-border)]">
          <h2
            id="fp-modal-title"
            ref={titleRef}
            tabIndex={-1}
            className="text-base font-semibold text-[var(--fp-text)] focus:outline-none"
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-[var(--fp-text-2)] hover:text-[var(--fp-text)] hover:bg-[var(--fp-bg-2)] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="px-5 py-4 border-t border-[var(--fp-border)] flex shrink-0 justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
