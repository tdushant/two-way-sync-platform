import { describe, expect, it } from '@jest/globals';
import { validateFakeSalesforceEnv } from './env';

const valid = {
  NODE_ENV: 'test',
  SALESFORCE_HTTP_PORT: '3001',
  SALESFORCE_DATABASE_URL: 'postgresql://salesforce:salesforce@127.0.0.1:5433/salesforce',
};

describe('fake-salesforce environment', () => {
  it('accepts the local salesforce database URL and ignores unrelated variables', () => {
    expect(validateFakeSalesforceEnv({ ...valid, PATH: 'C:\\Windows' })).toEqual({
      NODE_ENV: 'test',
      SALESFORCE_HTTP_PORT: 3001,
      SALESFORCE_DATABASE_URL: valid.SALESFORCE_DATABASE_URL,
    });
  });

  it('defaults the port to 3001', () => {
    expect(
      validateFakeSalesforceEnv({
        NODE_ENV: 'test',
        SALESFORCE_DATABASE_URL: valid.SALESFORCE_DATABASE_URL,
      }),
    ).toMatchObject({ SALESFORCE_HTTP_PORT: 3001 });
  });

  it('rejects a portal-shaped URL that has no password and a missing database URL', () => {
    expect(() => validateFakeSalesforceEnv({ NODE_ENV: 'test' })).toThrow(
      /SALESFORCE_DATABASE_URL/,
    );
    expect(() =>
      validateFakeSalesforceEnv({
        ...valid,
        SALESFORCE_DATABASE_URL: 'postgresql://portal@127.0.0.1:5432/portal',
      }),
    ).toThrow(/SALESFORCE_DATABASE_URL/);
  });
});
