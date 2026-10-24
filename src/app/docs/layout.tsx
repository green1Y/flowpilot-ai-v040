/**
 * Docs layout (Phase 4) — intentionally a pass-through.
 *
 * The /docs landing page is owned by the SEO workstream (its own chrome via
 * PublicPage). Guide pages render their own chrome through DocsChrome so the
 * two never double-wrap each other.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
