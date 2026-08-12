import { formatDuration, formatModel, formatPercent, formatTimestamp, formatUsd } from "@/lib/format";
import type { EvalMetric, EvalUnit } from "@/lib/mock";
import { LATEST_EVAL_RUN } from "@/lib/mock";

import { Delta } from "./Primitives";
import styles from "./EvalsView.module.css";

/**
 * The last eval run, against the baseline.
 *
 * Green and red here mean improved and regressed, which is the same meaning
 * they carry everywhere else in this interface: something passed, or something
 * did not. Whether up is good depends on the metric — a rising blocked-draft
 * rate is a regression — so each metric states its own direction rather than
 * leaving the colour to guess.
 */

/** Agreement below this is drawn as a warning rather than as a plain value. */
const AGREEMENT_FLOOR = 0.8;

export function EvalsView() {
  const run = LATEST_EVAL_RUN;

  return (
    <div className={styles.screen}>
      <h1 className={styles.title}>Evals</h1>

      <div className={styles.runHead}>
        <RunItem label="Run" value={run.id} />
        <RunItem label="Commit" value={run.commit} />
        <RunItem label="Started" value={formatTimestamp(run.startedAt)} />
        <RunItem label="Duration" value={formatDuration(run.durationMs)} />
        <RunItem label="Golden set" value={`${run.goldenSetSize} cases`} />
        <RunItem label="Drafted by" value={formatModel(run.draftModel)} />
        <RunItem label="Judged by" value={formatModel(run.judgeModel)} />
        <RunItem label="Baseline" value={`${run.baselineId} · ${run.baselineCommit}`} />
      </div>

      {/* ── Metrics against baseline ── */}
      <section className={styles.section} aria-labelledby="deltas-heading">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle} id="deltas-heading">
            Against baseline
          </h2>
          <p className={styles.sectionNote}>
            Baseline is {run.baselineId}, run on {formatTimestamp(run.baselineStartedAt)}. Deltas in
            percentage points where the metric is a rate.
          </p>
        </div>

        <div className={styles.panel}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col" className={styles.numeric}>
                  This run
                </th>
                <th scope="col" className={styles.numeric}>
                  Baseline
                </th>
                <th scope="col" className={styles.numeric}>
                  Delta
                </th>
              </tr>
            </thead>
            <tbody>
              {run.metrics.map((metric) => (
                <tr key={metric.key}>
                  <td>
                    <span className={styles.metricLabel}>{metric.label}</span>
                    <span className={styles.metricNote}>
                      {metric.note} · {metric.higherIsBetter ? "higher is better" : "lower is better"}
                    </span>
                  </td>
                  <td className={styles.numeric}>{formatMetric(metric.unit, metric.current)}</td>
                  <td className={styles.numeric}>{formatMetric(metric.unit, metric.baseline)}</td>
                  <td className={styles.numeric}>
                    <Delta
                      current={metric.current}
                      baseline={metric.baseline}
                      higherIsBetter={metric.higherIsBetter}
                      format={(value) => formatDeltaValue(metric, value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Rubric ── */}
      <section className={styles.section} aria-labelledby="rubric-heading">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle} id="rubric-heading">
            Judge rubric
          </h2>
          <p className={styles.sectionNote}>
            Each dimension scored 1–5 by the judge model, shown next to how often that judgment
            matched the human calibration set. A score without agreement behind it is not evidence.
          </p>
        </div>

        <div className={styles.panel}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Dimension</th>
                <th scope="col" className={styles.numeric}>
                  Score
                </th>
                <th scope="col" className={styles.numeric}>
                  Delta
                </th>
                <th scope="col" className={styles.numeric}>
                  Human agreement
                </th>
              </tr>
            </thead>
            <tbody>
              {run.rubric.map((row) => (
                <tr key={row.key}>
                  <td>
                    <span className={styles.metricLabel}>{row.label}</span>
                    <span className={styles.metricNote}>{row.note}</span>
                  </td>
                  <td className={styles.numeric}>{row.current.toFixed(1)} / 5</td>
                  <td className={styles.numeric}>
                    <Delta
                      current={row.current}
                      baseline={row.baseline}
                      higherIsBetter
                      format={(value) => value.toFixed(1)}
                    />
                  </td>
                  <td className={styles.numeric}>
                    <span className={styles.agreement}>
                      <span className={styles.agreementTrack}>
                        <span
                          className={styles.agreementFill}
                          style={{ width: `${row.humanAgreement * 100}%` }}
                          data-low={row.humanAgreement < AGREEMENT_FLOOR}
                        />
                      </span>
                      <span className={styles.agreementValue}>
                        {formatPercent(row.humanAgreement, 0)}
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Cases that moved ── */}
      <section className={styles.section} aria-labelledby="cases-heading">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle} id="cases-heading">
            Cases that moved
          </h2>
          <p className={styles.sectionNote}>
            Golden-set cases whose verdict changed since the baseline. Every regression listed here
            was caught by a gate rather than by a reviewer, which is the arrangement working as
            intended.
          </p>
        </div>

        <div className={styles.panel}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Merchant</th>
                <th scope="col">Expected</th>
                <th scope="col">This run</th>
              </tr>
            </thead>
            <tbody>
              {run.cases.map((testCase) => (
                <tr key={testCase.id}>
                  <td>
                    <span className={styles.caseStatus} data-status={testCase.status}>
                      {testCase.status}
                    </span>
                  </td>
                  <td>
                    {testCase.merchantName}
                    <span className={styles.caseId}>{testCase.id}</span>
                  </td>
                  <td className={styles.caseText}>{testCase.expected}</td>
                  <td className={styles.caseText}>{testCase.actual}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ── Formatting ────────────────────────────────────────────────────

function formatMetric(unit: EvalUnit, value: number): string {
  switch (unit) {
    case "percent":
      return formatPercent(value);
    case "usd":
      return formatUsd(value);
    case "score":
      return value.toFixed(2);
    case "ms":
      return formatDuration(value);
    case "count":
      return String(value);
  }
}

/**
 * A difference of two rates is percentage points, not a percentage — 92.5% to
 * 95.8% is 3.3 pp, and calling it 3.3% would be wrong by a factor of about 28.
 */
function formatDeltaValue(metric: EvalMetric, absoluteDifference: number): string {
  if (metric.unit === "percent") return `${(absoluteDifference * 100).toFixed(1)} pp`;
  return formatMetric(metric.unit, absoluteDifference);
}

function RunItem({ label, value }: { label: string; value: string }) {
  return (
    <span className={styles.runItem}>
      <span className={styles.runLabel}>{label}</span>
      <span className={styles.runValue}>{value}</span>
    </span>
  );
}
