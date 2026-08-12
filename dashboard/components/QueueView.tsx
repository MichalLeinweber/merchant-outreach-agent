"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";

import type { GateId, OutreachState } from "@/lib/contracts";
import {
  formatAge,
  formatCategory,
  formatScore,
  formatUsd,
  truncateHash,
} from "@/lib/format";
import { GATE_IDS, GATE_LABELS, blockingGate, gateCode, warningGates } from "@/lib/gates";
import type { OutreachRecord } from "@/lib/mock";
import { CAMPAIGN_NOW } from "@/lib/mock";

import { GateStrip, GateStripLegend } from "./GateStrip";
import { EscalatedMark, StateBadge } from "./Primitives";
import styles from "./QueueView.module.css";

/**
 * The queue.
 *
 * A dense table, because the job it supports is scanning: an operator running
 * down forty rows looking for the ones that need a decision. The gate strip in
 * each row is the thing that makes that possible without reading — a row with a
 * red segment is visible before any of its text is.
 *
 * Below 760px the rows become cards, per DESIGN.md. The markup does not change;
 * only the CSS does.
 */

type StateFilter = OutreachState | "ALL";
type GateFilter = GateId | "ALL" | "NONE";
type EscalationFilter = "ALL" | "ESCALATED" | "NOT_ESCALATED";

/** Every state that actually occurs in the campaign, in lifecycle order. */
const STATE_ORDER: OutreachState[] = [
  "GATED",
  "BLOCKED",
  "PENDING_APPROVAL",
  "APPROVED",
  "QUEUED",
  "SENT",
  "REJECTED",
  "FAILED",
];

export function QueueView({ records }: { records: readonly OutreachRecord[] }) {
  const [stateFilter, setStateFilter] = useState<StateFilter>("ALL");
  const [gateFilter, setGateFilter] = useState<GateFilter>("ALL");
  const [escalationFilter, setEscalationFilter] = useState<EscalationFilter>("ALL");
  const [expanded, setExpanded] = useState<string | null>(null);

  const isFiltered =
    stateFilter !== "ALL" || gateFilter !== "ALL" || escalationFilter !== "ALL";

  const visible = useMemo(
    () =>
      records.filter((record) => {
        if (stateFilter !== "ALL" && record.attempt.state !== stateFilter) return false;

        if (gateFilter !== "ALL") {
          const blocking = blockingGate(record.gates);
          if (gateFilter === "NONE" ? blocking !== null : blocking !== gateFilter) return false;
        }

        if (escalationFilter === "ESCALATED" && !record.triage.escalated) return false;
        if (escalationFilter === "NOT_ESCALATED" && record.triage.escalated) return false;

        return true;
      }),
    [records, stateFilter, gateFilter, escalationFilter],
  );

  const clearFilters = (): void => {
    setStateFilter("ALL");
    setGateFilter("ALL");
    setEscalationFilter("ALL");
  };

  // States present in the data, so the filter never offers an empty result.
  const availableStates = STATE_ORDER.filter((state) =>
    records.some((record) => record.attempt.state === state),
  );

  return (
    <div className={styles.screen}>
      <div className={styles.head}>
        <h1 className={styles.title}>Approval queue</h1>
        <span className={styles.count}>
          {visible.length} of {records.length} drafts
        </span>
      </div>

      <div className={styles.filters}>
        <Filter
          label="State"
          value={stateFilter}
          onChange={(value) => setStateFilter(value as StateFilter)}
          options={[
            { value: "ALL", label: "All states" },
            ...availableStates.map((state) => ({ value: state, label: state })),
          ]}
        />

        <Filter
          label="Blocking gate"
          value={gateFilter}
          onChange={(value) => setGateFilter(value as GateFilter)}
          options={[
            { value: "ALL", label: "Any" },
            { value: "NONE", label: "Not blocked" },
            ...GATE_IDS.map((gate) => ({
              value: gate,
              label: `${gateCode(gate)} ${GATE_LABELS[gate]}`,
            })),
          ]}
        />

        <Filter
          label="Escalation"
          value={escalationFilter}
          onChange={(value) => setEscalationFilter(value as EscalationFilter)}
          options={[
            { value: "ALL", label: "Any" },
            { value: "ESCALATED", label: "Escalated only" },
            { value: "NOT_ESCALATED", label: "Not escalated" },
          ]}
        />

        <button
          type="button"
          className={styles.clear}
          onClick={clearFilters}
          disabled={!isFiltered}
        >
          Clear filters
        </button>
      </div>

      <GateStripLegend />

      {visible.length === 0 ? (
        <EmptyState isFiltered={isFiltered} onClear={clearFilters} />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Merchant</th>
                <th scope="col">Triage</th>
                <th scope="col">Gates</th>
                <th scope="col">State</th>
                <th scope="col">Cost</th>
                <th scope="col">Age</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((record) => (
                <QueueRow
                  key={record.draft.id}
                  record={record}
                  isExpanded={expanded === record.draft.id}
                  onToggle={() =>
                    setExpanded((current) =>
                      current === record.draft.id ? null : record.draft.id,
                    )
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────

function QueueRow({
  record,
  isExpanded,
  onToggle,
}: {
  record: OutreachRecord;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { merchant, triage, draft, gates, attempt } = record;
  const cost = triage.usage.costUsd + draft.usage.costUsd;
  const previewId = `preview-${draft.id}`;

  return (
    <Fragment>
      <tr className={styles.row} data-expanded={isExpanded}>
        <td className={styles.merchantCell}>
          <button
            type="button"
            className={styles.disclosure}
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-controls={previewId}
          >
            <span className={styles.caret} aria-hidden="true">
              {isExpanded ? "▾" : "▸"}
            </span>
            <span>
              <span className={styles.merchantName}>{merchant.name}</span>{" "}
              <span className={styles.merchantMeta}>
                {formatCategory(merchant.category)} · {merchant.city}
              </span>
            </span>
          </button>
        </td>

        <td className={styles.numeric}>
          <span className={styles.cellLabel}>Triage</span>
          <span className={styles.scoreCell}>
            {formatScore(triage.score)}
            {triage.escalated && <EscalatedMark>esc</EscalatedMark>}
          </span>
        </td>

        <td className={styles.gateCell}>
          <span className={styles.cellLabel}>Gates</span>
          <GateStrip outcomes={gates.outcomes} size="compact" label={merchant.name} />
        </td>

        <td>
          <span className={styles.cellLabel}>State</span>
          <StateBadge state={attempt.state} />
        </td>

        <td className={styles.numeric}>
          <span className={styles.cellLabel}>Cost</span>
          {formatUsd(cost)}
        </td>

        <td className={styles.numeric}>
          <span className={styles.cellLabel}>Age</span>
          {formatAge(draft.createdAt, CAMPAIGN_NOW)}
        </td>
      </tr>

      {isExpanded && (
        <tr className={styles.previewRow} id={previewId}>
          <td className={styles.previewCell} colSpan={6}>
            <RowPreview record={record} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── Expanded preview ──────────────────────────────────────────────

const PREVIEW_CHARS = 340;

function RowPreview({ record }: { record: OutreachRecord }) {
  const { draft, gates, attempt, triage } = record;
  const blocking = blockingGate(gates);
  const warnings = warningGates(gates);

  const excerpt =
    draft.body.length > PREVIEW_CHARS
      ? `${draft.body.slice(0, PREVIEW_CHARS).trimEnd()}…`
      : draft.body;

  return (
    <div className={styles.preview}>
      <div>
        <p className={styles.previewSubject}>{draft.subject}</p>
        <p className={styles.previewBody}>{excerpt}</p>

        {blocking !== null && (
          <p className={styles.previewNote} data-signal="fail">
            <strong>{gateCode(blocking)} {GATE_LABELS[blocking]}</strong>{" "}
            {gates.outcomes.find((outcome) => outcome.gate === blocking)?.detail}
          </p>
        )}

        {blocking === null && warnings.length > 0 && (
          <p className={styles.previewNote} data-signal="warn">
            <strong>{gateCode(warnings[0]!)} {GATE_LABELS[warnings[0]!]}</strong>{" "}
            {gates.outcomes.find((outcome) => outcome.gate === warnings[0])?.detail}
          </p>
        )}
      </div>

      <div className={styles.previewSide}>
        <span className={styles.previewKey}>
          {draft.evidence.length} grounded claim{draft.evidence.length === 1 ? "" : "s"} ·{" "}
          {triage.recommendedAction.replace(/_/g, " ")}
        </span>
        <span className={styles.previewKey}>dedup {truncateHash(attempt.dedupKey, 16)}</span>
        <Link className={styles.open} href={`/drafts/${draft.id}`}>
          Open draft
        </Link>
      </div>
    </div>
  );
}

// ── Filter control ────────────────────────────────────────────────

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <label className={styles.filter}>
      <span className={styles.filterLabel}>{label}</span>
      <select
        className={styles.select}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── Empty state ───────────────────────────────────────────────────

function EmptyState({ isFiltered, onClear }: { isFiltered: boolean; onClear: () => void }) {
  return (
    <div className={styles.empty}>
      {isFiltered ? (
        <>
          <h2 className={styles.emptyTitle}>No drafts match these filters.</h2>
          <p className={styles.emptyBody}>
            Three filters are applied at once here — state, blocking gate and escalation. Clearing
            them brings the whole queue back.
          </p>
          <button type="button" className={styles.clear} onClick={onClear}>
            Clear filters
          </button>
        </>
      ) : (
        <>
          <h2 className={styles.emptyTitle}>No drafts waiting.</h2>
          <p className={styles.emptyBody}>Run a campaign to generate outreach.</p>
        </>
      )}
    </div>
  );
}
