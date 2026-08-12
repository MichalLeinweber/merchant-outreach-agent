"use client";

import { useState } from "react";
import type { CSSProperties } from "react";

import type { GateId, GateOutcome } from "@/lib/contracts";
import type { GateSegmentState } from "@/lib/gates";
import { GATE_IDS, GATE_LABELS, gateCode, gateSegmentState } from "@/lib/gates";

import styles from "./GateStrip.module.css";

/**
 * The gate strip — the one component this dashboard is recognised by.
 *
 * DESIGN.md puts it in three places, and this is the single implementation all
 * three use:
 *
 *   - `compact` — inside a queue row, readable out of the corner of an eye
 *   - `full`    — on the draft detail, with codes, hover and a caption
 *   - `cell`    — one batch row of the metrics heatmap
 *
 * Splitting it into three components would have been easier and would have
 * been the wrong call: the whole point of a signature element is that it is
 * the same object everywhere, so that recognising it once is enough.
 */

export type GateStripSize = "compact" | "full" | "cell";

export interface GateStripProps {
  /** Outcomes for this draft or batch. A gate with no outcome is pending. */
  outcomes: readonly GateOutcome[];
  size?: GateStripSize;
  /**
   * Per-gate fill opacity, 0–1. Used by the heatmap to carry how much of a
   * batch failed. Everywhere else a segment is either filled or it is not.
   */
  intensity?: Partial<Record<GateId, number>>;
  /** Gate highlighted from elsewhere on the screen. */
  activeGate?: GateId | null;
  /** Fires as the pointer or keyboard focus moves across the segments. */
  onGateFocus?: (gate: GateId | null) => void;
  /** Names what the strip describes, for screen readers. */
  label: string;
}

export function GateStrip({
  outcomes,
  size = "compact",
  intensity,
  activeGate = null,
  onGateFocus,
  label,
}: GateStripProps) {
  // Which segment the pointer is on. Kept locally so the strip works on its
  // own; `activeGate` layers the rest of the screen's opinion on top.
  const [hovered, setHovered] = useState<GateId | null>(null);

  const byGate = new Map(outcomes.map((outcome) => [outcome.gate, outcome]));
  const segments = GATE_IDS.map((gate, index) => ({
    gate,
    index,
    outcome: byGate.get(gate),
    state: gateSegmentState(byGate.get(gate)),
  }));

  const isFull = size === "full";
  const active = hovered ?? activeGate;

  const focus = (gate: GateId | null): void => {
    setHovered(gate);
    onGateFocus?.(gate);
  };

  return (
    <div className={styles.wrapper}>
      <div
        className={`${styles.strip} ${styles[size]}`}
        // The compact and cell strips are a picture of a state, not a control.
        // Twelve buttons in each of forty queue rows would be 480 tab stops.
        {...(isFull ? {} : { role: "img", "aria-label": describeStrip(label, segments) })}
      >
        {isFull &&
          segments.map(({ gate }) => (
            <span
              key={`code-${gate}`}
              className={styles.code}
              data-active={gate === active}
              aria-hidden="true"
            >
              {gateCode(gate)}
            </span>
          ))}

        {segments.map(({ gate, index, state, outcome }) => {
          const style = {
            "--segment-index": index,
          } as CSSProperties;

          const fillStyle: CSSProperties = {
            opacity: intensity?.[gate] ?? 1,
          };

          const content =
            state === "pending" ? null : <span className={styles.fill} style={fillStyle} />;

          if (!isFull) {
            return (
              <span
                key={gate}
                className={styles.segment}
                data-state={state}
                data-active={gate === active}
                style={style}
                title={describeGate(gate, state, outcome)}
              >
                {content}
              </span>
            );
          }

          return (
            <button
              key={gate}
              type="button"
              className={styles.segment}
              data-state={state}
              data-active={gate === active}
              style={style}
              onMouseEnter={() => focus(gate)}
              onMouseLeave={() => focus(null)}
              onFocus={() => focus(gate)}
              onBlur={() => focus(null)}
              aria-label={describeGate(gate, state, outcome)}
            >
              {content}
            </button>
          );
        })}

        {isFull &&
          segments.map(({ gate }) => (
            <span key={`pointer-${gate}`} className={styles.pointer} aria-hidden="true">
              {gate === captionGate(segments, active) ? "↑" : ""}
            </span>
          ))}
      </div>

      {isFull && <GateCaption segments={segments} active={captionGate(segments, active)} />}
    </div>
  );
}

// ── Caption ───────────────────────────────────────────────────────

interface Segment {
  gate: GateId;
  index: number;
  outcome: GateOutcome | undefined;
  state: GateSegmentState;
}

/**
 * Which gate the caption talks about when nothing is hovered.
 *
 * The blocking failure, if there is one — that is the single most useful thing
 * on the screen for a draft that did not pass. Otherwise the first warning.
 * Otherwise nothing, and the caption stays empty rather than inventing
 * something to say.
 */
function captionGate(segments: readonly Segment[], active: GateId | null): GateId | null {
  if (active !== null) return active;
  return (
    segments.find((segment) => segment.state === "fail")?.gate ??
    segments.find((segment) => segment.state === "warn")?.gate ??
    null
  );
}

function GateCaption({ segments, active }: { segments: readonly Segment[]; active: GateId | null }) {
  const segment = segments.find((candidate) => candidate.gate === active);

  return (
    // aria-live so a keyboard user moving across the strip hears each gate.
    <p className={styles.caption} aria-live="polite">
      {segment === undefined ? (
        <span className={styles.captionDetail}>All twelve gates passed.</span>
      ) : (
        <>
          <span className={styles.captionGate} data-state={segment.state}>
            {segment.gate} — {stateWord(segment.state)}
          </span>
          <span className={styles.captionDetail}>
            {segment.outcome?.detail || passedDetail(segment.state)}
          </span>
        </>
      )}
    </p>
  );
}

// ── Legend ────────────────────────────────────────────────────────

const LEGEND: { state: GateSegmentState; label: string }[] = [
  { state: "pass", label: "Passed" },
  { state: "fail", label: "Blocked" },
  { state: "warn", label: "Warning" },
  { state: "pending", label: "Not run" },
];

export function GateStripLegend() {
  return (
    <div className={styles.legend}>
      {LEGEND.map(({ state, label }) => (
        <span key={state} className={styles.legendItem}>
          <span className={styles.legendSwatch} data-state={state} aria-hidden="true" />
          {label}
        </span>
      ))}
    </div>
  );
}

// ── Text ──────────────────────────────────────────────────────────

function stateWord(state: GateSegmentState): string {
  switch (state) {
    case "pass":
      return "passed";
    case "fail":
      return "blocked";
    case "warn":
      return "warning";
    case "pending":
      return "not run";
  }
}

function passedDetail(state: GateSegmentState): string {
  return state === "pending"
    ? "Evaluation has not reached this gate yet."
    : "Passed with nothing to report.";
}

function describeGate(
  gate: GateId,
  state: GateSegmentState,
  outcome: GateOutcome | undefined,
): string {
  const head = `${gateCode(gate)} ${GATE_LABELS[gate]} — ${stateWord(state)}`;
  return outcome?.detail ? `${head}. ${outcome.detail}` : head;
}

/** One sentence describing the whole strip, for the non-interactive sizes. */
function describeStrip(label: string, segments: readonly Segment[]): string {
  const failed = segments.filter((segment) => segment.state === "fail");
  const warned = segments.filter((segment) => segment.state === "warn");
  const pending = segments.filter((segment) => segment.state === "pending");

  const parts: string[] = [
    `${segments.filter((segment) => segment.state === "pass").length} of 12 gates passed`,
  ];
  if (failed.length > 0) {
    parts.push(`blocked by ${failed.map((segment) => gateCode(segment.gate)).join(", ")}`);
  }
  if (warned.length > 0) {
    parts.push(`warnings on ${warned.map((segment) => gateCode(segment.gate)).join(", ")}`);
  }
  if (pending.length > 0) {
    parts.push(`${pending.length} not run yet`);
  }

  return `Gates for ${label}: ${parts.join("; ")}.`;
}
