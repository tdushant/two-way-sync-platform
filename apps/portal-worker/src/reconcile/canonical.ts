import { parseWebhook } from '@sync/contracts';

const RECONCILIATION_CORRELATION_ID = '00000000-0000-4000-8000-0000000000a1';

const ENVELOPE_KEYS = [
  'eventId',
  'objectType',
  'recordId',
  'eventType',
  'changedFields',
  'changedBy',
  'recordVersion',
  'occurredAt',
  'originOperationId',
  'changeSequence',
] as const;

const REPLACEMENT_ACTOR = 'salesforce';

/**
 * Same key order as the fake Salesforce webhook signer. A replay of an event
 * that already arrived with a non-empty changedBy keeps that actor so the
 * payload hash matches. A null actor cannot pass the inbound contract, so the
 * body uses a stable stand-in; those deliveries never committed.
 */
export function inboundBody(row: Record<string, unknown>): string | undefined {
  const changedBy =
    typeof row.changedBy === 'string' && row.changedBy.length > 0
      ? row.changedBy
      : REPLACEMENT_ACTOR;
  const payload: Record<string, unknown> = {
    eventId: row.eventId,
    objectType: row.objectType,
    recordId: row.recordId,
    eventType: row.eventType,
    changedFields: row.changedFields,
    changedBy,
    recordVersion: row.recordVersion,
    occurredAt: row.occurredAt,
    originOperationId: Object.hasOwn(row, 'originOperationId') ? row.originOperationId : null,
    changeSequence: row.changeSequence,
  };
  const raw = stableWebhookJson(payload);
  const parsed = parseWebhook(JSON.parse(raw) as unknown, RECONCILIATION_CORRELATION_ID);
  return parsed.ok ? raw : undefined;
}

export function stableWebhookJson(payload: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) {
    if (!Object.hasOwn(payload, key)) {
      continue;
    }
    ordered[key] = key === 'changedFields' ? orderedFields(payload[key]) : payload[key];
  }
  return JSON.stringify(ordered);
}

function orderedFields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = Reflect.get(value, key);
  }
  return ordered;
}
