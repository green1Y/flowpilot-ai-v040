/**
 * Docs chrome strings (fragment — not part of the main dictionary).
 * Guide BODY content lives in each guide's page.tsx (English + Arabic variants).
 * `ar: typeof en` enforces key parity at compile time.
 */
export const en = {
  brand: "FlowPilot AI",
  docsHome: "Docs",
  tagline: "Guides, setup instructions, and honest platform notes.",
  searchPlaceholder: "Search guides…",
  onThisPage: "On this page",
  backToDocs: "Back to all guides",
  lastUpdated: "Last updated",
  nextGuide: "Next guide",
  prevGuide: "Previous guide",
  honestyNote: "Honesty note",
  related: "Related guides",
  guides: {
    gettingStarted: { title: "Getting started", desc: "Create your account, connect a channel, and send your first automated reply." },
    integrationSetup: { title: "Integration setup", desc: "Connect Instagram, Messenger, WhatsApp, TikTok — and understand what's real vs. simulated." },
    workflowCreation: { title: "Workflow creation", desc: "Build automations with the visual builder, templates, and Simulate mode." },
    commentToDm: { title: "Comment-to-DM setup", desc: "Turn Instagram and Facebook comments into private conversations — within Meta's rules." },
    troubleshooting: { title: "Troubleshooting", desc: "Fix the most common connection, webhook, and messaging problems." },
    permissions: { title: "Permissions & platform limitations", desc: "What each platform allows: messaging windows, templates, scopes, and hard limits." },
    security: { title: "Security & privacy", desc: "How credentials are stored, what is logged, and how tenant data stays isolated." },
    apiConfig: { title: "API configuration", desc: "Environment variables, webhooks, and what's (not) exposed as a public API." },
    changelog: { title: "Changelog", desc: "What shipped in each phase, and what was verified vs. mocked." },
    support: { title: "Support", desc: "How to get help, report a bug, and what to include." },
  },
};

export const ar: typeof en = {
  brand: "FlowPilot AI",
  docsHome: "المستندات",
  tagline: "أدلة وتعليمات إعداد وملاحظات صادقة عن المنصة.",
  searchPlaceholder: "ابحث في الأدلة…",
  onThisPage: "في هذه الصفحة",
  backToDocs: "العودة إلى كل الأدلة",
  lastUpdated: "آخر تحديث",
  nextGuide: "الدليل التالي",
  prevGuide: "الدليل السابق",
  honestyNote: "ملاحظة أمانة",
  related: "أدلة ذات صلة",
  guides: {
    gettingStarted: { title: "البدء", desc: "أنشئ حسابك واربط قناة وأرسل أول رد آلي." },
    integrationSetup: { title: "إعداد التكاملات", desc: "اربط إنستغرام وماسنجر وواتساب وتيك توك — وافهم ما هو حقيقي وما هو محاكى." },
    workflowCreation: { title: "إنشاء سير العمل", desc: "ابنِ الأتمتة بالمنشئ المرئي والقوالب ووضع المحاكاة." },
    commentToDm: { title: "إعداد التعليق-إلى-الرسائل", desc: "حوّل تعليقات إنستغرام وفيسبوك إلى محادثات خاصة — ضمن قواعد ميتا." },
    troubleshooting: { title: "استكشاف الأخطاء", desc: "أصلح أكثر مشاكل الاتصال والويب هوك والمراسلة شيوعًا." },
    permissions: { title: "الأذونات وقيود المنصات", desc: "ما تسمح به كل منصة: نوافذ المراسلة والقوالب والنطاقات والحدود الصارمة." },
    security: { title: "الأمن والخصوصية", desc: "كيف تُخزن بيانات الاعتماد، وما يُسجل، وكيف تبقى بيانات المستأجرين معزولة." },
    apiConfig: { title: "إعداد واجهة API", desc: "متغيرات البيئة والويب هوك وما هو (غير) مكشوف كواجهة عامة." },
    changelog: { title: "سجل التغييرات", desc: "ما تم شحنه في كل مرحلة، وما تم التحقق منه مقابل ما هو محاكى." },
    support: { title: "الدعم", desc: "كيف تحصل على المساعدة وتبلغ عن خطأ وماذا ترفق." },
  },
};
