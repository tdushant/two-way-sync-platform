/** Working assumptions for OD-TIMING. The lease outlives one HTTP attempt. */
export const LEASE_MS = 30_000;
export const HTTP_TIMEOUT_MS = 5_000;
export const POLL_MS = 1_000;
export const PARENT_WAIT_MS = 60_000;
export const QUOTA_WAIT_MS = 1_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
export const QUOTA_BUCKET = 'external_api';

export interface FieldMap {
  [field: string]: string | null;
}

export interface SyncVersion {
  fieldName: string;
  source: string;
  sourceVersion: string;
}

export function backoffMs(attempts: number, jitterUnit: number): number {
  const exponent = Math.max(0, attempts - 1);
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
  const unit = Math.min(1, Math.max(0, jitterUnit));
  const jitter = Math.floor(unit * BACKOFF_BASE_MS);
  return Math.min(BACKOFF_CAP_MS, exponential + jitter);
}

/** Integer seconds only. HTTP-date is left open by OD-RETRY-AFTER. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null || !/^(0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function retryDelayMs(
  attempts: number,
  jitterUnit: number,
  retryAfterSeconds: number | undefined,
): number {
  const backoff = backoffMs(attempts, jitterUnit);
  if (retryAfterSeconds === undefined) {
    return backoff;
  }
  return Math.max(backoff, retryAfterSeconds * 1000);
}

export type RemoteClass = 'success' | 'retry' | 'dead';

export function classifyStatus(status: number): RemoteClass {
  if (status >= 200 && status < 300) {
    return 'success';
  }
  if (status === 408 || status === 429 || status >= 500) {
    return 'retry';
  }
  return 'dead';
}

export function selectOutboundFields(input: {
  eventType: string;
  changedFields: FieldMap;
  baseFields: Record<string, string>;
  current: FieldMap;
  sync: SyncVersion[];
}): { send: FieldMap; superseded: string[] } {
  if (input.eventType === 'created') {
    return { send: { ...input.changedFields }, superseded: [] };
  }
  const versions = new Map(input.sync.map((row) => [row.fieldName, row]));
  const send: FieldMap = {};
  const superseded: string[] = [];
  for (const [field, snapshot] of Object.entries(input.changedFields)) {
    const state = versions.get(field);
    const base = versionOf(input.baseFields[field]);
    const currentVersion = versionOf(state?.sourceVersion);
    const newerPortalWrite =
      state?.source === 'PORTAL' &&
      base !== undefined &&
      currentVersion !== undefined &&
      currentVersion > base;
    const valueMoved = (input.current[field] ?? null) !== snapshot;
    if (newerPortalWrite || valueMoved) {
      superseded.push(field);
      continue;
    }
    send[field] = snapshot;
  }
  return { send, superseded };
}

export function wireBody(
  entityType: string,
  fields: FieldMap,
  parentSalesforceId: string | null,
): { body: FieldMap; pendingParent: boolean } {
  if (entityType === 'customer') {
    return { body: pick(fields, ['name', 'status', 'ownerId']), pendingParent: false };
  }
  const body = pick(fields, ['fullName', 'email', 'phone', 'city', 'ownerId']);
  if (!Object.hasOwn(fields, 'customerId')) {
    return { body, pendingParent: false };
  }
  if (parentSalesforceId === null) {
    return { body, pendingParent: true };
  }
  body.accountId = parentSalesforceId;
  return { body, pendingParent: false };
}

export function readExternalId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('id' in body)) {
    return undefined;
  }
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function fieldMap(value: unknown): FieldMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const map: FieldMap = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'string') {
      map[key] = item;
    }
  }
  return map;
}

export function baseFieldVersions(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || !('fields' in value)) {
    return {};
  }
  return fieldVersions((value as { fields?: unknown }).fields);
}

function fieldVersions(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const map: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      map[key] = item;
    } else if (typeof item === 'number' && Number.isSafeInteger(item)) {
      map[key] = String(item);
    }
  }
  return map;
}

function versionOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function pick(fields: FieldMap, names: string[]): FieldMap {
  const chosen: FieldMap = {};
  for (const name of names) {
    if (Object.hasOwn(fields, name)) {
      const value = fields[name];
      if (value !== undefined) {
        chosen[name] = value;
      }
    }
  }
  return chosen;
}
