/**
 * Ordered guide registry for /docs (Phase 4).
 * Titles/descriptions are localized in src/i18n/fragments/docs.ts;
 * this file only carries the stable slugs + order.
 */
export const GUIDE_ORDER = [
  "getting-started",
  "integration-setup",
  "workflow-creation",
  "comment-to-dm",
  "troubleshooting",
  "permissions-limitations",
  "security-privacy",
  "api-configuration",
  "changelog",
  "support",
] as const;

export type GuideSlug = (typeof GUIDE_ORDER)[number];

/** Map registry position → docs fragment key. */
export const GUIDE_FRAGMENT_KEY: Record<GuideSlug, string> = {
  "getting-started": "gettingStarted",
  "integration-setup": "integrationSetup",
  "workflow-creation": "workflowCreation",
  "comment-to-dm": "commentToDm",
  troubleshooting: "troubleshooting",
  "permissions-limitations": "permissions",
  "security-privacy": "security",
  "api-configuration": "apiConfig",
  changelog: "changelog",
  support: "support",
};
