-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "salesforce_id" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "owner_id" TEXT,
    "row_version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "salesforce_id" TEXT,
    "customer_id" UUID NOT NULL,
    "full_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "city" TEXT,
    "owner_id" TEXT,
    "row_version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "field_name" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "source" TEXT NOT NULL,
    "actor_id" TEXT,
    "event_id" TEXT,
    "operation_id" UUID,
    "source_changed_at" TIMESTAMPTZ(6),
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" TEXT NOT NULL,

    CONSTRAINT "field_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "entity_type" TEXT,
    "external_id" TEXT,
    "status" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operation_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "changed_fields" JSONB NOT NULL,
    "base_versions" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_sync_state" (
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "field_name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_version" TEXT NOT NULL,
    "source_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_applied_at" TIMESTAMPTZ(6) NOT NULL,
    "last_operation_id" UUID,

    CONSTRAINT "field_sync_state_pkey" PRIMARY KEY ("entity_type","entity_id","field_name")
);

-- CreateTable
CREATE TABLE "sync_checkpoints" (
    "stream_name" TEXT NOT NULL,
    "cursor" TEXT,
    "last_success_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_checkpoints_pkey" PRIMARY KEY ("stream_name")
);

-- CreateTable
CREATE TABLE "sync_operations" (
    "operation_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "fields" JSONB NOT NULL,
    "expected_values" JSONB NOT NULL,
    "external_id" TEXT,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("operation_id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL,
    "from_cursor" TEXT,
    "to_cursor" TEXT,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_salesforce_id_key" ON "customers"("salesforce_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_salesforce_id_key" ON "contacts"("salesforce_id");

-- CreateIndex
CREATE INDEX "contacts_customer_id_idx" ON "contacts"("customer_id");

-- CreateIndex
CREATE INDEX "field_history_entity_applied_idx" ON "field_history"("entity_type", "entity_id", "applied_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_operation_id_key" ON "outbox_events"("operation_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_idx" ON "outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_events_due_idx" ON "outbox_events"("next_attempt_at", "id") WHERE (status IN ('PENDING', 'RETRY'));

-- CreateIndex
CREATE INDEX "outbox_events_lease_idx" ON "outbox_events"("lease_until") WHERE (status = 'IN_FLIGHT');

-- CreateIndex
CREATE INDEX "sync_operations_external_status_idx" ON "sync_operations"("external_id", "status");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prisma Migrate does not model CHECK. These match the closed vocabularies in the spec.
-- reconciliation_runs.status is intentionally unconstrained (OD-RECON-STATUS).
ALTER TABLE "field_history" ADD CONSTRAINT "field_history_source_check" CHECK (source IN ('PORTAL', 'SALESFORCE'));

ALTER TABLE "field_history" ADD CONSTRAINT "field_history_decision_check" CHECK (decision IN ('APPLIED', 'REJECTED_STALE', 'NOOP', 'CONFLICT_LOST'));

ALTER TABLE "processed_events" ADD CONSTRAINT "processed_events_status_check" CHECK (status IN ('PROCESSING', 'APPLIED', 'IGNORED', 'FAILED'));

ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_status_check" CHECK (status IN ('PENDING', 'IN_FLIGHT', 'RETRY', 'COMPLETED', 'DEAD'));

ALTER TABLE "field_sync_state" ADD CONSTRAINT "field_sync_state_source_check" CHECK (source IN ('PORTAL', 'SALESFORCE'));

ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_status_check" CHECK (status IN ('PENDING', 'SENT', 'ACKED', 'FAILED'));
