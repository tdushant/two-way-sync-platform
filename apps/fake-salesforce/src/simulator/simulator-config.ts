import type { SimulatorConfig } from '@sync/contracts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { DEFAULT_SIMULATOR_CONFIG } from './defaults';

type ConfigStore = PrismaClient | Prisma.TransactionClient;

export async function readSimulatorConfig(store: ConfigStore): Promise<SimulatorConfig> {
  const row = await store.sfSimulatorConfig.findUnique({ where: { id: 1 } });
  if (!row) {
    return { ...DEFAULT_SIMULATOR_CONFIG };
  }
  return {
    outageEnabled: row.outageEnabled,
    webhookEnabled: row.webhookEnabled,
    duplicateCount: row.duplicateCount,
    delayMs: row.delayMs,
    disorderMode: row.disorderMode,
    failureRate: finiteNumber(row.failureRate),
    rateLimitPerSec: finiteNumber(row.rateLimitPerSec),
    dropWebhookRate: finiteNumber(row.dropWebhookRate),
    responseDelayMs: row.responseDelayMs,
  };
}

function finiteNumber(value: { toString(): string } | number): number {
  const number = typeof value === 'number' ? value : Number(value.toString());
  if (!Number.isFinite(number)) {
    throw new Error('simulator rate is not a finite number');
  }
  return number;
}
