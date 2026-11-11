import type { SimulatorConfig } from '@sync/contracts';

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  outageEnabled: false,
  webhookEnabled: true,
  duplicateCount: 0,
  delayMs: 0,
  disorderMode: 'ordered',
  failureRate: 0,
  rateLimitPerSec: 1000,
  dropWebhookRate: 0,
  responseDelayMs: 0,
};
