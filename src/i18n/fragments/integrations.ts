/**
 * Integrations i18n fragment — UI strings for the integrations center's
 * honest connection model (8 connection states + capability matrix).
 *
 * Standalone fragment (not merged into the Dictionary type): the
 * integrations page is a client component that resolves the locale from the
 * fp_locale cookie. Add keys here when new integration UI strings appear.
 */

/** English strings — the source of truth for the fragment's shape. */
export const en = {
  states: {
    not_connected: "Not connected",
    connecting: "Connecting…",
    connected: "Connected",
    partial: "Partially connected",
    permission_missing: "Permission missing",
    reauth_required: "Reauthorization required",
    unavailable: "Configuration Required",
    failed: "Connection failed",
  },
  stateHints: {
    not_connected: "This provider is not connected yet.",
    connecting: "The connection flow is in progress — finish it in the provider window.",
    connected: "Verified live connection.",
    partial: "Connected, but some details are incomplete — check the provider card.",
    permission_missing: "The provider revoked a permission — reconnect and re-grant it.",
    reauth_required: "The token expired or is invalid — reconnect the provider.",
    unavailable: "This provider is not configured on this server — set the required environment variables.",
    failed: "The last connection attempt failed.",
  },
  capabilities: {
    read_events: "Read events",
    receive_comments: "Receive comments",
    send_messages: "Send messages",
    publish_media: "Publish media",
    manage_conversations: "Manage conversations",
    retrieve_analytics: "Retrieve analytics",
    manage_ads: "Manage ads",
    audience_conversion_data: "Audience & conversion data",
  },
  capabilityStates: {
    available: "Available",
    limited: "Limited",
    unavailable: "Unavailable",
    not_connected: "Not connected",
    simulated: "Simulated",
  },
  ui: {
    capabilitiesHeading: "Capabilities",
    connectionIssue: "Connection issue",
    setupRequired: "Server setup required",
  },
};

/** Arabic strings — must satisfy the English shape (tsc enforces). */
export const ar: typeof en = {
  states: {
    not_connected: "غير متصل",
    connecting: "جارٍ الاتصال…",
    connected: "متصل",
    partial: "متصل جزئيًا",
    permission_missing: "صلاحية مفقودة",
    reauth_required: "إعادة التفويض مطلوبة",
    unavailable: "الإعداد مطلوب",
    failed: "فشل الاتصال",
  },
  stateHints: {
    not_connected: "هذا المزوّد غير متصل بعد.",
    connecting: "عملية الاتصال جارية — أكملها في نافذة المزوّد.",
    connected: "اتصال مباشر تم التحقق منه.",
    partial: "متصل، لكن بعض التفاصيل ناقصة — تحقق من بطاقة المزوّد.",
    permission_missing: "ألغى المزوّد صلاحية — أعد الاتصال ومنحها مجددًا.",
    reauth_required: "انتهت صلاحية الرمز أو أنه غير صالح — أعد اتصال المزوّد.",
    unavailable: "هذا المزوّد غير مُعدّ على هذا الخادم — اضبط متغيرات البيئة المطلوبة.",
    failed: "فشلت محاولة الاتصال الأخيرة.",
  },
  capabilities: {
    read_events: "قراءة الأحداث",
    receive_comments: "استقبال التعليقات",
    send_messages: "إرسال الرسائل",
    publish_media: "نشر الوسائط",
    manage_conversations: "إدارة المحادثات",
    retrieve_analytics: "استرجاع التحليلات",
    manage_ads: "إدارة الإعلانات",
    audience_conversion_data: "بيانات الجمهور والتحويل",
  },
  capabilityStates: {
    available: "متاح",
    limited: "محدود",
    unavailable: "غير متاح",
    not_connected: "غير متصل",
    simulated: "محاكى",
  },
  ui: {
    capabilitiesHeading: "القدرات",
    connectionIssue: "مشكلة في الاتصال",
    setupRequired: "الإعداد على الخادم مطلوب",
  },
};

export type IntegrationsStrings = typeof en;

/** Resolve the fragment for a locale string (falls back to English). */
export function getIntegrationsStrings(locale: string): IntegrationsStrings {
  return locale === "ar" ? ar : en;
}
