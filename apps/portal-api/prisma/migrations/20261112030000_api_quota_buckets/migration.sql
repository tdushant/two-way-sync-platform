-- Shared outbound quota. One row is the token bucket for every worker replica.
CREATE TABLE "api_quota_buckets" (
    "bucket" TEXT NOT NULL,
    "tokens" BIGINT NOT NULL,
    "max_tokens" BIGINT NOT NULL,
    "refill_per_second_milli" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "api_quota_buckets_pkey" PRIMARY KEY ("bucket"),
    CONSTRAINT "api_quota_buckets_nonnegative_check" CHECK (
        tokens >= 0
        AND max_tokens >= 0
        AND refill_per_second_milli >= 0
        AND tokens <= max_tokens
    )
);

-- 1000 tokens, refilled at 1000 per second. The spec's 80/s example is not a configured default.
INSERT INTO "api_quota_buckets" (
    "bucket", "tokens", "max_tokens", "refill_per_second_milli", "updated_at"
) VALUES (
    'external_api', 1000, 1000, 1000000, CURRENT_TIMESTAMP
);
