-- Operator requests for one reconciliation pass. The worker claims the row.
-- The request itself does not move the changes cursor.
CREATE TABLE "sync_commands" (
    "id" UUID NOT NULL,
    "command" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "error" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "sync_commands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sync_commands_command_check" CHECK ("command" = 'reconciliation'),
    CONSTRAINT "sync_commands_status_check" CHECK (
        "status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')
    )
);

CREATE INDEX "sync_commands_status_requested_idx"
    ON "sync_commands" ("status", "requested_at");
