import type { Metadata } from "next";
import { getLocale } from "@/i18n/server";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { PublicPage } from "@/components/public/PublicPage";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.terms;
  return pageMeta("/terms", locale, m.title, m.description);
}

const sections = [
  {
    h: "The service",
    p: "FlowPilot AI provides workflow automation, a unified inbox, and AI-assisted messaging across channels you connect. Features that depend on third-party platforms are subject to those platforms' terms and API limits.",
  },
  {
    h: "Acceptable use",
    p: "You may not use the service for unsolicited bulk messaging, spam, harassment, or to evade platform rate limits. Automated replies must respect each channel's messaging windows, template rules, and consent requirements. Accounts violating these rules may be suspended.",
  },
  {
    h: "AI features",
    p: "AI-generated replies are produced from your configured business knowledge and are labeled in execution logs. You are responsible for reviewing AI behavior, approval settings, and escalation rules for your workspace.",
  },
  {
    h: "Billing",
    p: "Paid plans are billed per the subscription terms shown at checkout. Usage limits are enforced per workspace; overages are handled according to your plan.",
  },
  {
    h: "Liability",
    p: "The service is provided as-is. To the maximum extent permitted by law, we are not liable for indirect damages, including messages delayed or blocked by third-party platforms.",
  },
];

export default function TermsPage() {
  return (
    <PublicPage>
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold text-[var(--fp-text)]">Terms of Service</h1>
        <p className="mt-3 text-sm text-[var(--fp-text-2)]">
          Starter terms for development and evaluation builds. Review with counsel before production use.
        </p>
        <div className="mt-10 space-y-8">
          {sections.map((s) => (
            <section key={s.h}>
              <h2 className="text-lg font-semibold text-[var(--fp-text)]">{s.h}</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--fp-text-2)]">{s.p}</p>
            </section>
          ))}
        </div>
      </div>
    </PublicPage>
  );
}
