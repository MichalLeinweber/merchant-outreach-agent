import type { Metadata, Viewport } from "next";

// Self-hosted from node_modules rather than fetched at build time, so a build
// works offline — the same reason the LLM client runs from recorded fixtures.
// `wght.css` is the weight axis alone — no italics, no width axis, neither of
// which this interface uses.
import "@fontsource-variable/archivo/wght.css";
import "@fontsource-variable/inter-tight/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import { AppShell } from "@/components/AppShell";

import "./globals.css";

export const metadata: Metadata = {
  title: "Merchant outreach — operator console",
  description:
    "Review, approve and reject generated merchant outreach. Deterministic gates, visible evidence, one irreversible send.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
