-- Merchants and their derived signals.
--
-- All merchant data in this repository is synthetic. The CHECK on
-- contact_email enforces that in the database rather than by convention:
-- a real address cannot be inserted even by mistake.

CREATE TABLE merchants (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    category            TEXT NOT NULL,
    city                TEXT NOT NULL,
    country_code        TEXT NOT NULL,
    locale              TEXT NOT NULL,
    website_url         TEXT,
    contact_email       TEXT NOT NULL,
    rating              NUMERIC(2, 1),
    review_count        INTEGER,
    years_in_business   INTEGER,
    has_active_offer    BOOLEAN NOT NULL DEFAULT FALSE,
    last_offer_ended_at TIMESTAMPTZ,
    seats_or_capacity   INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT merchants_category_valid CHECK (category IN (
        'restaurant', 'spa_wellness', 'fitness',
        'beauty', 'activity', 'class_workshop'
    )),
    -- ISO 3166-1 alpha-2.
    CONSTRAINT merchants_country_code_valid CHECK (country_code ~ '^[A-Z]{2}$'),
    -- Synthetic data only. See the note above.
    CONSTRAINT merchants_email_synthetic CHECK (contact_email LIKE '%@example.invalid'),
    CONSTRAINT merchants_rating_range CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
    CONSTRAINT merchants_review_count_nonneg CHECK (review_count IS NULL OR review_count >= 0),
    CONSTRAINT merchants_years_nonneg CHECK (years_in_business IS NULL OR years_in_business >= 0),
    CONSTRAINT merchants_capacity_positive CHECK (seats_or_capacity IS NULL OR seats_or_capacity > 0)
);

CREATE INDEX ix_merchants_category_city ON merchants (category, city);

-- Derived signals, stored as the JSON array defined by MerchantSignal[].
CREATE TABLE enrichments (
    merchant_id TEXT PRIMARY KEY REFERENCES merchants (id) ON DELETE CASCADE,
    signals     JSONB NOT NULL DEFAULT '[]'::jsonb,
    enriched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT enrichments_signals_is_array CHECK (jsonb_typeof(signals) = 'array')
);
