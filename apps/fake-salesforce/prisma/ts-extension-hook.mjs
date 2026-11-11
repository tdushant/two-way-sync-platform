import { existsSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return nextResolve(specifier, context);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const tsSpecifier = specifier.endsWith('.ts') ? specifier : `${specifier}.ts`;
    const parentUrl = context.parentURL;
    if (parentUrl && existsSync(fileURLToPath(new URL(tsSpecifier, parentUrl)))) {
      return nextResolve(tsSpecifier, context);
    }
    throw error;
  }
}
