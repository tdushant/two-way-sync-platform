import { describe, expect, it } from '@jest/globals';
import { validatePortalWorkerEnv } from './env';

const valid = {
  NODE_ENV: 'test',
  PORTAL_DATABASE_URL: 'postgresql://portal:portal@127.0.0.1:5432/portal',
  FAKE_SALESFORCE_BASE_URL: 'http://127.0.0.1:3001',
  OUTBOUND_BUDGET_PER_SECOND: 80,
};

describe('portal-worker environment', () => {
  it('accepts the portal database URL and the fake Salesforce base URL', () => {
    expect(validatePortalWorkerEnv({ ...valid, PATH: 'C:\\Windows' })).toEqual(valid);
  });

  it('rejects a missing database URL and a non-http base URL', () => {
    expect(() =>
      validatePortalWorkerEnv({ FAKE_SALESFORCE_BASE_URL: valid.FAKE_SALESFORCE_BASE_URL }),
    ).toThrow(/PORTAL_DATABASE_URL/);
    expect(() =>
      validatePortalWorkerEnv({ ...valid, FAKE_SALESFORCE_BASE_URL: 'ftp://127.0.0.1:3001' }),
    ).toThrow(/FAKE_SALESFORCE_BASE_URL/);
    expect(() => validatePortalWorkerEnv({ ...valid, OUTBOUND_BUDGET_PER_SECOND: 101 })).toThrow(
      /OUTBOUND_BUDGET_PER_SECOND/,
    );
    expect(
      validatePortalWorkerEnv({ ...valid, OUTBOUND_BUDGET_PER_SECOND: undefined })
        .OUTBOUND_BUDGET_PER_SECOND,
    ).toBe(80);
  });
});
