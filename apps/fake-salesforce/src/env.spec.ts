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
      PORTAL_WEBHOOK_URL: 'http://127.0.0.1:3000/webhooks/salesforce',
      WEBHOOK_HMAC_SECRET: 'local-webhook-secret',
      SIMULATOR_ADMIN_TOKEN: 'local-simulator-token',
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
    expect(() => validateFakeSalesforceEnv({ ...valid, PORTAL_WEBHOOK_URL: 'not-a-url' })).toThrow(
      /PORTAL_WEBHOOK_URL/,
    );
  });

  it('requires real webhook settings in production', () => {
    expect(() =>
      validateFakeSalesforceEnv({
        NODE_ENV: 'production',
        SALESFORCE_HTTP_PORT: '3001',
        SALESFORCE_DATABASE_URL: valid.SALESFORCE_DATABASE_URL,
      }),
    ).toThrow(/PORTAL_WEBHOOK_URL/);
    expect(() =>
      validateFakeSalesforceEnv({
        NODE_ENV: 'production',
        SALESFORCE_HTTP_PORT: '3001',
        SALESFORCE_DATABASE_URL: valid.SALESFORCE_DATABASE_URL,
        PORTAL_WEBHOOK_URL: 'https://portal.example/webhooks/salesforce',
        WEBHOOK_HMAC_SECRET: 'local-webhook-secret',
        SIMULATOR_ADMIN_TOKEN: 'prod-token',
      }),
    ).toThrow(/WEBHOOK_HMAC_SECRET/);
    expect(
      validateFakeSalesforceEnv({
        NODE_ENV: 'production',
        SALESFORCE_HTTP_PORT: '3001',
        SALESFORCE_DATABASE_URL: valid.SALESFORCE_DATABASE_URL,
        PORTAL_WEBHOOK_URL: 'https://portal.example/webhooks/salesforce',
        WEBHOOK_HMAC_SECRET: 'prod-secret',
        SIMULATOR_ADMIN_TOKEN: 'prod-token',
      }),
    ).toMatchObject({
      PORTAL_WEBHOOK_URL: 'https://portal.example/webhooks/salesforce',
      WEBHOOK_HMAC_SECRET: 'prod-secret',
      SIMULATOR_ADMIN_TOKEN: 'prod-token',
    });
  });
});
