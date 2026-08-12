import type { Metadata } from "next";

import { QueueView } from "@/components/QueueView";
import { RECORDS } from "@/lib/mock";

export const metadata: Metadata = {
  title: "Queue — merchant outreach",
};

export default function QueuePage() {
  return <QueueView records={RECORDS} />;
}
