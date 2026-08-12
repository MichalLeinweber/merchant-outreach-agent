import type { Metadata } from "next";

import { EvalsView } from "@/components/EvalsView";

export const metadata: Metadata = {
  title: "Evals — merchant outreach",
};

export default function EvalsPage() {
  return <EvalsView />;
}
