-- Prisma models these rates as Decimal. Unqualified NUMERIC is not a stable Prisma type.
ALTER TABLE "sf_simulator_config"
  ALTER COLUMN "failure_rate" SET DATA TYPE DECIMAL(65,30),
  ALTER COLUMN "rate_limit_per_sec" SET DATA TYPE DECIMAL(65,30),
  ALTER COLUMN "drop_webhook_rate" SET DATA TYPE DECIMAL(65,30);
