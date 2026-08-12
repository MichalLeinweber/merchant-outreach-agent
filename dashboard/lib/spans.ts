import type { EvidenceRef, GateId, GateOutcome, TextSpan } from "./contracts";

/**
 * Splitting a draft body into highlightable pieces.
 *
 * Two independent things want to mark up the same prose: evidence refs, which
 * point at the source field a claim came from, and failing gates, which point
 * at the text that broke them. They overlap. Rendering them as two passes of
 * nested elements produces invalid markup the moment a gate span starts inside
 * a claim and ends outside it.
 *
 * So instead the body is cut at every mark boundary into atomic segments, and
 * each segment carries the full set of marks covering it. One flat pass, no
 * nesting, overlap handled by construction.
 *
 * These are pure functions on purpose — no React, no DOM. The highlighting is
 * the most load-bearing idea in the interface, and it should be verifiable
 * without rendering anything.
 */

/** A contiguous run of body text that is covered by an identical set of marks. */
export interface BodySegment {
  text: string;
  /** Offset of this segment into the body, for stable React keys. */
  start: number;
  /** Indices into `draft.evidence` whose claim covers this segment. */
  evidence: number[];
  /** Gates whose failing spans cover this segment. */
  gates: GateId[];
}

interface Mark {
  span: TextSpan;
  evidenceIndex: number | null;
  gate: GateId | null;
}

/**
 * Finds where each evidence claim sits in the body.
 *
 * The contract requires `EvidenceRef.claim` to be an exact substring of the
 * body, and gate G05 enforces it. A claim that is not found therefore means the
 * draft is broken, not that this function should guess — it returns null and
 * the interface shows the claim as unlinked, which is exactly the failure a
 * reviewer needs to see on a blocked draft.
 *
 * When the same phrase appears more than once, each ref takes the first
 * occurrence no earlier ref has taken, so two refs quoting the same words do
 * not collapse onto one another.
 */
export function locateClaims(
  body: string,
  evidence: readonly EvidenceRef[],
): (TextSpan | null)[] {
  const taken: TextSpan[] = [];

  return evidence.map((ref) => {
    if (ref.claim.length === 0) return null;

    let from = 0;
    for (;;) {
      const start = body.indexOf(ref.claim, from);
      if (start === -1) break;

      const span: TextSpan = { start, end: start + ref.claim.length };
      const isTaken = taken.some(
        (other) => other.start === span.start && other.end === span.end,
      );
      if (!isTaken) {
        taken.push(span);
        return span;
      }
      from = start + 1;
    }

    // Either the claim is absent from the body, or every occurrence of it is
    // already spoken for. Both are grounding failures, not rendering problems.
    return null;
  });
}

/**
 * Cuts the body at every mark boundary and returns the resulting segments in
 * order. Concatenating `segment.text` reproduces the body exactly.
 */
export function buildBodySegments(
  body: string,
  evidence: readonly EvidenceRef[],
  failingOutcomes: readonly GateOutcome[],
): BodySegment[] {
  const marks: Mark[] = [];

  locateClaims(body, evidence).forEach((span, evidenceIndex) => {
    if (span !== null) marks.push({ span, evidenceIndex, gate: null });
  });

  for (const outcome of failingOutcomes) {
    for (const span of outcome.spans ?? []) {
      marks.push({ span, evidenceIndex: null, gate: outcome.gate });
    }
  }

  // Cut points: the start and end of every mark, clamped into the body and
  // deduplicated, plus the two ends of the body itself.
  const cuts = new Set<number>([0, body.length]);
  for (const mark of marks) {
    cuts.add(clamp(mark.span.start, body.length));
    cuts.add(clamp(mark.span.end, body.length));
  }
  const boundaries = [...cuts].sort((a, b) => a - b);

  const segments: BodySegment[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (start === undefined || end === undefined || start === end) continue;

    const covering = marks.filter(
      (mark) => mark.span.start <= start && mark.span.end >= end,
    );

    segments.push({
      text: body.slice(start, end),
      start,
      evidence: unique(
        covering
          .map((mark) => mark.evidenceIndex)
          .filter((index): index is number => index !== null),
      ),
      gates: unique(
        covering
          .map((mark) => mark.gate)
          .filter((gate): gate is GateId => gate !== null),
      ),
    });
  }

  return segments;
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
