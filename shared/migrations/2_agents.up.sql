-- Agent output: triage decisions, drafts, and the raw log of model calls.
--
-- Token usage is stored per row rather than aggregated later. Cost in this
-- project is a summed quantity, never an estimate, so every row that came
-- from a model call carries the tokens it consumed.

CREATE TABLE triage_results (
    merchant_id         TEXT NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
    campaign_id         TEXT NOT NULL,
    score               INTEGER NOT NULL,
    confidence          DOUBLE PRECISION NOT NULL,
    reason              TEXT NOT NULL,
    recommended_action  TEXT NOT NULL,
    model               TEXT NOT NULL,
    escalated           BOOLEAN NOT NULL DEFAULT FALSE,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (merchant_id, campaign_id),
    CONSTRAINT triage_score_range CHECK (score BETWEEN 0 AND 100),
    CONSTRAINT triage_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
    -- Mirrors the `reason` length limit stated in the contracts.
    CONSTRAINT triage_reason_length CHECK (char_length(reason) <= 240),
    CONSTRAINT triage_action_valid CHECK (
        recommended_action IN ('pursue', 'skip', 'needs_human')
    )
);

CREATE INDEX ix_triage_campaign ON triage_results (campaign_id);

CREATE TABLE drafts (
    id                  TEXT PRIMARY KEY,
    merchant_id         TEXT NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
    campaign_id         TEXT NOT NULL,
    locale              TEXT NOT NULL,
    subject             TEXT NOT NULL,
    body                TEXT NOT NULL,
    -- EvidenceRef[]: every personalized claim and the merchant field it came from.
    evidence            JSONB NOT NULL DEFAULT '[]'::jsonb,
    model               TEXT NOT NULL,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT drafts_subject_not_blank CHECK (char_length(btrim(subject)) > 0),
    CONSTRAINT drafts_body_not_blank CHECK (char_length(btrim(body)) > 0),
    CONSTRAINT drafts_evidence_is_array CHECK (jsonb_typeof(evidence) = 'array')
);

CREATE INDEX ix_drafts_merchant_campaign ON drafts (merchant_id, campaign_id);

-- Every model call, including fixture replays. Keeping fixture and record
-- runs in the same table is deliberate: it is what makes a fixture run
-- comparable to a live one.
CREATE TABLE llm_calls (
    id                  TEXT PRIMARY KEY,
    campaign_id         TEXT,
    purpose             TEXT NOT NULL,
    model               TEXT NOT NULL,
    mode                TEXT NOT NULL,
    fixture_key         TEXT NOT NULL,
    latency_ms          INTEGER NOT NULL,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT llm_calls_mode_valid CHECK (mode IN ('live', 'fixture', 'record')),
    CONSTRAINT llm_calls_latency_nonneg CHECK (latency_ms >= 0)
);

CREATE INDEX ix_llm_calls_campaign ON llm_calls (campaign_id, created_at);
