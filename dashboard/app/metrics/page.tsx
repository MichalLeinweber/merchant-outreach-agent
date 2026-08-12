import type { Metadata } from "next";

import { MetricsView } from "@/components/MetricsView";

export const metadata: Metadata = {
  title: "Metrics — merchant outreach",
};

export default function MetricsPage() {
  return <MetricsView />;
}
