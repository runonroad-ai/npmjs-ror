import { describe, expect, it } from 'vitest';

import { codexOperations } from './index.js';

describe('what the server compiles for Codex', () => {
  it('is the project layer only: the instruction file and its git exclusion', () => {
    const operations = codexOperations(
      [
        {
          document: {
            rhs: 1,
            governance: { slug: 'g', name: 'G', version: '1.0.0', locale: 'en' },
            context: {
              preamble: 'Hi',
              allowed: '',
              preferred: '',
              ask_first: '',
              forbidden: 'No vault.',
            },
          },
          version: '1.0.0',
          assignments: [{ id: 'a1', layer: 'org' }],
          winner: true,
        } as never,
      ],
      'en',
    );
    expect(operations.map((operation) => operation.op)).toEqual(['write_file', 'git_exclude']);
    expect(operations[0]).toMatchObject({
      path: '${project}/.runonroad/instructions/ror-governance.md',
    });
    expect(operations[0]).toMatchObject({
      content: expect.stringContaining('No vault.') as string,
    });
  });
});
