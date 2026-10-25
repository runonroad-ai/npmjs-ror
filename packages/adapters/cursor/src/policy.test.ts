import type { CompiledPolicy, CompiledRule } from '@runonroad/claude-code';
import { describe, expect, it } from 'vitest';

import { cliDeny, cursorOperations, withFrontmatter } from './index.js';

const base = { source: 'g@1', reason: 'because', required: true } as const;
const policy: CompiledPolicy = {
  schema_version: 1,
  principal: 'mem_a',
  mcp_allow: [],
  rules: [
    { ...base, id: 'g@1:vault', kind: 'path', decision: 'forbid', access: 'any', glob: 'vault/**' },
    { ...base, id: 'g@1:dist', kind: 'path', decision: 'forbid', access: 'write', glob: 'dist' },
    {
      ...base,
      id: 'g@1:push',
      kind: 'command',
      decision: 'forbid',
      executable: 'git',
      argv_prefix: ['push'],
      flags_any: ['--force'],
    },
  ],
};

describe('the Cursor adapter (experimental)', () => {
  it('turns the rules into the CLI permission strings', () => {
    expect(cliDeny(policy)).toEqual([
      'Read(${project}/vault/**)',
      'Shell(git push)',
      'Write(${project}/dist)',
      'Write(${project}/vault/**)',
    ]);
  });

  it('writes an always-applied rule file with its frontmatter', () => {
    expect(withFrontmatter('x')).toBe(
      '---\ndescription: RunOnRoad governance\nalwaysApply: true\n---\nx',
    );
    const operations = cursorOperations([], 'en');
    expect(operations[0]).toMatchObject({ path: '${project}/.cursor/rules/ror-governance.mdc' });
    expect(operations.slice(1).map((operation) => operation.op)).toEqual([
      'git_exclude',
      'git_exclude',
    ]);
  });
});

describe('content rules (ADR-0088)', () => {
  it('add nothing to the CLI deny list', () => {
    const content: CompiledRule = {
      ...base,
      id: 'g@1:discount',
      kind: 'content',
      decision: 'forbid',
      topic: 'discount',
      text: 'No discount above 5 %.',
      subject_aliases: ['remise'],
      scopes: ['prompt'],
      mode: 'block',
      constraint: { kind: 'forbidden_terms', terms: ['remise'], context_exceptions: [] },
      alternatives: [],
    };
    expect(cliDeny({ ...policy, rules: [content] })).toEqual([]);
  });
});
