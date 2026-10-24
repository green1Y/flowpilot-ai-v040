"use client";

import type { ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

interface TableScrollProps {
  className?: string;
  children: ReactNode;
}

/**
 * Horizontal-scroll wrapper for tables — keeps wide tables usable on mobile.
 * Also available as the `.table-scroll` CSS utility.
 */
export function TableScroll({ className = "", children }: TableScrollProps) {
  return (
    <div
      className={`table-scroll rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] shadow-subtle ${className}`}
    >
      {children}
    </div>
  );
}

interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  className?: string;
  children: ReactNode;
}

/** Semantic table with consistent FlowPilot styling. */
export function Table({ className = "", children, ...rest }: TableProps) {
  return (
    <table className={`w-full text-sm ${className}`} {...rest}>
      {children}
    </table>
  );
}

export function TableHead({
  className = "",
  children,
  ...rest
}: TableHTMLAttributes<HTMLTableSectionElement> & { children: ReactNode }) {
  return (
    <thead className={className} {...rest}>
      {children}
    </thead>
  );
}

export function TableBody({
  className = "",
  children,
  ...rest
}: TableHTMLAttributes<HTMLTableSectionElement> & { children: ReactNode }) {
  return (
    <tbody className={className} {...rest}>
      {children}
    </tbody>
  );
}

interface TableRowProps extends TableHTMLAttributes<HTMLTableRowElement> {
  className?: string;
  children: ReactNode;
  /** Adds the hover highlight for clickable / selectable rows. */
  hover?: boolean;
}

export function TableRow({ className = "", hover = false, children, ...rest }: TableRowProps) {
  return (
    <tr
      className={`border-b border-[var(--fp-border)] last:border-b-0 ${
        hover ? "transition-colors hover:bg-[var(--fp-bg-2)]" : ""
      } ${className}`}
      {...rest}
    >
      {children}
    </tr>
  );
}

interface TableHeaderCellProps extends ThHTMLAttributes<HTMLTableHeaderCellElement> {
  className?: string;
  children: ReactNode;
  /** Right-aligns numeric columns. */
  numeric?: boolean;
}

export function TableHeaderCell({
  className = "",
  numeric = false,
  children,
  ...rest
}: TableHeaderCellProps) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wider text-faint ${
        numeric ? "text-right" : "text-left"
      } ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
}

interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  className?: string;
  children: ReactNode;
  /** Right-aligns numeric columns. */
  numeric?: boolean;
}

export function TableCell({ className = "", numeric = false, children, ...rest }: TableCellProps) {
  return (
    <td
      className={`px-4 py-3 align-middle text-[var(--fp-text)] ${
        numeric ? "text-right tabular-nums" : ""
      } ${className}`}
      {...rest}
    >
      {children}
    </td>
  );
}
