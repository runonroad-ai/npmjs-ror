import type { CompiledPolicy, CompiledRule } from '@runonroad/claude-code';
import { describe, expect, it } from 'vitest';

import {
  GLOB_SCAN_MAX_DEPTH,
  hasInteriorDoubleStar,
  mergeEntries,
  prefixPatterns,
  profileBlock,
  profileEntries,
  rulesFile,
} from './policy.js';

const base = { source: 'g@1', reason: 'because', required: true };
const policy = (
  rules: CompiledPolicy['rules'],
  derogations: CompiledPolicy['derogations'] = [],
): CompiledPolicy => ({ schema_version: 1, principal: 'mem_a', rules, mcp_allow: [], derogations });

const vault: CompiledRule = {
  ...base,
  id: 'g@1:vault',
  kind: 'path',
  decision: 'forbid',
  access: 'any',
  glob: 'vault/**',
};
const dist: CompiledRule = {
  ...base,
  id: 'g@1:dist',
  kind: 'path',
  decision: 'forbid',
  access: 'write',
  glob: 'dist',
};
const push: CompiledRule = {
  ...base,
  id: 'g@1:push',
  kind: 'command',
  decision: 'forbid',
  executable: 'git',
  argv_prefix: ['push'],
  flags_any: ['--force', '-f'],
};
const askRm: CompiledRule = {
  ...base,
  id: 'g@1:rm',
  kind: 'command',
  decision: 'ask',
  executable: 'rm',
  argv_prefix: [],
  flags_any: [],
};

describe('the rules file', () => {
  it('turns a command rule into one forbidden prefix per flag', () => {
    expect(prefixPatterns(push)).toEqual([
      ['git', 'push', '--force'],
      ['git', 'push', '-f'],
    ]);
    const text = rulesFile(policy([push]));
    expect(text).toContain('# Managed by RunOnRoad');
    expect(text).toContain('prefix_rule(pattern=["git", "push", "--force"], decision="forbidden"');
    expect(text).toContain('Blocked by RunOnRoad rule g@1:push: because');
  });

  it('keeps an Ask-first rule forbidden until a lease lifts it, and never lifts a forbid', () => {
    expect(rulesFile(policy([askRm]))).toContain('pattern=["rm"]');
    const lifted = [{ rule_id: askRm.id, expires_at: '2030-01-01T00:00:00.000Z' }];
    expect(rulesFile(policy([askRm], lifted))).not.toContain('"rm"');
    const forged = [{ rule_id: push.id, expires_at: '2030-01-01T00:00:00.000Z' }];
    expect(rulesFile(policy([push], forged))).toContain('"--force"');
  });

  it('writes a reason as one safe string, whatever it holds', () => {
    const text = rulesFile(policy([{ ...push, reason: 'a "quoted"\nline\u0000' }]));
    expect(text.split('\n').filter((line) => line.startsWith('prefix_rule'))).toHaveLength(2);
    expect(text).not.toContain('\u0000');
  });
});

describe('the permission profile', () => {
  it('denies a path rule, and leaves a write-only rule readable', () => {
    expect(profileEntries(policy([vault, dist]))).toEqual([
      ['${project}/dist', 'read'],
      ['${project}/vault', 'none'],
    ]);
  });

  it('the stricter level wins when two rules name one path', () => {
    const both: CompiledRule[] = [dist, { ...dist, id: 'g@1:dist-any', access: 'any' }];
    expect(profileEntries(policy(both))).toEqual([['${project}/dist', 'none']]);
  });

  it('merges every project’s entries into one block, the stricter level winning', () => {
    const lines = profileBlock([
      ['/p1/vault', 'none'],
      ['/p2/vault', 'read'],
      ['/p2/vault', 'none'],
      ['/p1/vault', 'read'],
    ]);
    expect(lines.filter((line) => line.includes('"/p1/vault"'))).toEqual([
      'permissions.ror.filesystem."/p1/vault" = "none"',
    ]);
    expect(lines.filter((line) => line.includes('"/p2/vault"'))).toEqual([
      'permissions.ror.filesystem."/p2/vault" = "none"',
    ]);
    expect(mergeEntries([['/a', 'read']], [['/a', 'none']])).toEqual([['/a', 'none']]);
  });

  it('writes the path quoted and escaped, even a Windows one', () => {
    const lines = profileBlock([['C:\\Users\\me "x"\\vault', 'none']]);
    expect(lines).toContain(
      'permissions.ror.filesystem."C:\\\\Users\\\\me \\"x\\"\\\\vault" = "none"',
    );
  });

  it('knows an interior `**` from a trailing one', () => {
    expect(hasInteriorDoubleStar('vault/**')).toBe(false);
    expect(hasInteriorDoubleStar('**/*.key')).toBe(true);
    expect(hasInteriorDoubleStar('a/**/b')).toBe(true);
  });

  it('the block extends the workspace profile and caps glob expansion', () => {
    const lines = profileBlock([['/home/me/.runonroad', 'none']]);
    expect(lines).toContain('default_permissions = "ror"');
    expect(lines).toContain('permissions.ror.extends = ":workspace"');
    expect(lines).toContain(
      `permissions.ror.filesystem.glob_scan_max_depth = ${String(GLOB_SCAN_MAX_DEPTH)}`,
    );
    expect(lines).toContain('permissions.ror.filesystem."/home/me/.runonroad" = "none"');
  });
});

describe('content rules (ADR-0088)', () => {
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

  it('are not native: no prefix rule, no profile entry', () => {
    expect(rulesFile(policy([content]))).not.toContain('prefix_rule');
    expect(profileEntries(policy([content]))).toEqual([]);
  });
});
