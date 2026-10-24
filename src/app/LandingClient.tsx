"use client";

import {
  BarChart3,
  Check,
  ChevronDown,
  Inbox,
  Lock,
  Megaphone,
  Play,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useLocale } from "@/i18n/client";
import { seoAr, seoEn } from "@/i18n/fragments/seo";

function useSeo() {
  const locale = useLocale();
  return (locale === "ar" ? seoAr : seoEn).seo;
}

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl btn-gradient shadow-glow">
        <Zap className="h-5 w-5 text-white" aria-hidden />
      </div>
      <span className="text-lg font-bold text-[var(--fp-text)]">
        FlowPilot <span className="text-gradient">AI</span>
      </span>
    </Link>
  );
}

/* ---------------- Sticky nav ---------------- */
function Nav() {
  const t = useSeo();
  const [open, setOpen] = useState(false);
  const links = [
    { label: t.common.navFeatures, href: "/features" },
    { label: t.common.navIntegrations, href: "/integrations" },
    { label: t.common.navPricing, href: "/pricing" },
    { label: t.common.navFaq, href: "/faq" },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--fp-border)] bg-[var(--fp-bg)]/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav className="hidden md:flex items-center gap-8" aria-label="Primary">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-[var(--fp-text-2)] hover:text-[var(--fp-text)] transition-colors"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="hidden md:flex items-center gap-3">
          <Link
            href="/login"
            className="text-sm font-medium text-[var(--fp-text-2)] hover:text-[var(--fp-text)] transition-colors"
          >
            {t.common.signIn}
          </Link>
          <Link
            href="/signup"
            className="btn-gradient inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-white shadow-glow"
          >
            {t.common.startAutomating}
          </Link>
        </div>
        <button
          className="md:hidden p-2 text-[var(--fp-text)]"
          aria-label={open ? t.common.closeMenu : t.common.openMenu}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown className={`h-5 w-5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div className="md:hidden border-t border-[var(--fp-border)] px-4 py-3 space-y-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 text-sm text-[var(--fp-text-2)] hover:text-[var(--fp-text)] hover:bg-[var(--fp-bg-2)]"
            >
              {l.label}
            </Link>
          ))}
          <div className="flex gap-3 pt-2">
            <Link
              href="/login"
              className="flex-1 rounded-xl border border-[var(--fp-border)] px-4 py-2 text-center text-sm font-medium text-[var(--fp-text)]"
            >
              {t.common.signIn}
            </Link>
            <Link
              href="/signup"
              className="btn-gradient flex-1 rounded-xl px-4 py-2 text-center text-sm font-medium text-white"
            >
              {t.common.startAutomating}
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

/* ---------------- Hero + product mock ---------------- */
function ProductMock() {
  const t = useSeo().landing;
  // Decorative UI mockup (aria-hidden): placeholder numbers illustrate layout only.
  const nodes = [
    { label: t.mockNode1, icon: Inbox, tone: "border-[#8B5CF6]/40" },
    { label: t.mockNode2, icon: Sparkles, tone: "border-[#22D3EE]/40" },
    { label: t.mockNode3, icon: Workflow, tone: "border-[#34D399]/40" },
    { label: t.mockNode4, icon: Play, tone: "border-[#FBBF24]/40" },
  ];
  const stats = [
    { k: t.mockStat1, v: "1,248", d: "+18" },
    { k: t.mockStat2, v: "892", d: "+24" },
    { k: t.mockStat3, v: "214", d: "+31" },
  ];
  return (
    <div
      aria-hidden
      className="relative rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] shadow-card overflow-hidden"
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--fp-border)] px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#FB7185]/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#FBBF24]/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#34D399]/70" />
        <span className="ml-3 text-xs text-[var(--fp-text-2)]">{t.mockTitle}</span>
      </div>
      <div className="grid grid-cols-3 gap-3 p-4">
        {stats.map((s) => (
          <div key={s.k} className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3">
            <p className="text-[10px] uppercase tracking-wide text-[var(--fp-text-2)]">{s.k}</p>
            <p className="mt-1 text-xl font-bold text-[var(--fp-text)]">{s.v}</p>
            <p className="text-[10px] text-[#34D399]">
              {s.d}% {t.mockThisWeek}
            </p>
          </div>
        ))}
      </div>
      <div className="px-4 pb-4">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-[var(--fp-text-2)]">
          {t.mockLive}
        </p>
        <div className="flex items-center gap-1.5">
          {nodes.map((n, i) => {
            const Icon = n.icon;
            return (
              <div key={n.label} className="flex flex-1 items-center gap-1.5 min-w-0">
                <div
                  className={`flex flex-1 items-center gap-2 rounded-xl border ${n.tone} bg-[var(--fp-bg-2)] px-2.5 py-2`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--fp-accent-2)]" />
                  <span className="truncate text-[10px] font-medium text-[var(--fp-text)]">
                    {n.label}
                  </span>
                </div>
                {i < nodes.length - 1 && (
                  <div className="h-px w-2 shrink-0 bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Hero() {
  const t = useSeo().landing;
  const c = useSeo().common;
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(600px_circle_at_20%_10%,rgba(139,92,246,0.18),transparent_60%),radial-gradient(500px_circle_at_80%_20%,rgba(34,211,238,0.12),transparent_60%)]"
      />
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 pt-16 pb-12 sm:pt-24 sm:pb-16">
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-[var(--fp-border)] bg-[var(--fp-card)] px-3.5 py-1.5 text-xs font-medium text-[var(--fp-text-2)]">
            <Sparkles className="h-3.5 w-3.5 text-[var(--fp-accent)]" aria-hidden />
            {t.heroBadge}
          </span>
          <h1 className="mt-6 text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-[var(--fp-text)] leading-tight">
            {t.heroTitleA} <span className="text-gradient">{t.heroTitleB}</span>
            {t.heroTitleC} <span className="text-gradient">{t.heroTitleD}</span>
          </h1>
          <p className="mt-6 text-base sm:text-lg text-[var(--fp-text-2)] max-w-2xl mx-auto">
            {t.heroSubtitle}
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/signup"
              className="btn-gradient w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl px-7 py-3.5 text-base font-semibold text-white shadow-glow"
            >
              {t.heroCtaStart}
            </Link>
            <Link
              href="/features"
              className="w-full sm:w-auto inline-flex items-center justify-center rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] px-7 py-3.5 text-base font-semibold text-[var(--fp-text)] hover:border-[var(--fp-accent)] transition-colors"
            >
              {t.heroCtaExplore}
            </Link>
          </div>
        </div>
        <div className="mx-auto mt-12 max-w-4xl">
          <ProductMock />
        </div>
      </div>
    </section>
  );
}

/* ---------------- Integrations ---------------- */
const CHANNELS = [
  "Instagram",
  "Facebook",
  "WhatsApp",
  "Telegram",
  "TikTok",
  "YouTube",
  "LinkedIn",
  "X",
  "Email",
  "Webchat",
];

function Integrations() {
  const t = useSeo().landing;
  return (
    <section id="integrations" className="border-t border-[var(--fp-border)] py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <h2 className="text-center text-sm font-medium uppercase tracking-widest text-[var(--fp-text-2)]">
          {t.channelsEyebrow}
        </h2>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {CHANNELS.map((c) => (
            <span
              key={c}
              className="rounded-full border border-[var(--fp-border)] bg-[var(--fp-card)] px-5 py-2.5 text-sm font-medium text-[var(--fp-text)] hover:border-[var(--fp-accent)] transition-colors"
            >
              {c}
            </span>
          ))}
        </div>
        <p className="mx-auto mt-6 max-w-2xl text-center text-xs text-[var(--fp-text-2)]">
          {t.channelsNote}
        </p>
      </div>
    </section>
  );
}

/* ---------------- Features ---------------- */
function Features() {
  const t = useSeo().landing;
  const FEATURES = [
    { icon: Workflow, title: t.feature1Title, copy: t.feature1Copy },
    { icon: Sparkles, title: t.feature2Title, copy: t.feature2Copy },
    { icon: Inbox, title: t.feature3Title, copy: t.feature3Copy },
    { icon: Users, title: t.feature4Title, copy: t.feature4Copy },
    { icon: Megaphone, title: t.feature5Title, copy: t.feature5Copy },
    { icon: BarChart3, title: t.feature6Title, copy: t.feature6Copy },
  ];
  return (
    <section id="features" className="border-t border-[var(--fp-border)] bg-[var(--fp-bg-2)] py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-[var(--fp-text)]">
            {t.featuresEyebrow} <span className="text-gradient">{t.featuresEyebrowAccent}</span>
          </h2>
          <p className="mt-4 text-[var(--fp-text-2)]">{t.featuresSubtitle}</p>
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-6 shadow-card hover:border-[var(--fp-accent)] transition-colors"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-xl btn-gradient shadow-glow">
                  <Icon className="h-5 w-5 text-white" aria-hidden />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-[var(--fp-text)]">{f.title}</h3>
                <p className="mt-2 text-sm text-[var(--fp-text-2)] leading-relaxed">{f.copy}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Automation showcase ---------------- */
function Showcase() {
  const t = useSeo().landing;
  const steps = [
    { title: t.showcaseStep1Title, body: t.showcaseStep1Body, icon: Zap },
    { title: t.showcaseStep2Title, body: t.showcaseStep2Body, icon: Workflow },
    { title: t.showcaseStep3Title, body: t.showcaseStep3Body, icon: Sparkles },
    { title: t.showcaseStep4Title, body: t.showcaseStep4Body, icon: Play },
  ];
  return (
    <section className="border-t border-[var(--fp-border)] py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-[var(--fp-text)]">
            {t.showcaseEyebrow} <span className="text-gradient">{t.showcaseEyebrowAccent}</span>
          </h2>
          <p className="mt-4 text-[var(--fp-text-2)]">{t.showcaseSubtitle}</p>
        </div>
        <div className="mx-auto mt-12 max-w-3xl">
          {steps.map((s, i) => {
            const Icon = s.icon;
            return (
              <div key={s.title} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl btn-gradient shadow-glow shrink-0">
                    <Icon className="h-5 w-5 text-white" aria-hidden />
                  </div>
                  {i < steps.length - 1 && (
                    <div className="my-1 w-px flex-1 bg-gradient-to-b from-[#8B5CF6] to-[#22D3EE]" aria-hidden />
                  )}
                </div>
                <div className="pb-8">
                  <p className="text-sm font-semibold text-[var(--fp-text)]">
                    {i + 1}. {s.title}
                  </p>
                  <p className="mt-1 text-sm text-[var(--fp-text-2)]">{s.body}</p>
                </div>
              </div>
            );
          })}
          <div className="mt-2 text-center">
            <Link
              href="/signup"
              className="btn-gradient inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-white shadow-glow"
            >
              <Play className="h-4 w-4" aria-hidden />
              {t.showcaseCta}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Use cases ---------------- */
function UseCases() {
  const t = useSeo().landing;
  const USE_CASES = [
    {
      id: "ecommerce",
      label: t.tabEcommerce,
      title: t.ucEcommerceTitle,
      points: [t.ucEcommerce1, t.ucEcommerce2, t.ucEcommerce3],
    },
    {
      id: "agencies",
      label: t.tabAgencies,
      title: t.ucAgenciesTitle,
      points: [t.ucAgencies1, t.ucAgencies2, t.ucAgencies3],
    },
    {
      id: "smb",
      label: t.tabSmb,
      title: t.ucSmbTitle,
      points: [t.ucSmb1, t.ucSmb2, t.ucSmb3],
    },
  ];
  const [active, setActive] = useState(USE_CASES[0].id);
  const current = USE_CASES.find((u) => u.id === active) ?? USE_CASES[0];
  return (
    <section className="border-t border-[var(--fp-border)] bg-[var(--fp-bg-2)] py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-[var(--fp-text)]">
            {t.useCasesEyebrow} <span className="text-gradient">{t.useCasesEyebrowAccent}</span>
            {t.useCasesEyebrowEnd ? ` ${t.useCasesEyebrowEnd}` : ""}
          </h2>
        </div>
        <div className="mt-8 flex justify-center">
          <div
            role="tablist"
            aria-label={t.useCasesEyebrow}
            className="inline-flex gap-1 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-1"
          >
            {USE_CASES.map((u) => (
              <button
                key={u.id}
                role="tab"
                aria-selected={active === u.id}
                onClick={() => setActive(u.id)}
                className={`rounded-lg px-5 py-2.5 text-sm font-medium transition-all ${
                  active === u.id
                    ? "btn-gradient text-white shadow-glow"
                    : "text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
                }`}
              >
                {u.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mx-auto mt-8 max-w-2xl rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-8 shadow-card">
          <h3 className="text-xl font-semibold text-[var(--fp-text)]">{current.title}</h3>
          <ul className="mt-4 space-y-3">
            {current.points.map((p) => (
              <li key={p} className="flex items-start gap-3 text-sm text-[var(--fp-text-2)]">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#34D399]/15">
                  <Check className="h-3 w-3 text-[#34D399]" aria-hidden />
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Pricing teaser (limits from src/db/seed-plans.ts) ---------------- */
function Pricing() {
  const t = useSeo().landing;
  const TIERS = [
    {
      name: t.pricingStarterName,
      tagline: t.pricingStarterTag,
      cta: t.pricingCta,
      features: [t.pricingStarter1, t.pricingStarter2, t.pricingStarter3, t.pricingStarter4, t.pricingStarter5],
    },
    {
      name: t.pricingGrowthName,
      tagline: t.pricingGrowthTag,
      cta: t.pricingCta,
      popular: true,
      features: [t.pricingGrowth1, t.pricingGrowth2, t.pricingGrowth3, t.pricingGrowth4, t.pricingGrowth5],
    },
    {
      name: t.pricingAgencyName,
      tagline: t.pricingAgencyTag,
      cta: t.pricingCtaAgency,
      features: [t.pricingAgency1, t.pricingAgency2, t.pricingAgency3, t.pricingAgency4, t.pricingAgency5],
    },
  ];
  return (
    <section id="pricing" className="border-t border-[var(--fp-border)] py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-[var(--fp-text)]">
            {t.pricingEyebrow} <span className="text-gradient">{t.pricingEyebrowAccent}</span>
          </h2>
          <p className="mt-4 text-[var(--fp-text-2)]">{t.pricingSubtitle}</p>
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-3 max-w-5xl mx-auto">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`relative rounded-2xl border p-7 shadow-card ${
                tier.popular
                  ? "border-[#8B5CF6] bg-[var(--fp-card)]"
                  : "border-[var(--fp-border)] bg-[var(--fp-card)]"
              }`}
            >
              {tier.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full btn-gradient px-3 py-1 text-xs font-semibold text-white">
                  {t.pricingPopular}
                </span>
              )}
              <h3 className="text-lg font-semibold text-[var(--fp-text)]">{tier.name}</h3>
              <p className="mt-1 text-sm text-[var(--fp-text-2)]">{tier.tagline}</p>
              <ul className="mt-6 space-y-3">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-3 text-sm text-[var(--fp-text-2)]">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#22D3EE]" aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className={`mt-8 block rounded-xl px-4 py-2.5 text-center text-sm font-semibold transition-all ${
                  tier.popular
                    ? "btn-gradient text-white shadow-glow"
                    : "border border-[var(--fp-border)] text-[var(--fp-text)] hover:border-[var(--fp-accent)]"
                }`}
              >
                {tier.cta}
              </Link>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center">
          <Link
            href="/pricing"
            className="text-sm font-medium text-[var(--fp-accent-2)] hover:underline"
          >
            {t.pricingViewAll}
          </Link>
        </p>
      </div>
    </section>
  );
}

/* ---------------- FAQ ---------------- */
function Faq() {
  const t = useSeo().landing;
  const FAQS = [
    { q: t.faq1q, a: t.faq1a },
    { q: t.faq2q, a: t.faq2a },
    { q: t.faq3q, a: t.faq3a },
    { q: t.faq4q, a: t.faq4a },
    { q: t.faq5q, a: t.faq5a },
    { q: t.faq6q, a: t.faq6a },
  ];
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id="faq" className="border-t border-[var(--fp-border)] bg-[var(--fp-bg-2)] py-14 sm:py-20">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="text-center text-3xl sm:text-4xl font-bold text-[var(--fp-text)]">
          {t.faqEyebrow} <span className="text-gradient">{t.faqEyebrowAccent}</span>
        </h2>
        <div className="mt-10 space-y-3">
          {FAQS.map((f, i) => {
            const isOpen = open === i;
            return (
              <div
                key={f.q}
                className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] overflow-hidden"
              >
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left"
                >
                  <span className="text-sm sm:text-base font-medium text-[var(--fp-text)]">{f.q}</span>
                  <ChevronDown
                    className={`h-5 w-5 shrink-0 text-[var(--fp-text-2)] transition-transform ${isOpen ? "rotate-180" : ""}`}
                    aria-hidden
                  />
                </button>
                {isOpen && (
                  <p className="px-6 pb-5 text-sm text-[var(--fp-text-2)] leading-relaxed">{f.a}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Security ---------------- */
function Security() {
  const t = useSeo().landing;
  const items = [
    { icon: Lock, title: t.sec1Title, copy: t.sec1Copy },
    { icon: ShieldCheck, title: t.sec2Title, copy: t.sec2Copy },
    { icon: Users, title: t.sec3Title, copy: t.sec3Copy },
  ];
  return (
    <section className="border-t border-[var(--fp-border)] py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-[var(--fp-text)]">
            {t.securityEyebrow} <span className="text-gradient">{t.securityEyebrowAccent}</span>
          </h2>
        </div>
        <div className="mt-10 grid gap-5 md:grid-cols-3 max-w-5xl mx-auto">
          {items.map((s) => {
            const Icon = s.icon;
            return (
              <div
                key={s.title}
                className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-6 shadow-card"
              >
                <Icon className="h-6 w-6 text-[#22D3EE]" aria-hidden />
                <h3 className="mt-3 text-base font-semibold text-[var(--fp-text)]">{s.title}</h3>
                <p className="mt-2 text-sm text-[var(--fp-text-2)]">{s.copy}</p>
              </div>
            );
          })}
        </div>
        <div className="mt-12 text-center">
          <Link
            href="/signup"
            className="btn-gradient inline-flex items-center gap-2 rounded-xl px-8 py-3.5 text-base font-semibold text-white shadow-glow"
          >
            {t.securityCta}
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Footer ---------------- */
function Footer() {
  const t = useSeo();
  const c = t.common;
  const cols = [
    {
      title: c.footerProduct,
      links: [
        { label: c.navFeatures, href: "/features" },
        { label: c.navIntegrations, href: "/integrations" },
        { label: c.navUseCases, href: "/use-cases" },
        { label: c.navPricing, href: "/pricing" },
        { label: c.navChangelog, href: "/changelog" },
      ],
    },
    {
      title: c.footerGetStarted,
      links: [
        { label: c.startAutomating, href: "/signup" },
        { label: c.signIn, href: "/login" },
        { label: t.landing.heroCtaExplore, href: "/features" },
      ],
    },
    {
      title: c.footerLegal,
      links: [
        { label: c.footerPrivacy, href: "/privacy" },
        { label: c.footerTerms, href: "/terms" },
      ],
    },
  ];
  return (
    <footer className="border-t border-[var(--fp-border)] bg-[var(--fp-bg-2)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-12">
        <div className="grid gap-8 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm text-[var(--fp-text-2)]">{c.footerTagline}</p>
          </div>
          {cols.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <h2 className="text-sm font-semibold text-[var(--fp-text)]">{col.title}</h2>
              <ul className="mt-3 space-y-2">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-[var(--fp-text-2)] hover:text-[var(--fp-text)] transition-colors"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-[var(--fp-border)] pt-6">
          <p className="text-xs text-[var(--fp-text-2)]">{c.footerCopyright}</p>
          <p className="text-xs text-[var(--fp-text-2)]">{c.footerHonest}</p>
        </div>
      </div>
    </footer>
  );
}

export default function LandingClient() {
  return (
    <div className="min-h-screen bg-[var(--fp-bg)] text-[var(--fp-text)]">
      <Nav />
      <main>
        <Hero />
        <Integrations />
        <Features />
        <Showcase />
        <UseCases />
        <Pricing />
        <Faq />
        <Security />
      </main>
      <Footer />
    </div>
  );
}
