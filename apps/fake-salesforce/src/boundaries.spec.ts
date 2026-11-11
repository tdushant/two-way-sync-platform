import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('fake-salesforce package boundary', () => {
  it('does not depend on portal packages', () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(names.some((name) => name.includes('portal'))).toBe(false);
  });
});
