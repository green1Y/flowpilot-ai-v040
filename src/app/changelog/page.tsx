import type { Metadata } from "next";
import { getLocale } from "@/i18n/server";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { PublicPage } from "@/components/public/PublicPage";
import { PageHero } from "@/components/public/PublicShell";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.changelog;
  return pageMeta("/changelog", locale, m.title, m.description);
}

export default async function ChangelogPage() {
  const p = seoT(await getLocale()).pages.changelog;
  const entries = [
    { d: p.e7d, t: p.e7t, b: [p.e7b1, p.e7b2, p.e7b3] },
    { d: p.e6d, t: p.e6t, b: [p.e6b1, p.e6b2, p.e6b3] },
    { d: p.e5d, t: p.e5t, b: [p.e5b1, p.e5b2] },
    { d: p.e4d, t: p.e4t, b: [p.e4b1, p.e4b2, p.e4b3] },
    { d: p.e3d, t: p.e3t, b: [p.e3b1, p.e3b2, p.e3b3] },
    { d: p.e2d, t: p.e2t, b: [p.e2b1, p.e2b2, p.e2b3] },
    { d: p.e1d, t: p.e1t, b: [p.e1b1, p.e1b2, p.e1b3] },
  ];
  return (
    <PublicPage>
      <PageHero eyebrow={p.eyebrow} title={p.title} lede={p.lede} />
      <section className="border-t border-[var(--fp-border)] py-14 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <ol className="relative space-y-8 before:absolute before:top-2 before:bottom-2 before:w-px before:bg-gradient-to-b before:from-[#8B5CF6] before:to-[#22D3EE] ltr:before:left-[5px] rtl:before:right-[5px]">
            {entries.map((e) => (
              <li key={e.t} className="relative ltr:pl-10 rtl:pr-10">
                <span
                  aria-hidden
                  className="absolute top-1.5 h-2.5 w-2.5 rounded-full bg-[#8B5CF6] shadow-glow ltr:left-0 rtl:right-0"
                />
                <article className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-6 shadow-card">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--fp-accent-2)]">
                    <time dateTime={e.d}>{e.d}</time>
                  </p>
                  <h2 className="mt-1.5 text-lg font-semibold text-[var(--fp-text)]">{e.t}</h2>
                  <ul className="mt-3 space-y-1.5">
                    {e.b.map((b) => (
                      <li key={b} className="text-sm leading-relaxed text-[var(--fp-text-2)]">
                        • {b}
                      </li>
                    ))}
                  </ul>
                </article>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </PublicPage>
  );
}
