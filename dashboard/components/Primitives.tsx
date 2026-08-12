import type { ReactNode } from "react";

import type { OutreachState } from "@/lib/contracts";
import { formatState } from "@/lib/format";

import styles from "./Primitives.module.css";

/**
 * Small display primitives.
 *
 * Nothing here holds state or fetches anything; they exist so that a stat tile
 * on the metrics page and a stat tile on the evals page are the same object,
 * and so the rule about what colour is allowed to mean lives in one file
 * instead of in twelve.
 */

// ── Stat tile ─────────────────────────────────────────────────────

export function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {note !== undefined && <span className={styles.tileNote}>{note}</span>}
    </div>
  );
}

// ── State badge ───────────────────────────────────────────────────

type Signal = "pass" | "fail" | "warn" | "neutral";

/**
 * Which signal, if any, a lifecycle state carries.
 *
 * Most states carry none. `QUEUED` is not a success and `GATED` is not a
 * failure — they are just where the record currently sits, and colouring them
 * would spend meaning the palette does not have to spare.
 */
export function stateSignal(state: OutreachState): Signal {
  switch (state) {
    case "APPROVED":
    case "SENT":
      return "pass";
    case "BLOCKED":
    case "REJECTED":
    case "FAILED":
      return "fail";
    default:
      return "neutral";
  }
}

export function StateBadge({ state }: { state: OutreachState }) {
  return (
    <span className={styles.badge} data-signal={stateSignal(state)}>
      <span className={styles.badgeDot} aria-hidden="true" />
      {formatState(state)}
    </span>
  );
}

// ── Escalation mark ───────────────────────────────────────────────

/** Blue, and blue only ever means this. */
export function EscalatedMark({ children }: { children?: ReactNode }) {
  return <span className={styles.escalated}>{children ?? "escalated"}</span>;
}

// ── Delta ─────────────────────────────────────────────────────────

export function Delta({
  current,
  baseline,
  higherIsBetter,
  format,
}: {
  current: number;
  baseline: number;
  higherIsBetter: boolean;
  format: (value: number) => string;
}) {
  const difference = current - baseline;
  // Deliberately exact: a delta of zero is a real result and should not be
  // rounded into a green tick.
  const direction =
    difference === 0 ? "flat" : difference > 0 === higherIsBetter ? "better" : "worse";

  const sign = difference > 0 ? "+" : difference < 0 ? "−" : "±";

  return (
    <span className={styles.delta} data-direction={direction}>
      {sign}
      {format(Math.abs(difference))}
    </span>
  );
}

// ── Proportion bar ────────────────────────────────────────────────

export interface BarPart {
  key: string;
  value: number;
  color: string;
  label: string;
}

export function ProportionBar({ parts }: { parts: readonly BarPart[] }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (total === 0) return null;

  return (
    <div className={styles.bar}>
      {parts.map((part) => (
        <span
          key={part.key}
          className={styles.barPart}
          style={{ width: `${(part.value / total) * 100}%`, background: part.color }}
          title={part.label}
        />
      ))}
    </div>
  );
}

// ── Field list ────────────────────────────────────────────────────

export function FieldList({ children }: { children: ReactNode }) {
  return <dl className={styles.fieldList}>{children}</dl>;
}

export function Field({ name, value }: { name: string; value: ReactNode }) {
  return (
    <div className={styles.field}>
      <dt className={styles.fieldKey}>{name}</dt>
      <dd className={styles.fieldValue}>{value}</dd>
    </div>
  );
}

/** For a field the record does not have a value for. */
export function EmptyValue() {
  return <span className={styles.fieldEmpty}>—</span>;
}

export { styles as primitiveStyles };
