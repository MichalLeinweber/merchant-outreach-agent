import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DraftDetail } from "@/components/DraftDetail";
import { RECORDS, findRecordByDraftId } from "@/lib/mock";

interface DraftPageProps {
  params: Promise<{ id: string }>;
}

/** Every draft in the campaign is known ahead of time, so all of them prerender. */
export function generateStaticParams() {
  return RECORDS.map((record) => ({ id: record.draft.id }));
}

export async function generateMetadata({ params }: DraftPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = findRecordByDraftId(id);

  return {
    title: record ? `${record.merchant.name} — draft` : "Draft not found",
  };
}

export default async function DraftPage({ params }: DraftPageProps) {
  const { id } = await params;
  const record = findRecordByDraftId(id);

  // A draft id that does not exist is a 404, not an empty screen. Guessing what
  // the reader meant would be a silent fallback.
  if (!record) notFound();

  return <DraftDetail record={record} />;
}
