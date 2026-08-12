-- Outreach attempts and the outbox.
--
-- This is where "a message cannot be sent twice" is actually enforced.
-- Not in application logic, not in code review — here, in two indexes.

CREATE TABLE outreach_attempts (
    id                  TEXT PRIMARY KEY,
    merchant_id         TEXT NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
    campaign_id         TEXT NOT NULL,
    draft_id            TEXT NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
    state               TEXT NOT NULL,
    -- sha256(merchantId|campaignId|contentHash), computed by the approval service.
    dedup_key           TEXT NOT NULL,
    approved_by         TEXT,
    approved_at         TIMESTAMPTZ,
    sent_at             TIMESTAMPTZ,
    provider_message_id TEXT,
    failure_reason      TEXT,
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT attempts_state_valid CHECK (state IN (
        'INGESTED', 'TRIAGED', 'DRAFTED', 'GATED', 'BLOCKED',
        'PENDING_APPROVAL', 'REJECTED', 'APPROVED',
        'QUEUED', 'SENT', 'FAILED'
    )),
    CONSTRAINT attempts_count_nonneg CHECK (attempt_count >= 0),
    -- A SENT row without a provider receipt would make the send unverifiable.
    CONSTRAINT attempts_sent_requires_receipt CHECK (
        state <> 'SENT' OR (sent_at IS NOT NULL AND provider_message_id IS NOT NULL)
    ),
    -- Likewise, APPROVED and everything downstream must record who approved it.
    CONSTRAINT attempts_approved_requires_approver CHECK (
        state NOT IN ('APPROVED', 'QUEUED', 'SENT')
        OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
    )
);

-- Same merchant, same campaign, same content => same key => one row, ever.
CREATE UNIQUE INDEX uq_attempt_dedup
    ON outreach_attempts (dedup_key);

-- The load-bearing one. A partial unique index makes a second send to the
-- same merchant in the same campaign impossible at the database level.
-- Retries can rewrite a FAILED row, but the moment one row reaches SENT no
-- other row for that pair can follow it.
CREATE UNIQUE INDEX uq_attempt_sent
    ON outreach_attempts (merchant_id, campaign_id)
    WHERE state = 'SENT';

-- Approval queue lookup: everything a human still has to decide on.
CREATE INDEX ix_attempts_pending
    ON outreach_attempts (campaign_id, created_at)
    WHERE state IN ('PENDING_APPROVAL', 'BLOCKED');

-- Transactional outbox. Rows are written in the same transaction that moves
-- an attempt to QUEUED, then claimed by the sender with a conditional UPDATE
-- so two workers can never claim the same row.
CREATE TABLE outbox (
    id            TEXT PRIMARY KEY,
    attempt_id    TEXT NOT NULL REFERENCES outreach_attempts (id) ON DELETE CASCADE,
    payload       JSONB NOT NULL,
    -- Passed to the provider so a retried delivery is a no-op on their side too.
    idempotency_key TEXT NOT NULL,
    claimed_at    TIMESTAMPTZ,
    processed_at  TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT outbox_attempt_count_nonneg CHECK (attempt_count >= 0),
    CONSTRAINT outbox_processed_implies_claimed CHECK (
        processed_at IS NULL OR claimed_at IS NOT NULL
    )
);

-- One outbox row per attempt: enqueuing twice is a no-op, not a double send.
CREATE UNIQUE INDEX uq_outbox_attempt ON outbox (attempt_id);

-- Claim-by-update scan path: unprocessed rows, oldest first.
CREATE INDEX ix_outbox_claimable
    ON outbox (created_at)
    WHERE processed_at IS NULL;
