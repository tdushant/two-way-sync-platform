-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "sf_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT,
    "owner_id" TEXT,
    "version" BIGINT NOT NULL,
    "system_modstamp" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sf_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sf_contacts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "full_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "city" TEXT,
    "owner_id" TEXT,
    "version" BIGINT NOT NULL,
    "system_modstamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sf_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sf_change_log" (
    "sequence" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "object_type" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "changed_fields" JSONB NOT NULL,
    "changed_by" TEXT,
    "values" JSONB,
    "version" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "origin_operation_id" UUID,

    CONSTRAINT "sf_change_log_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "sf_webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "change_sequence" BIGINT NOT NULL,
    "event_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL,
    "last_http_status" INTEGER,
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sf_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sf_simulator_config" (
    "id" INTEGER NOT NULL,
    "outage_enabled" BOOLEAN NOT NULL,
    "webhook_enabled" BOOLEAN NOT NULL,
    "duplicate_count" INTEGER NOT NULL,
    "delay_ms" INTEGER NOT NULL,
    "disorder_mode" TEXT NOT NULL,
    "failure_rate" NUMERIC NOT NULL,
    "rate_limit_per_sec" NUMERIC NOT NULL,
    "drop_webhook_rate" NUMERIC NOT NULL,
    "response_delay_ms" INTEGER NOT NULL,

    CONSTRAINT "sf_simulator_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sf_api_request_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "operation_id" UUID,
    "status_code" INTEGER NOT NULL,
    "request_at" TIMESTAMPTZ(6) NOT NULL,
    "latency_ms" INTEGER NOT NULL,

    CONSTRAINT "sf_api_request_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sf_contacts_account_id_idx" ON "sf_contacts"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sf_change_log_event_id_key" ON "sf_change_log"("event_id");

-- CreateIndex
CREATE INDEX "sf_webhook_deliveries_status_scheduled_idx" ON "sf_webhook_deliveries"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "sf_webhook_deliveries_event_id_idx" ON "sf_webhook_deliveries"("event_id");

-- AddForeignKey
ALTER TABLE "sf_contacts" ADD CONSTRAINT "sf_contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "sf_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prisma Migrate does not model CHECK. object_type is the closed Account/Contact vocabulary.
-- Delivery status and disorder_mode stay unconstrained because those vocabularies are open.
ALTER TABLE "sf_change_log" ADD CONSTRAINT "sf_change_log_object_type_check" CHECK (object_type IN ('Account', 'Contact'));

ALTER TABLE "sf_simulator_config" ADD CONSTRAINT "sf_simulator_config_id_check" CHECK (id = 1);
