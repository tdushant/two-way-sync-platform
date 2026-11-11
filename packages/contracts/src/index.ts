import type { HealthState } from './enums';

export {
  ERROR_CODES,
  EVENT_TYPES,
  FIELD_DECISIONS,
  FIELD_SOURCES,
  HEALTH_STATES,
  OBJECT_TYPES,
  OPERATION_STATUSES,
  OUTBOX_STATUSES,
  PORTAL_ENTITY_TYPES,
  PROCESSED_EVENT_STATUSES,
  type ErrorCode,
  type EventType,
  type FieldDecision,
  type FieldSource,
  type HealthState,
  type ObjectType,
  type OperationStatus,
  type OutboxStatus,
  type PortalEntityType,
  type ProcessedEventStatus,
} from './enums';

export interface ProcessHealth {
  status: HealthState;
}

export { apiError, parseApiError, type ApiError, type ContractResult } from './errors';
export { isUtcTimestamp, isUuid } from './ids';
export {
  CUSTOMER_RESPONSE_FIELDS,
  CUSTOMER_WRITE_FIELDS,
  parseAccountPatch,
  parseCreateAccount,
  parseCreateCustomer,
  parseCustomer,
  parseCustomerPatch,
  type AccountPatch,
  type CreateAccount,
  type CreateCustomer,
  type Customer,
  type CustomerPatch,
} from './customers';
export {
  CONTACT_PATCH_FIELDS,
  CONTACT_RESPONSE_FIELDS,
  CONTACT_WRITE_FIELDS,
  parseContact,
  parseContactPatch,
  parseCreateContact,
  type Contact,
  type ContactPatch,
  type CreateContact,
} from './contacts';
export {
  SF_CONTACT_FIELDS,
  parseChangesQuery,
  parseCreateSfContact,
  parseReorderDeliveries,
  parseSfContactPatch,
  parseSimulatorConfig,
  type ChangesQuery,
  type CreateSfContact,
  type ReorderDeliveries,
  type SfContactPatch,
  type SimulatorConfig,
} from './salesforce';
export { parseWebhook, type CanonicalWebhook } from './webhook';
export {
  IDEMPOTENCY_KEY_HEADER,
  parseHistoryEntry,
  parseIdempotencyKey,
  parseIfMatch,
  parseOperationId,
  parseOutboxStatus,
  parseSyncHealth,
  type HistoryEntry,
  type SyncHealth,
} from './sync';
