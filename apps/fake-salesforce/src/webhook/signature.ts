import { createHmac } from 'node:crypto';

export const SALESFORCE_SIGNATURE_HEADER = 'X-Salesforce-Signature';

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

export function stableWebhookJson(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new Error('Webhook payload must be a JSON object');
  }
  const ordered: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) {
    if (!Object.hasOwn(payload, key)) {
      continue;
    }
    ordered[key] = key === 'changedFields' ? orderedFields(payload[key]) : payload[key];
  }
  return JSON.stringify(ordered);
}

export function signWebhookPayload(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function orderedFields(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('changedFields must be an object');
  }
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = value[key];
  }
  return ordered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
