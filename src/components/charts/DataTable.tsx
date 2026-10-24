"use client";

import type { ReactNode } from "react";

export interface TableColumn<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  align?: "left" | "right";
}

export interface DataTableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  emptyMessage?: string;
  rowKey: (row: T) => string;
}

export function DataTable<T>({ columns, rows, emptyMessage, rowKey }: DataTableProps<T>) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-[var(--fp-text-2)]">{emptyMessage ?? "No rows in this range."}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--fp-border)] text-xs uppercase tracking-wide text-[var(--fp-text-2)]">
            {columns.map((c) => (
              <th key={c.key} className={`py-2 pr-4 last:pr-0 ${c.align === "right" ? "text-right" : ""}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-[var(--fp-border)] last:border-0">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`py-2.5 pr-4 last:pr-0 text-[var(--fp-text)] ${c.align === "right" ? "text-right" : ""}`}
                >
                  {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
