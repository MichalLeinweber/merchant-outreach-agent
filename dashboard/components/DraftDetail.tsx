"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { GateId, GateOutcome, Merchant } from "@/lib/contracts";
import {
  formatCategory,
  formatFieldName,
  formatModel,
  formatScore,
  formatTimestamp,
  formatTokens,
  formatUsd,
} from "@/lib/format";
import { GATE_LABELS, blockingGate, gateCode } from "@/lib/gates";
import type { OutreachRecord } from "@/lib/mock";
import { dedupKey } from "@/lib/mock/build";
import { buildBodySegments } from "@/lib/spans";

import { GateStrip, GateStripLegend } from "./GateStrip";
import { EscalatedMark, StateBadge } from "./Primitives";
import styles from "./DraftDetail.module.css";

/**
 * The draft detail.
 *
 * Two columns: the merchant record on the left, the generated message on the
 * right. Pointing at a claim in the message lights up the field it came from;
 * pointing at a field lights up every claim that leans on it. Pointing at a
 * gate segment lights up the text that broke it.
 *
 * That is the argument this screen exists to make. A model that has to show its
 * source for every personalized sentence is a different thing from one that
 * writes plausible sentences, and the difference is visible here in about five
 * seconds without a word of explanation.
 */

/** What the operator is currently pointing at, wherever they are pointing. */
type Focus =
  | { kind: "field"; field: keyof Merchant }
  | { kind: "claim"; index: number }
  | { kind: "gate"; gate: GateId }
  | null;

/** A local decision. Nothing is sent — this build runs against fixtures. */
type Decision = "approved" | "rejected" | null;

/** Fields of the merchant record worth showing, in a sensible reading order. */
const RECORD_FIELDS: (keyof Merchant)[] = [
  "name",
  "category",
  "city",
  "countryCode",
  "locale",
  "rating",
  "reviewCount",
  "yearsInBusiness",
  "seatsOrCapacity",
  "hasActiveOffer",
  "lastOfferEndedAt",
  "websiteUrl",
  "contactEmail",
];

export function DraftDetail({ record }: { record: OutreachRecord }) {
  const { merchant, triage, draft, gates, attempt } = record;

  const [focus, setFocus] = useState<Focus>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedBody, setEditedBody] = useState(draft.body);
  const [decision, setDecision] = useState<Decision>(null);

  const blocking = blockingGate(gates);
  const failingOutcomes = gates.outcomes.filter((outcome) => !outcome.passed);

  // The body the operator is looking at right now: the edited one once it has
  // been changed, the generated one until then.
  const currentBody = isEditing || editedBody !== draft.body ? editedBody : draft.body;
  const isModified = currentBody !== draft.body;

  /*
   * The dedup key is derived from the content, so editing the body changes it.
   * Showing that live is the honest version of "approval is irreversible": the
   * key on screen is the one the send would be recorded under, not the one the
   * draft happened to be created with.
   */
  const currentDedupKey = useMemo(
    () => (isModified ? dedupKey(merchant.id, draft.campaignId, currentBody) : attempt.dedupKey),
    [isModified, merchant.id, draft.campaignId, currentBody, attempt.dedupKey],
  );

  // Highlighting only applies to the generated body. Once the text is edited,
  // the evidence offsets no longer describe it, and the gate report is stale.
  const segments = useMemo(
    () => buildBodySegments(draft.body, draft.evidence, failingOutcomes),
    [draft.body, draft.evidence, failingOutcomes],
  );

  const { activeFields, activeEvidence, activeGate } = resolveFocus(focus, draft.evidence);

  /** How many claims each field grounds, for the count beside the field name. */
  const claimsByField = useMemo(() => {
    const counts = new Map<keyof Merchant, number>();
    for (const ref of draft.evidence) {
      counts.set(ref.sourceField, (counts.get(ref.sourceField) ?? 0) + 1);
    }
    return counts;
  }, [draft.evidence]);

  return (
    <div className={styles.screen}>
      <Link className={styles.back} href="/queue">
        ← Back to queue
      </Link>

      <div className={styles.titleRow}>
        <h1 className={styles.title}>{merchant.name}</h1>
        <StateBadge state={attempt.state} />
        {triage.escalated && <EscalatedMark>escalated to {formatModel(triage.model)}</EscalatedMark>}
      </div>

      <div className={styles.meta}>
        <MetaItem label="Draft" value={draft.id} />
        <MetaItem label="Model" value={formatModel(draft.model)} />
        <MetaItem
          label="Tokens"
          value={`${formatTokens(draft.usage.inputTokens)} in · ${formatTokens(draft.usage.outputTokens)} out · ${formatTokens(draft.usage.cachedInputTokens)} cached`}
        />
        <MetaItem label="Cost" value={formatUsd(triage.usage.costUsd + draft.usage.costUsd)} />
        <MetaItem label="Triage" value={`${formatScore(triage.score)} / 100`} />
        <MetaItem label="Created" value={formatTimestamp(draft.createdAt)} />
      </div>

      {/* ── Gate strip, full size ── */}
      <section className={styles.panel} aria-labelledby="gates-heading">
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle} id="gates-heading">
            Gates
          </h2>
          <span className={styles.panelHint}>
            {gates.durationMs} ms · point at a segment to see what it checked
          </span>
        </div>
        <div className={styles.panelBody}>
          <GateStrip
            outcomes={gates.outcomes}
            size="full"
            label={merchant.name}
            activeGate={activeGate}
            onGateFocus={(gate) => setFocus(gate === null ? null : { kind: "gate", gate })}
          />
          <GateStripLegend />
        </div>
      </section>

      {/* ── Two columns ── */}
      <div className={styles.columns}>
        <section className={styles.panel} aria-labelledby="record-heading">
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle} id="record-heading">
              Source record
            </h2>
            <span className={styles.panelHint}>{draft.evidence.length} claims grounded</span>
          </div>

          <div className={styles.fields}>
            {RECORD_FIELDS.map((field) => {
              const count = claimsByField.get(field) ?? 0;
              const isActive = activeFields.has(field);
              const value = renderFieldValue(merchant, field);

              if (count === 0) {
                return (
                  <div key={field} className={styles.field} data-active={isActive}>
                    <span className={styles.fieldKey}>{formatFieldName(field)}</span>
                    <span className={styles.fieldValue}>{value}</span>
                  </div>
                );
              }

              return (
                <button
                  key={field}
                  type="button"
                  className={styles.field}
                  data-active={isActive}
                  onMouseEnter={() => setFocus({ kind: "field", field })}
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus({ kind: "field", field })}
                  onBlur={() => setFocus(null)}
                  aria-label={`${formatFieldName(field)}: grounds ${count} claim${count === 1 ? "" : "s"} in the message`}
                >
                  <span className={styles.fieldKey}>
                    {formatFieldName(field)}
                    <span className={styles.fieldCount}>{count}</span>
                  </span>
                  <span className={styles.fieldValue}>{value}</span>
                </button>
              );
            })}
          </div>

          {merchant.signals.length > 0 && (
            <div className={styles.signals}>
              <span className={styles.panelTitle}>Signals</span>
              {merchant.signals.map((signal) => (
                <span key={signal.key} className={styles.signal}>
                  <span className={styles.signalKey}>
                    {signal.key} ← {signal.sourceField}
                  </span>
                  <span className={styles.signalValue}>{signal.value}</span>
                </span>
              ))}
            </div>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="message-heading">
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle} id="message-heading">
              Generated message
            </h2>
            <span className={styles.panelHint}>
              {isEditing
                ? "Editing — highlighting is off while the text is being changed"
                : "Point at an underlined claim to see its source"}
            </span>
          </div>

          <div className={styles.panelBody}>
            <p className={styles.subject}>{draft.subject}</p>

            {isEditing ? (
              <>
                <label className="sr-only" htmlFor="draft-body">
                  Draft body
                </label>
                <textarea
                  id="draft-body"
                  className={styles.editor}
                  value={editedBody}
                  onChange={(event) => setEditedBody(event.target.value)}
                />
                <p className={styles.editNotice}>
                  <span className={styles.editNoticeTitle}>Editing invalidates the gate report.</span>
                  <span>
                    The twelve gates ran against the generated text. Approving an edited draft
                    re-runs all of them first, and the dedup key below changes with the content.
                  </span>
                </p>
              </>
            ) : (
              <div className={styles.body}>
                {isModified
                  ? currentBody
                  : segments.map((segment) => (
                      <BodySegment
                        key={segment.start}
                        text={segment.text}
                        evidenceIndex={segment.evidence[0]}
                        gates={segment.gates}
                        outcomes={failingOutcomes}
                        isActiveEvidence={segment.evidence.some((index) =>
                          activeEvidence.has(index),
                        )}
                        isActiveGate={activeGate !== null && segment.gates.includes(activeGate)}
                        onFocusClaim={(index) => setFocus({ kind: "claim", index })}
                        onBlurClaim={() => setFocus(null)}
                      />
                    ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── Actions ── */}
      {decision === null ? (
        <ActionBar
          blocking={blocking}
          dedupKeyValue={currentDedupKey}
          isModified={isModified}
          isEditing={isEditing}
          attemptState={attempt.state}
          onEdit={() => setIsEditing(true)}
          onCancelEdit={() => {
            setIsEditing(false);
            setEditedBody(draft.body);
          }}
          onApprove={() => {
            setIsEditing(false);
            setDecision("approved");
          }}
          onReject={() => {
            setIsEditing(false);
            setDecision("rejected");
          }}
        />
      ) : (
        <ResolvedBar decision={decision} dedupKeyValue={currentDedupKey} isModified={isModified} />
      )}
    </div>
  );
}

// ── Body ──────────────────────────────────────────────────────────

function BodySegment({
  text,
  evidenceIndex,
  gates,
  outcomes,
  isActiveEvidence,
  isActiveGate,
  onFocusClaim,
  onBlurClaim,
}: {
  text: string;
  evidenceIndex: number | undefined;
  gates: readonly GateId[];
  outcomes: readonly GateOutcome[];
  isActiveEvidence: boolean;
  isActiveGate: boolean;
  onFocusClaim: (index: number) => void;
  onBlurClaim: () => void;
}) {
  const gate = gates[0];
  const severity =
    gate === undefined
      ? undefined
      : outcomes.find((outcome) => outcome.gate === gate)?.severity;

  // Text a gate flagged. Wrapped whether or not it is also a claim, because on
  // a blocked draft this is the part a reviewer is looking for.
  const withGateMark = (children: ReactNode) =>
    gate === undefined ? (
      children
    ) : (
      <mark
        className={styles.gateSpan}
        data-severity={severity}
        data-active={isActiveGate}
        title={`${gateCode(gate)} ${GATE_LABELS[gate]}`}
      >
        {children}
      </mark>
    );

  if (evidenceIndex === undefined) {
    return <>{withGateMark(text)}</>;
  }

  return (
    <button
      type="button"
      className={styles.claim}
      data-active={isActiveEvidence}
      onMouseEnter={() => onFocusClaim(evidenceIndex)}
      onMouseLeave={onBlurClaim}
      onFocus={() => onFocusClaim(evidenceIndex)}
      onBlur={onBlurClaim}
    >
      {withGateMark(text)}
    </button>
  );
}

// ── Actions ───────────────────────────────────────────────────────

/** States where the decision has already been made and cannot be remade. */
const DECIDED_STATES = ["APPROVED", "QUEUED", "SENT", "REJECTED", "FAILED"];

function ActionBar({
  blocking,
  dedupKeyValue,
  isModified,
  isEditing,
  attemptState,
  onEdit,
  onCancelEdit,
  onApprove,
  onReject,
}: {
  blocking: GateId | null;
  dedupKeyValue: string;
  isModified: boolean;
  isEditing: boolean;
  attemptState: OutreachRecord["attempt"]["state"];
  onEdit: () => void;
  onCancelEdit: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const alreadyDecided = DECIDED_STATES.includes(attemptState);

  // The contract's rule, enforced where the operator can see it: a draft that
  // failed a blocking gate goes to BLOCKED, never to PENDING_APPROVAL. So the
  // approve button is not merely discouraged here — it is unavailable.
  const canApprove = blocking === null && !alreadyDecided;

  return (
    <div className={styles.actions}>
      <div className={styles.dedup}>
        <span className={styles.metaLabel}>Dedup key</span>
        <span className={styles.dedupKey}>{dedupKeyValue}</span>
        <span className={`${styles.dedupNote} ${isModified ? styles.dedupChanged : ""}`}>
          {isModified
            ? "Changed, because the key is derived from the content. The edited message would send under this key, not the original one."
            : "Approving records this key. A second send for the same merchant, campaign and content is refused by the database, not by the application."}
        </span>
      </div>

      <div className={styles.buttons}>
        {isEditing ? (
          <>
            <button type="button" className={styles.button} onClick={onCancelEdit}>
              Cancel edit
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={onApprove}
              disabled={!canApprove}
            >
              Save and approve
            </button>
          </>
        ) : (
          <>
            <button type="button" className={styles.button} onClick={onReject} disabled={alreadyDecided}>
              Reject
            </button>
            <button type="button" className={styles.button} onClick={onEdit} disabled={alreadyDecided}>
              Edit and approve
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={onApprove}
              disabled={!canApprove}
            >
              Approve and send
            </button>
          </>
        )}
      </div>

      {blocking !== null && (
        <p className={styles.blockedNote}>
          Blocked by {gateCode(blocking)} {GATE_LABELS[blocking]}. A draft that failed a blocking
          gate cannot be approved — fix the draft or reject it.
        </p>
      )}

      {blocking === null && alreadyDecided && (
        <p className={styles.blockedNote}>
          This draft is already {attemptState.replace(/_/g, " ").toLowerCase()}. Approval happens
          once.
        </p>
      )}
    </div>
  );
}

function ResolvedBar({
  decision,
  dedupKeyValue,
  isModified,
}: {
  decision: Exclude<Decision, null>;
  dedupKeyValue: string;
  isModified: boolean;
}) {
  return (
    <div className={styles.resolved}>
      <span className={styles.resolvedTitle} data-signal={decision === "approved" ? "pass" : "fail"}>
        {decision === "approved"
          ? `Approved${isModified ? " with edits" : ""} and queued for send.`
          : "Rejected. Nothing will be sent to this merchant in this campaign."}
      </span>
      <span className={styles.resolvedNote}>
        {decision === "approved" ? (
          <>
            Recorded under dedup key <span className="mono">{dedupKeyValue}</span>. This build runs
            against fixtures, so no message leaves the machine.
          </>
        ) : (
          <>
            The draft stays available as eval material — a rejection that passed all twelve gates is
            the most useful kind of failure this pipeline produces.
          </>
        )}
      </span>
    </div>
  );
}

// ── Focus resolution ──────────────────────────────────────────────

/**
 * Turns one pointer position into the three highlight sets the screen needs.
 * Kept as a pure function so the bidirectional rule is stated once, in words a
 * reader can check, rather than spread across four event handlers.
 */
function resolveFocus(
  focus: Focus,
  evidence: OutreachRecord["draft"]["evidence"],
): {
  activeFields: Set<keyof Merchant>;
  activeEvidence: Set<number>;
  activeGate: GateId | null;
} {
  const activeFields = new Set<keyof Merchant>();
  const activeEvidence = new Set<number>();

  if (focus === null) {
    return { activeFields, activeEvidence, activeGate: null };
  }

  if (focus.kind === "gate") {
    return { activeFields, activeEvidence, activeGate: focus.gate };
  }

  if (focus.kind === "field") {
    activeFields.add(focus.field);
    // Every claim drawn from this field.
    evidence.forEach((ref, index) => {
      if (ref.sourceField === focus.field) activeEvidence.add(index);
    });
    return { activeFields, activeEvidence, activeGate: null };
  }

  // A claim: light it, and the single field it came from.
  activeEvidence.add(focus.index);
  const ref = evidence[focus.index];
  if (ref) activeFields.add(ref.sourceField);
  return { activeFields, activeEvidence, activeGate: null };
}

// ── Field rendering ───────────────────────────────────────────────

function renderFieldValue(merchant: Merchant, field: keyof Merchant) {
  const value = merchant[field];

  if (value === null || value === "") {
    return <span className={styles.fieldEmpty}>—</span>;
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (field === "category") {
    return formatCategory(merchant.category);
  }
  if (field === "lastOfferEndedAt" && typeof value === "string") {
    return formatTimestamp(value);
  }
  return String(value);
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <span className={styles.metaItem}>
      <span className={styles.metaLabel}>{label}</span>
      <span className={styles.metaValue}>{value}</span>
    </span>
  );
}
