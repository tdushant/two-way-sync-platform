export const HEALTH_STATES = ['ok', 'error'] as const;

export type HealthState = (typeof HEALTH_STATES)[number];

export interface ProcessHealth {
  status: HealthState;
}
