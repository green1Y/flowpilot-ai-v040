import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getLocale } from "@/i18n/server";
import { en, ar } from "@/i18n/fragments/docs";
import { GUIDE_ORDER, GUIDE_FRAGMENT_KEY } from "../guides";
import { DocsChrome } from "../DocsChrome";

/** Guide index for the Phase 4 docs (the /docs landing page itself is owned by the SEO workstream). */
export const metadata = { title: "All guides — FlowPilot AI Docs" };

export default async function GuidesIndex() {
  const locale = await getLocale();
  const t = locale === "ar" ? ar : en;
  const guides = t.guides as Record<string, { title: string; desc: string }>;

  return (
    <DocsChrome>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold text-[var(--fp-text)]">{t.docsHome}</h1>
        <p className="mt-2 text-[15px] text-[var(--fp-text-2)]">{t.tagline}</p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {GUIDE_ORDER.map((slug) => {
            const g = guides[GUIDE_FRAGMENT_KEY[slug]];
            return (
              <Link
                key={slug}
                href={`/docs/${slug}`}
                className="group rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-5 transition hover:border-[var(--fp-accent)]/50"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-[var(--fp-text)] group-hover:text-[var(--fp-accent-2)]">
                    {g.title}
                  </h2>
                  <ArrowRight
                    className="h-4 w-4 text-[var(--fp-text-2)] transition group-hover:translate-x-0.5 group-hover:text-[var(--fp-accent-2)]"
                    aria-hidden
                  />
                </div>
                <p className="mt-1.5 text-sm leading-6 text-[var(--fp-text-2)]">{g.desc}</p>
              </Link>
            );
          })}
        </div>

        <div className="mt-8 rounded-2xl border border-[#22D3EE]/30 bg-[#22D3EE]/5 px-5 py-4">
          <div className="text-sm font-semibold text-[var(--fp-text)]">{t.honestyNote}</div>
          <p className="mt-1 text-sm leading-6 text-[var(--fp-text-2)]">
            Every guide says plainly what is verified, what is simulated, and what has never been
            live-tested. Features labeled <em>simulated</em> or <em>mock-backed</em> do not perform
            the real action — they are clearly marked in the product too.
          </p>
        </div>
      </div>
    </DocsChrome>
  );
}
