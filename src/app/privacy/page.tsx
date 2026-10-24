import type { Metadata } from "next";
import { getLocale } from "@/i18n/server";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { PublicPage } from "@/components/public/PublicPage";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.privacy;
  return pageMeta("/privacy", locale, m.title, m.description);
}

const sections = [
  {
    h: "What we collect",
    p: "Account information you provide (name, email, workspace details), the content you create in the product (workflows, contacts, messages, knowledge base documents), and integration credentials you connect (stored encrypted). We do not sell personal data.",
  },
  {
    h: "How we use it",
    p: "To operate your workspace: run automations, deliver messages through channels you connect, and show analytics. AI features process message content only to generate the responses you configure, under your workspace's approval settings.",
  },
  {
    h: "Data retention & deletion",
    p: "Retention periods are configurable per workspace in Settings. You can export or delete workspace data at any time; deletion removes contacts, conversations, workflows, and credentials associated with the workspace.",
  },
  {
    h: "Third parties",
    p: "When you connect a channel (for example WhatsApp or Instagram), data flows to that provider under their terms and your configured permissions. We request least-privilege scopes and never mark an integration connected until verification succeeds.",
  },
  {
    h: "Contact",
    p: "For privacy questions or deletion requests, contact your workspace owner or administrator.",
  },
];

export default function PrivacyPage() {
  return (
    <PublicPage>
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold text-[var(--fp-text)]">Privacy Policy</h1>
        <p className="mt-3 text-sm text-[var(--fp-text-2)]">
          Starter policy for development and evaluation builds. Review with counsel before production use.
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
