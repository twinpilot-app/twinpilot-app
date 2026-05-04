import type { Metadata, Viewport } from "next";
import { Sora, Manrope, JetBrains_Mono } from "next/font/google";
import { AuthProvider } from "@/lib/auth-context";
import { brand } from "@/lib/brand";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-heading",
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: brand.name,
  description: brand.tagline,
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: brand.shortName,
  },
  icons: {
    icon: brand.assets.favicon,
    apple: brand.assets.logoMark,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
  viewportFit: "cover",
  themeColor: brand.theme.themeColor,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`h-full antialiased dark ${sora.variable} ${manrope.variable} ${jetbrainsMono.variable}`}
      style={{
        // Override Tirsa defaults in globals.css with active brand colors.
        // Components that use var(--blue)/var(--teal)/var(--sapphire) pick up
        // the active brand automatically; hardcoded hexes don't (cleanup is
        // incremental).
        ["--blue" as string]: brand.theme.primary,
        ["--sapphire" as string]: brand.theme.primaryHover,
        ["--teal" as string]: brand.theme.accent,
        ["--mauve" as string]: brand.theme.primary,
        ["--pink" as string]: brand.theme.accent,
      }}
    >
      <body className="min-h-full flex bg-tirsa-base text-tirsa-text font-body">
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
