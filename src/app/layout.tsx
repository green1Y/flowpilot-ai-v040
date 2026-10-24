import type { Metadata } from "next";
import "./globals.css";
import { getLocale, getDictionary } from "@/i18n/server";
import { isRtl } from "@/i18n/config";
import { seoSiteUrl } from "@/i18n/fragments/seo";

const siteUrl = seoSiteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "FlowPilot AI — Multichannel AI Automation for Modern Businesses",
    template: "%s",
  },
  description:
    "FlowPilot AI — connect your channels, automate your conversations, and turn engagement into customers.",
  openGraph: {
    siteName: "FlowPilot AI",
    type: "website",
    images: [{ url: `${siteUrl}/opengraph-image`, width: 1200, height: 630, alt: "FlowPilot AI" }],
  },
  twitter: {
    card: "summary_large_image",
    images: [`${siteUrl}/opengraph-image`],
  },
};

// Runs before first paint: restores the saved theme so dark (default) stays dark
// and light stays light without a flash.
const themeInitScript = `(function(){try{var t=localStorage.getItem('fp_theme');var el=document.documentElement;if(t==='light'){el.classList.add('light');el.classList.remove('dark')}else{el.classList.add('dark');el.classList.remove('light')}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  void getDictionary(locale); // validate locale has a dictionary at request time
  return (
    <html lang={locale} dir={isRtl(locale) ? "rtl" : "ltr"} className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
