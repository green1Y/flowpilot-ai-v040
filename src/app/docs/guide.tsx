import Link from "next/link";
import type { ReactNode } from "react";
import { getLocale } from "@/i18n/server";
import { en as docsEn, ar as docsAr } from "@/i18n/fragments/docs";
import { GUIDE_ORDER, GUIDE_FRAGMENT_KEY, type GuideSlug } from "./guides";
import { DocsChrome } from "./DocsChrome";

/**
 * Shared guide renderer for /docs (Phase 4).
 * Guide bodies are written in English (the canonical ops language); the docs
 * chrome (nav, titles, descriptions) is localized via src/i18n/fragments/docs.ts.
 */

export type Block =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; code: string }
  | { kind: "note"; title: string; text: string }
  | { kind: "table"; head: string[]; rows: string[][] };

export interface GuideSection {
  heading: string;
  blocks: Block[];
}

export interface GuideMeta {
  slug: string;
  title: string;
  desc: string;
  updated: string;
  sections: GuideSection[];
  prev?: { slug: string; title: string };
  next?: { slug: string; title: string };
  related?: { slug: string; title: string }[];
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "p":
      return <p className="text-[15px] leading-7 text-[var(--fp-text-2)]">{block.text}</p>;
    case "ul":
      return (
        <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-7 text-[var(--fp-text-2)]">
          {block.items.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-7 text-[var(--fp-text-2)]">
          {block.items.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-xl border border-[var(--fp-border)] bg-[#0B1020] p-4 text-[13px] leading-6 text-[#C4B5FD]">
          <code>{block.code}</code>
        </pre>
      );
    case "note":
      return (
        <div className="rounded-xl border border-[#22D3EE]/30 bg-[#22D3EE]/5 px-4 py-3">
          <div className="text-sm font-semibold text-[var(--fp-text)]">{block.title}</div>
          <p className="mt-1 text-sm leading-6 text-[var(--fp-text-2)]">{block.text}</p>
        </div>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-xl border border-[var(--fp-border)]">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--fp-border)] bg-[var(--fp-bg)]">
                {block.head.map((h, n) => (
                  <th key={n} className="px-4 py-2.5 font-semibold text-[var(--fp-text)]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, n) => (
                <tr key={n} className="border-b border-[var(--fp-border)] last:border-0">
                  {r.map((c, m) => (
                    <td key={m} className="px-4 py-2.5 text-[var(--fp-text-2)]">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export default async function Guide({
  meta,
  backLabel,
  updatedLabel,
  prevLabel,
  nextLabel,
  relatedLabel,
}: {
  meta: GuideMeta;
  backLabel: string;
  updatedLabel: string;
  prevLabel: string;
  nextLabel: string;
  relatedLabel: string;
}) {
  return (
    <article>
      <Link
        href="/docs"
        className="text-sm font-medium text-[var(--fp-accent-2)] hover:underline"
      >
        ← {backLabel}
      </Link>
      <h1 className="mt-3 text-3xl font-bold text-[var(--fp-text)]">{meta.title}</h1>
      <p className="mt-2 text-[15px] text-[var(--fp-text-2)]">{meta.desc}</p>
      <p className="mt-1 text-xs text-[var(--fp-text-2)]">
        {updatedLabel}: {meta.updated}
      </p>

      <div className="mt-8 space-y-10">
        {meta.sections.map((s, i) => (
          <section key={i}>
            <h2 className="mb-3 text-xl font-semibold text-[var(--fp-text)]">{s.heading}</h2>
            <div className="space-y-4">
              {s.blocks.map((b, n) => (
                <BlockView key={n} block={b} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {(meta.prev || meta.next) && (
        <nav className="mt-12 grid gap-3 border-t border-[var(--fp-border)] pt-6 sm:grid-cols-2">
          {meta.prev ? (
            <Link
              href={`/docs/${meta.prev.slug}`}
              className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-4 hover:border-[var(--fp-accent)]/40"
            >
              <div className="text-xs text-[var(--fp-text-2)]">{prevLabel}</div>
              <div className="mt-1 text-sm font-semibold text-[var(--fp-text)]">← {meta.prev.title}</div>
            </Link>
          ) : (
            <span />
          )}
          {meta.next && (
            <Link
              href={`/docs/${meta.next.slug}`}
              className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-4 text-right hover:border-[var(--fp-accent)]/40"
            >
              <div className="text-xs text-[var(--fp-text-2)]">{nextLabel}</div>
              <div className="mt-1 text-sm font-semibold text-[var(--fp-text)]">{meta.next.title} →</div>
            </Link>
          )}
        </nav>
      )}

      {meta.related && meta.related.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-[var(--fp-text)]">{relatedLabel}</h3>
          <ul className="mt-2 space-y-1">
            {meta.related.map((r) => (
              <li key={r.slug}>
                <Link href={`/docs/${r.slug}`} className="text-sm text-[var(--fp-accent-2)] hover:underline">
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

export async function GuideShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-3xl">{children}</div>;
}

/**
 * Full page wrapper for a guide: resolves locale, builds prev/next from the
 * guide registry, wraps in DocsChrome. Each guide page.tsx only defines content.
 */
export async function GuidePage({
  slug,
  title,
  desc,
  updated,
  sections,
  related,
}: {
  slug: GuideSlug;
  title: string;
  desc: string;
  updated: string;
  sections: GuideSection[];
  related?: { slug: string; title: string }[];
}) {
  const locale = await getLocale();
  const t = locale === "ar" ? docsAr : docsEn;
  const guides = t.guides as Record<string, { title: string }>;
  const i = GUIDE_ORDER.indexOf(slug);
  const prevSlug = i > 0 ? GUIDE_ORDER[i - 1] : undefined;
  const nextSlug = i < GUIDE_ORDER.length - 1 ? GUIDE_ORDER[i + 1] : undefined;
  const meta: GuideMeta = {
    slug,
    title,
    desc,
    updated,
    sections,
    prev: prevSlug
      ? { slug: prevSlug, title: guides[GUIDE_FRAGMENT_KEY[prevSlug]].title }
      : undefined,
    next: nextSlug
      ? { slug: nextSlug, title: guides[GUIDE_FRAGMENT_KEY[nextSlug]].title }
      : undefined,
    related,
  };
  return (
    <DocsChrome activeSlug={slug}>
      <GuideShell>
        <Guide
          meta={meta}
          backLabel={t.backToDocs}
          updatedLabel={t.lastUpdated}
          prevLabel={t.prevGuide}
          nextLabel={t.nextGuide}
          relatedLabel={t.related}
        />
      </GuideShell>
    </DocsChrome>
  );
}
