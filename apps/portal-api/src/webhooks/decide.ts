export type InboundDecision = 'APPLIED' | 'REJECTED_STALE' | 'NOOP' | 'CONFLICT_LOST';

export interface StoredFieldState {
  source: string;
  sourceVersion: string;
  sourceChangedAt: Date;
}

export interface FieldVerdict {
  decision: InboundDecision;
  persistValue: boolean;
  persistVersion: boolean;
}

export function decideInboundField(input: {
  current: string | null;
  candidate: string | null;
  occurredAt: Date;
  recordVersion: number;
  state: StoredFieldState | null;
}): FieldVerdict {
  if (input.state?.source === 'SALESFORCE') {
    const stored = parseVersion(input.state.sourceVersion);
    if (stored !== undefined && input.recordVersion <= stored) {
      return { decision: 'REJECTED_STALE', persistValue: false, persistVersion: false };
    }
  } else if (
    input.state !== null &&
    input.occurredAt.getTime() < input.state.sourceChangedAt.getTime()
  ) {
    return { decision: 'CONFLICT_LOST', persistValue: false, persistVersion: false };
  }
  const unchanged = input.current === input.candidate;
  return {
    decision: unchanged ? 'NOOP' : 'APPLIED',
    persistValue: !unchanged,
    persistVersion: true,
  };
}

function parseVersion(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
