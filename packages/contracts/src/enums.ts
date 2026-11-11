export const HEALTH_STATES = ['ok', 'error'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const OBJECT_TYPES = ['Account', 'Contact'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export const EVENT_TYPES = ['created', 'updated'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const FIELD_SOURCES = ['PORTAL', 'SALESFORCE'] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

export const FIELD_DECISIONS = ['APPLIED', 'REJECTED_STALE', 'NOOP', 'CONFLICT_LOST'] as const;
export type FieldDecision = (typeof FIELD_DECISIONS)[number];

export const OUTBOX_STATUSES = ['PENDING', 'IN_FLIGHT', 'RETRY', 'COMPLETED', 'DEAD'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const OPERATION_STATUSES = ['PENDING', 'SENT', 'ACKED', 'FAILED'] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const PROCESSED_EVENT_STATUSES = ['PROCESSING', 'APPLIED', 'IGNORED', 'FAILED'] as const;
export type ProcessedEventStatus = (typeof PROCESSED_EVENT_STATUSES)[number];

export const ERROR_CODES = [
  'validation_failed',
  'unknown_field',
  'invalid_signature',
  'integrity_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const PORTAL_ENTITY_TYPES = ['customer', 'contact'] as const;
export type PortalEntityType = (typeof PORTAL_ENTITY_TYPES)[number];

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}
