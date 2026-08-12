-- Gate reports. One report per draft, holding the outcome of every gate.
--
-- Failures are kept, not discarded: a blocked draft is the raw material for
-- the eval suite, so the reason it was blocked has to survive.

CREATE TABLE gate_reports (
    draft_id     TEXT PRIMARY KEY REFERENCES drafts (id) ON DELETE CASCADE,
    -- GateOutcome[]: one entry per gate that ran.
    outcomes     JSONB NOT NULL,
    blocked      BOOLEAN NOT NULL,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms  INTEGER NOT NULL,

    CONSTRAINT gate_reports_outcomes_is_array CHECK (jsonb_typeof(outcomes) = 'array'),
    CONSTRAINT gate_reports_duration_nonneg CHECK (duration_ms >= 0)
);

-- The dashboard's most common query: "show me what the agent got wrong".
CREATE INDEX ix_gate_reports_blocked ON gate_reports (evaluated_at) WHERE blocked;
