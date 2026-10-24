import { getLocale } from "@/i18n/server";
import { en, ar } from "@/i18n/fragments/onboarding";
import OnboardingWizard from "./wizard";

/**
 * Guided onboarding flow (Phase 4). Redirect target for fresh signups.
 * Nothing here ever activates a workflow or sends anything — activation
 * requires explicit confirmation on the "activate" step.
 */
export const metadata = { title: "Onboarding — FlowPilot AI" };

export default async function OnboardingPage() {
  const locale = await getLocale();
  const t = locale === "ar" ? ar : en;
  return <OnboardingWizard t={t} />;
}
