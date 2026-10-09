import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://dynasport.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "DynaSport · Live Football Automation",
    template: "%s · DynaSport",
  },
  description:
    "DynaSport tracks live football fixtures from API-Football and publishes verified goals, cards, lineups and full-time results to the DynaSport Facebook Page.",
  applicationName: "DynaSport",
  keywords: [
    "live football",
    "football scores",
    "match events",
    "live goals",
    "football automation",
    "DynaSport",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "DynaSport",
    title: "DynaSport · Live Football Automation",
    description:
      "Verified live football updates - goals, cards, lineups and full-time results - published automatically to the DynaSport Facebook Page.",
  },
  twitter: {
    card: "summary_large_image",
    title: "DynaSport · Live Football Automation",
    description: "Verified live football updates published automatically to the DynaSport Facebook Page.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "DynaSport",
    url: siteUrl,
    description:
      "Live football automation publishing verified match events to the DynaSport Facebook Page.",
  };

  return (
    <html lang="en">
      <body className="min-h-screen bg-[#06090b] text-neutral-100 antialiased">
        {children}
        <script
          type="application/ld+json"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </body>
    </html>
  );
}
