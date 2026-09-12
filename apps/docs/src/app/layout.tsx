import "./global.css";

import { basePath } from "@/lib/shared";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import {
  Bricolage_Grotesque,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
} from "next/font/google";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-consult-display",
});
const body = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-consult-body",
  weight: ["400", "500", "600", "700"],
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-consult-mono",
  weight: ["400", "500", "600"],
});

const siteUrl = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
);

export const metadata: Metadata = {
  // Asset metadata already includes the GitHub Pages base path. Keeping the
  // metadata base at the origin prevents Next.js from adding that path twice.
  metadataBase: new URL(siteUrl.origin),
  title: {
    default: "ConsultChimps: Operations tools that keep their promises",
    template: "%s · ConsultChimps",
  },
  description:
    "Local-first spreadsheet, database, PowerPoint, and PDF tools for consultants and operations teams.",
  icons: {
    icon: `${basePath}/favicon.png`,
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <RootProvider
          search={{
            options: {
              type: "static",
              api: `${basePath}/static.json`,
            },
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
