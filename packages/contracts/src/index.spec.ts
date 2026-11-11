import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HEALTH_STATES } from './index';

describe('process health contract', () => {
  it('exposes the live and ready states', () => {
    expect(HEALTH_STATES).toEqual(['ok', 'error']);
  });

  it('does not depend on Nest, Prisma, or a database client', () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const names = Object.keys(manifest.dependencies ?? {});
    expect(names.sort()).toEqual(['class-validator', 'reflect-metadata']);
    expect(
      names.some((name) => name.includes('prisma') || name === 'pg' || name.startsWith('@nestjs')),
    ).toBe(false);
  });
});
