"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { formatUsdCoarse } from "@/lib/format";
import { CAMPAIGN_ID, CAMPAIGN_METRICS, RECORDS } from "@/lib/mock";

import styles from "./AppShell.module.css";

/**
 * The frame every screen sits in.
 *
 * The readouts along the top are the three things an operator needs without
 * asking for them: which mode the pipeline is running in, what the campaign has
 * cost so far, and how many drafts are waiting on a human. A console shows its
 * state without being clicked.
 */

const TABS = [
  { href: "/queue", label: "Queue" },
  { href: "/metrics", label: "Metrics" },
  { href: "/evals", label: "Evals" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const awaiting = RECORDS.filter(
    (record) => record.attempt.state === "PENDING_APPROVAL",
  ).length;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.mark}>Merchant outreach</span>
          <span className={styles.campaign}>{CAMPAIGN_ID}</span>

          <div className={styles.readouts}>
            <Readout label="Mode" value="fixture" />
            <Readout label="Spend" value={formatUsdCoarse(CAMPAIGN_METRICS.totalCostUsd)} />
            <Readout label="Awaiting review" value={String(awaiting)} />
          </div>
        </div>

        <nav className={styles.tabs} aria-label="Sections">
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className={styles.tab}
              // The draft detail is reached from the queue, so it keeps the
              // queue tab marked while it is open.
              aria-current={isCurrent(pathname, tab.href) ? "page" : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className={styles.main}>{children}</main>
    </div>
  );
}

function isCurrent(pathname: string, href: string): boolean {
  if (href === "/queue") return pathname === "/" || pathname.startsWith("/queue") || pathname.startsWith("/drafts");
  return pathname.startsWith(href);
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <span className={styles.readout}>
      <span className={styles.readoutLabel}>{label}</span>
      <span className={styles.readoutValue}>{value}</span>
    </span>
  );
}
