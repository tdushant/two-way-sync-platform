-- Global outbound and reconciliation budget. Webhook dispatch keeps its own limiter.
ALTER TABLE "api_quota_buckets"
    ADD COLUMN "blocked_until" TIMESTAMPTZ(6),
    ADD COLUMN "granted_total" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "denied_total" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "outbound_granted_total" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "reconciliation_granted_total" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "retry_after_total" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "api_quota_buckets"
    ADD CONSTRAINT "api_quota_buckets_totals_check" CHECK (
        granted_total >= 0
        AND denied_total >= 0
        AND outbound_granted_total >= 0
        AND reconciliation_granted_total >= 0
        AND retry_after_total >= 0
        AND granted_total = outbound_granted_total + reconciliation_granted_total
    );

-- 80 requests/s under the fake Salesforce 100/s cap. Refill is millitokens per second.
UPDATE "api_quota_buckets"
SET tokens = LEAST(tokens, 80),
    max_tokens = 80,
    refill_per_second_milli = 80000
WHERE bucket = 'external_api';
