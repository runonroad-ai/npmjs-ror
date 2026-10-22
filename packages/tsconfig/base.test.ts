import { describe, expect, it } from 'vitest';

import base from './base.json' with { type: 'json' };

// The strictness flags are a contract of TASK-1 (ADR-0003): every workspace
// extends this file, so loosening it silently weakens the whole monorepo.
describe('@runonroad/tsconfig base.json', () => {
  it.each(['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes'] as const)(
    'enables %s',
    (flag) => {
      expect(base.compilerOptions[flag]).toBe(true);
    },
  );

  it('targets Node modules resolution', () => {
    expect(base.compilerOptions.module).toBe('NodeNext');
    expect(base.compilerOptions.moduleResolution).toBe('NodeNext');
  });
});
