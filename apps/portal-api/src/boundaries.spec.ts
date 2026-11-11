import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('portal-api package boundary', () => {
  it('does not depend on the fake-salesforce package', () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(names.some((name) => name.includes('fake-salesforce'))).toBe(false);
  });

  it('declares separate database services in compose', () => {
    const compose = readFileSync(resolve(__dirname, '../../../infra/docker-compose.yml'), 'utf8');
    expect(compose).toContain('POSTGRES_USER: portal');
    expect(compose).toContain('POSTGRES_USER: salesforce');
    expect(compose).toContain('POSTGRES_DB: portal');
    expect(compose).toContain('POSTGRES_DB: salesforce');
    expect(compose).toContain('5434:5432');
    expect(compose).toContain('5433:5432');
    expect(compose).toContain('portal-db-data:');
    expect(compose).toContain('salesforce-db-data:');
    expect(compose).toContain('pg_isready -U portal -d portal');
    expect(compose).toContain('pg_isready -U salesforce -d salesforce');
  });
});
