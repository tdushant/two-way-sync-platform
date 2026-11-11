-- Accepts the documented client_idempotency_keys proposal (OD-IDEMP).
-- The key is claimed in the same transaction as the entity and the outbox row.

CREATE TABLE "client_idempotency_keys" (
    "scope" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_idempotency_keys_pkey" PRIMARY KEY ("scope", "idempotency_key")
);
