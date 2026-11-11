import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validatePortalApiEnv } from './env';

const valid = {
  NODE_ENV: 'test',
  PORTAL_HTTP_PORT: '3000',
  PORTAL_DATABASE_URL: 'postgresql://portal:portal@127.0.0.1:5432/portal',
};

describe('portal-api environment', () => {
  it('accepts the local portal database URL and ignores unrelated variables', () => {
    expect(validatePortalApiEnv({ ...valid, PATH: 'C:\\Windows' })).toEqual({
      NODE_ENV: 'test',
      PORTAL_HTTP_PORT: 3000,
      PORTAL_DATABASE_URL: valid.PORTAL_DATABASE_URL,
    });
  });

  it('defaults the port and NODE_ENV when they are omitted', () => {
    expect(validatePortalApiEnv({ PORTAL_DATABASE_URL: valid.PORTAL_DATABASE_URL })).toMatchObject({
      NODE_ENV: 'development',
      PORTAL_HTTP_PORT: 3000,
    });
  });

  it('rejects a missing database URL, a non-postgres URL, and a URL without a password', () => {
    expect(() => validatePortalApiEnv({ NODE_ENV: 'test' })).toThrow(/PORTAL_DATABASE_URL/);
    expect(() =>
      validatePortalApiEnv({
        ...valid,
        PORTAL_DATABASE_URL: 'mysql://portal:portal@localhost:5432/portal',
      }),
    ).toThrow(/PORTAL_DATABASE_URL/);
    expect(() =>
      validatePortalApiEnv({
        ...valid,
        PORTAL_DATABASE_URL: 'postgresql://localhost:5432/portal',
      }),
    ).toThrow(/PORTAL_DATABASE_URL/);
  });

  it('rejects a port outside 0..65535 and an unknown NODE_ENV', () => {
    expect(() => validatePortalApiEnv({ ...valid, PORTAL_HTTP_PORT: '70000' })).toThrow(
      /PORTAL_HTTP_PORT/,
    );
    expect(() => validatePortalApiEnv({ ...valid, PORTAL_HTTP_PORT: 'nope' })).toThrow(
      /PORTAL_HTTP_PORT/,
    );
    expect(() => validatePortalApiEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('keeps the example portal and salesforce databases on different users and ports', () => {
    const text = readFileSync(resolve(__dirname, '../../../.env.example'), 'utf8');
    const values = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('#') || line.length === 0) {
        continue;
      }
      const separator = line.indexOf('=');
      values.set(line.slice(0, separator), line.slice(separator + 1));
    }
    const portal = new URL(values.get('PORTAL_DATABASE_URL') ?? '');
    const salesforce = new URL(values.get('SALESFORCE_DATABASE_URL') ?? '');
    expect(portal.username).toBe('portal');
    expect(portal.pathname).toBe('/portal');
    expect(portal.port).toBe('5434');
    expect(salesforce.username).toBe('salesforce');
    expect(salesforce.pathname).toBe('/salesforce');
    expect(salesforce.port).toBe('5433');
    expect(portal.href).not.toBe(salesforce.href);
  });
});
