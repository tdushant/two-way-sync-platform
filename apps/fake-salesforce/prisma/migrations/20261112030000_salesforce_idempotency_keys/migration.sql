-- Accepts the documented sf_idempotency_keys proposal (OD-SF-IDEMP).
-- The key is claimed in the same transaction as the record and its change-log row.

CREATE TABLE "sf_idempotency_keys" (
    "operation_id" UUID NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "record_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sf_idempotency_keys_pkey" PRIMARY KEY ("operation_id")
);
