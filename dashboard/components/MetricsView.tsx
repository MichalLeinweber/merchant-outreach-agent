import { Fragment } from "react";

import {
  formatDuration,
  formatModel,
  formatPercent,
  formatTokens,
  formatUsd,
  formatUsdCoarse,
} from "@/lib/format";
import { GATE_IDS, GATE_LABELS, gateCode } from "@/lib/gates";
import {
  CAMPAIGN_METRICS,
  ESCALATION,
  GATE_BATCHES,
  MODEL_BREAKDOWN,
  PURSUE_THRESHOLD,
  TRIAGE_DISTRIBUTION,
} from "@/lib/mock";

import { GateStrip, GateStripLegend } from "./GateStrip";
import { ProportionBar, StatTile } from "./Primitives";
import styles from "./MetricsView.module.css";

/**
 * Campaign metrics.
 *
 * Everything here is summed from the records rather than stated separately, so
 * the totals cannot disagree with the rows they came from. The gate heatmap is
 * the same `GateStrip` component the queue and the draft detail use — one batch
 * per row, gates as columns, exactly as DESIGN.md describes it.
 */

/*
 * Greyscale for the model mix. A model is not a pass, a failure or a warning,
 * and the escalation blue is spoken for. Where a chart needs to distinguish
 * categories that carry no signal, it does it with value, not hue.
 */
const MODEL_SHADES: Record<string, string> = {
  "claude-haiku-4-5-20251001": "var(--rule)",
  "claude-sonnet-5": "var(--ink-mute)",
  "claude-opus-5": "var(--ink)",
};

export function MetricsView() {
  const metrics = CAMPAIGN_METRICS;

  const failingGates = GATE_IDS.map((gate) => ({
    gate,
    rate: metrics.gatePassRate[gate],
  })).filter((entry) => entry.rate < 1);

  const histogramMax = Math.max(
    ...TRIAGE_DISTRIBUTION.map((bucket) => bucket.drafted + bucket.skipped),
    1,
  );

  return (
    <div className={styles.screen}>
      <h1 className={styles.title}>Campaign metrics</h1>

      {/* ── Headline ── */}
      <div className={styles.tiles}>
        <StatTile
          label="Cost per sent outreach"
          value={formatUsd(metrics.costPerSentUsd)}
          note={`${formatUsdCoarse(metrics.totalCostUsd)} across the campaign, divided by ${metrics.sent} sent`}
        />
        <StatTile
          label="Total spend"
          value={formatUsdCoarse(metrics.totalCostUsd)}
          note={`${metrics.merchantsIngested} merchants ingested, ${metrics.draftsCreated} drafted`}
        />
        <StatTile
          label="Escalation rate"
          value={<span className={styles.escalateValue}>{formatPercent(ESCALATION.rate)}</span>}
          note={`${ESCALATION.escalated} of ${ESCALATION.triaged} triage results re-run on a stronger model`}
        />
        <StatTile
          label="Median time to approve"
          value={
            metrics.medianTimeToApproveMs === null
              ? "—"
              : formatDuration(metrics.medianTimeToApproveMs)
          }
          note="From draft created to a human decision"
        />
        <StatTile
          label="Blocked drafts"
          value={`${metrics.draftsBlocked} / ${metrics.draftsCreated}`}
          note={`${formatPercent(metrics.draftsBlocked / metrics.draftsCreated)} stopped by a blocking gate`}
        />
        <StatTile
          label="Approved · rejected · sent"
          value={`${metrics.approved} · ${metrics.rejected} · ${metrics.sent}`}
          note="A rejection is a signal, not a loss — it is eval material"
        />
      </div>

      {/* ── Cost by model ── */}
      <section className={styles.section} aria-labelledby="model-heading">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle} id="model-heading">
            Cost by model
          </h2>
          <p className={styles.sectionNote}>
            Cheap model for volume, expensive model for the hard cases. The Opus line is what
            uncertainty costs.
          </p>
        </div>

        <div className={styles.panel}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col" className={styles.numeric}>
                    Calls
                  </th>
                  <th scope="col" className={styles.numeric}>
                    Input
                  </th>
                  <th scope="col" className={styles.numeric}>
                    Output
                  </th>
                  <th scope="col" className={styles.numeric}>
                    Cost
                  </th>
                  <th scope="col" className={styles.shareCell}>
                    Share of spend
                  </th>
                </tr>
              </thead>
              <tbody>
                {MODEL_BREAKDOWN.map((row) => (
                  <tr key={row.model}>
                    <td>{formatModel(row.model)}</td>
                    <td className={styles.numeric}>{formatTokens(row.calls)}</td>
                    <td className={styles.numeric}>{formatTokens(row.inputTokens)}</td>
                    <td className={styles.numeric}>{formatTokens(row.outputTokens)}</td>
                    <td className={styles.numeric}>{formatUsdCoarse(row.costUsd)}</td>
                    <td className={styles.shareCell}>
                      <ProportionBar
                        parts={[
                          {
                            key: "spent",
                            value: row.costUsd,
                            color: MODEL_SHADES[row.model] ?? "var(--ink)",
                            label: `${formatModel(row.model)} — ${formatUsdCoarse(row.costUsd)}`,
                          },
                          {
                            key: "rest",
                            value: Math.max(metrics.totalCostUsd - row.costUsd, 0),
                            color: "var(--surface-2)",
                            label: "Rest of the campaign",
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Gate heatmap ── */}
      <section className={styles.section} aria-labelledby="heatmap-heading">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle} id="heatmap-heading">
            Gate heatmap
          </h2>
          <p className={styles.sectionNote}>
            One row per batch of eight drafts, in the order the campaign ran. A cell passes only if
            every draft in the batch passed it; the darker the red, the more of the batch it
            stopped.
          </p>
        </div>

        <div className={styles.panel}>
          <div className={styles.heatmap}>
            <span aria-hidden="true" />
            <div className={styles.heatmapCodes} aria-hidden="true">
              {GATE_IDS.map((gate) => (
                <span key={gate} className={styles.heatmapCode}>
                  {gateCode(gate)}
                </span>
              ))}
            </div>

            {GATE_BATCHES.map((batch) => (
              <Fragment key={batch.label}>
                <span className={styles.heatmapLabel}>
                  {batch.label} <span className={styles.heatmapSize}>({batch.size})</span>
                </span>
                <GateStrip
                  outcomes={batch.outcomes}
                  intensity={batch.intensity}
                  size="cell"
                  label={batch.label}
                />
              </Fragment>
            ))}
          </div>

          <div className={styles.legendRow}>
            <GateStripLegend />
          </div>
        </div>

        {failingGates.length > 0 && (
          <div className={styles.panel}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Gate</th>
                    <th scope="col">Checks</th>
                    <th scope="col" className={styles.numeric}>
                      Pass rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {failingGates.map(({ gate, rate }) => (
                    <tr key={gate}>
                      <td>{gateCode(gate)}</td>
                      <td>{GATE_LABELS[gate]}</td>
                      <td className={styles.numeric}>{formatPercent(rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* ── Triage distribution ── */}
      <section className={styles.section} aria-labelledby="triage-heading">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle} id="triage-heading">
            Triage score distribution
          </h2>
          <p className={styles.sectionNote}>
            Every ingested merchant, bucketed by triage score. The pursue threshold is{" "}
            {PURSUE_THRESHOLD} — everything below it was scored and skipped without a draft being
            written, which is where most of the saving comes from.
          </p>
        </div>

        <div className={styles.panel}>
          <div className={styles.histogram}>
            {TRIAGE_DISTRIBUTION.map((bucket) => {
              const total = bucket.drafted + bucket.skipped;
              return (
                <div
                  key={bucket.from}
                  className={styles.histogramColumn}
                  title={`${bucket.from}–${bucket.from + 9}: ${bucket.drafted} drafted, ${bucket.skipped} skipped`}
                >
                  <span className={styles.histogramCount}>{total > 0 ? total : ""}</span>
                  {bucket.drafted > 0 && (
                    <span
                      className={`${styles.histogramBar} ${styles.histogramDrafted}`}
                      style={{ height: `${(bucket.drafted / histogramMax) * 100}%` }}
                    />
                  )}
                  {bucket.skipped > 0 && (
                    <span
                      className={`${styles.histogramBar} ${styles.histogramSkipped}`}
                      style={{ height: `${(bucket.skipped / histogramMax) * 100}%` }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className={styles.histogramAxis}>
            {TRIAGE_DISTRIBUTION.map((bucket) => (
              <span
                key={bucket.from}
                className={styles.histogramTick}
                data-threshold={
                  PURSUE_THRESHOLD >= bucket.from && PURSUE_THRESHOLD < bucket.from + 10
                }
              >
                {bucket.from}
              </span>
            ))}
          </div>

          <div className={styles.legendRow}>
            <span className={styles.legendItem}>
              <span
                className={`${styles.legendSwatch} ${styles.histogramDrafted}`}
                aria-hidden="true"
              />
              Drafted
            </span>
            <span className={styles.legendItem}>
              <span
                className={`${styles.legendSwatch} ${styles.histogramSkipped}`}
                aria-hidden="true"
              />
              Skipped at triage
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
