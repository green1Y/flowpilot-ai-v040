/**
 * Shared CSV cell helpers (v0.4.0).
 * Formula-injection neutralization: any cell whose raw value starts with
 * = + - @ | or % is prefixed with a single quote before CSV quoting, so a
 * spreadsheet never executes user-entered content as a formula.
 * Lives here (not in a route file) because Next.js route modules may only
 * export route handlers — exporting a helper from a route.ts breaks the
 * production build ("not a valid Route export field").
 */
export function neutralizeCell(v: string | number | null | undefined): string {
  const s = String(v ?? "");
  if (/^[=+\-@|%]/.test(s)) return `'${s}`;
  return s;
}

/** Quote a CSV cell when it contains a comma, quote, or newline. */
export function csvCell(v: string | number | null | undefined): string {
  const s = neutralizeCell(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
