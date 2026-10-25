import type { RhsDocument, Rule } from '@runonroad/harness-spec';
import { describe, expect, it } from 'vitest';

import { compilePolicy, enforcedRules, rootedGlob, settingsOperations } from './policy.js';
import type { Contribution } from './render.js';

const pathRule = (overrides: Partial<Extract<Rule, { kind: 'path' }>> = {}): Rule => ({
  id: 'no-secrets',
  kind: 'path',
  decision: 'forbid',
  reason: 'Secrets stay in the vault.',
  required: true,
  access: 'any',
  glob: 'secrets/**',
  ...overrides,
});

const commandRule: Rule = {
  id: 'no-force-push',
  kind: 'command',
  decision: 'forbid',
  reason: 'A force-push rewrites shared history.',
  required: false,
  executable: 'git',
  argv_prefix: ['push'],
  flags_any: ['--force', '-f'],
};

function contribution(slug: string, rules: Rule[], version = '1.0.0'): Contribution {
  const document: RhsDocument = {
    rhs: 1,
    governance: { slug, name: slug, domain: 'it', category: 'c' },
    context: { preamble: '', allowed: '', preferred: '', ask_first: '', forbidden: 'x' },
    rules,
  };
  return { document, version, assignments: [{ id: `asg_${slug}`, layer: 'org' }], winner: true };
}

describe('compilePolicy', () => {
  it('is absent when no governance carries a rule', () => {
    expect(compilePolicy([contribution('a', [])], 'mem_1')).toBeUndefined();
  });

  it('namespaces ids by governance and version, and orders them', () => {
    const policy = compilePolicy(
      [contribution('zeta', [commandRule]), contribution('alpha', [pathRule()], '2.0.0')],
      'mem_1',
    );
    expect(policy?.rules.map((rule) => rule.id)).toEqual([
      'alpha@2.0.0:no-secrets',
      'zeta@1.0.0:no-force-push',
    ]);
    expect(policy?.principal).toBe('mem_1');
  });

  it('keeps the rules of every contributing version, not only the winner', () => {
    const loser = { ...contribution('a', [pathRule()], '1.0.0'), winner: false };
    const winner = contribution('a', [commandRule], '2.0.0');
    expect(compilePolicy([loser, winner], null)?.rules).toHaveLength(2);
  });

  it('is the same policy whatever order the contributions arrive in', () => {
    const one = contribution('a', [pathRule()]);
    const two = contribution('b', [commandRule]);
    expect(JSON.stringify(compilePolicy([one, two], 'm'))).toBe(
      JSON.stringify(compilePolicy([two, one], 'm')),
    );
  });
});

describe('settingsOperations', () => {
  const values = (rules: Rule[]): Record<string, unknown> => {
    const policy = compilePolicy([contribution('a', rules)], 'm');
    if (policy === undefined) throw new Error('no policy');
    return Object.fromEntries(
      settingsOperations(policy).map((operation) => [operation.pointer, operation.value]),
    );
  };

  it('turns a path rule into Read/Edit denies and sandbox filesystem denies', () => {
    const settings = values([pathRule()]);
    expect(settings['/permissions/deny']).toEqual([
      'Edit(/${project}/secrets/**)',
      'Read(/${project}/secrets/**)',
    ]);
    expect(settings['/sandbox/filesystem/denyRead']).toEqual(['${project}/secrets/**']);
    expect(settings['/sandbox/filesystem/denyWrite']).toEqual(['${project}/secrets/**']);
  });

  it('maps access to the tools it covers', () => {
    expect(values([pathRule({ access: 'read' })])['/permissions/deny']).toEqual([
      'Read(/${project}/secrets/**)',
    ]);
    expect(values([pathRule({ access: 'write' })])['/permissions/deny']).toEqual([
      'Edit(/${project}/secrets/**)',
    ]);
  });

  it('switches the sandbox on, closes its escape hatch and refuses bypass mode', () => {
    const settings = values([pathRule()]);
    expect(settings['/sandbox/enabled']).toBe(true);
    expect(settings['/sandbox/allowUnsandboxedCommands']).toBe(false);
    expect(settings['/sandbox/failIfUnavailable']).toBe(true);
    expect(settings['/permissions/disableBypassPermissionsMode']).toBe('disable');
  });

  it('does not insist on the sandbox for a policy of optional rules only', () => {
    const settings = values([commandRule]);
    expect(settings['/sandbox/failIfUnavailable']).toBeUndefined();
    expect(settings['/permissions/deny']).toBeUndefined();
  });

  it('treats an Ask-first path rule as a deny: it needs a derogation', () => {
    expect(values([pathRule({ decision: 'ask' })])['/permissions/deny']).toBeDefined();
  });

  it('roots globs under the project, the home or the filesystem', () => {
    expect(rootedGlob('a/**')).toBe('${project}/a/**');
    expect(rootedGlob('./a')).toBe('${project}/a');
    expect(rootedGlob('~/.ssh/**')).toBe('${home}/.ssh/**');
    expect(rootedGlob('/etc/x')).toBe('/etc/x');
  });
});

describe('enforcedRules (ADR-0087)', () => {
  const ask = pathRule({ id: 'prod', decision: 'ask', glob: 'prod/**' });
  const policy = compilePolicy([contribution('g', [ask, pathRule()])], 'mbr_1');

  it('drops from the native settings an Ask-first rule a derogation lifts, and nothing else', () => {
    if (policy === undefined) throw new Error('no policy');
    const lifted = {
      ...policy,
      derogations: [{ rule_id: 'g@1.0.0:prod', expires_at: '2026-10-18T12:00:00.000Z' }],
    };
    expect(enforcedRules(lifted).map((rule) => rule.id)).toEqual(['g@1.0.0:no-secrets']);
    const deny = (p: typeof policy) =>
      settingsOperations(p).find((o) => o.pointer === '/permissions/deny')?.value;
    expect(JSON.stringify(deny(policy))).toContain('prod');
    expect(JSON.stringify(deny(lifted))).not.toContain('prod');
    expect(JSON.stringify(deny(lifted))).toContain('secrets');
  });

  it('never lifts a Forbidden rule, whatever the derogation names', () => {
    if (policy === undefined) throw new Error('no policy');
    const forged = {
      ...policy,
      derogations: [{ rule_id: 'g@1.0.0:no-secrets', expires_at: '2026-10-18T12:00:00.000Z' }],
    };
    expect(enforcedRules(forged)).toHaveLength(2);
  });
});

describe('content rules (ADR-0088)', () => {
  const content: Rule = {
    id: 'max-discount',
    kind: 'content',
    decision: 'ask',
    reason: 'A tender discount stays at 5 % or less.',
    required: true,
    topic: 'discount',
    text: 'No discount above 5 %.',
    subject_aliases: ['remise', 'discount'],
    scopes: ['prompt', 'file_write'],
    mode: 'block',
    constraint: {
      kind: 'number_bound',
      operator: 'lte',
      limit: '5',
      unit: 'percent',
      binding_window: 6,
    },
    alternatives: ['Offer a longer warranty instead.'],
  };

  it('travels in the policy under its namespaced id, untouched', () => {
    const policy = compilePolicy([contribution('g', [content, pathRule()])], 'm');
    expect(policy?.rules.map((rule) => rule.id)).toEqual([
      'g@1.0.0:max-discount',
      'g@1.0.0:no-secrets',
    ]);
    expect(policy?.rules[0]).toMatchObject({
      kind: 'content',
      alternatives: ['Offer a longer warranty instead.'],
    });
  });

  it('produces no native setting: only a path rule does', () => {
    const only = compilePolicy([contribution('g', [content])], 'm');
    if (only === undefined) throw new Error('no policy');
    expect(settingsOperations(only).find((o) => o.pointer === '/permissions/deny')).toBeUndefined();
    const both = compilePolicy([contribution('g', [content, pathRule()])], 'm');
    if (both === undefined) throw new Error('no policy');
    expect(JSON.stringify(settingsOperations(both))).not.toContain('discount');
  });

  it('is lifted by a lease when it is Ask-first, never when it is a forbid', () => {
    const forbid: Rule = { ...content, id: 'no-black', decision: 'forbid' };
    const policy = compilePolicy([contribution('g', [content, forbid])], 'm');
    if (policy === undefined) throw new Error('no policy');
    const leases = policy.rules.map((rule) => ({
      rule_id: rule.id,
      expires_at: '2030-01-01T00:00:00.000Z',
    }));
    expect(enforcedRules({ ...policy, derogations: leases }).map((rule) => rule.id)).toEqual([
      'g@1.0.0:no-black',
    ]);
  });
});
