import { describe, expect, it } from 'vitest';

import { MAX_BLOCK_TEXT } from './schema.js';
import { parse } from './parse.js';

const HEAD = `
rhs: 1
governance:
  slug: hello
  name: Hello governance
  domain: it
  category: conventions
context:
  preamble: A short preamble.
`;

const FORBIDDEN_BLOCK = `  forbidden: |
    - Commit a secret.
`;

const HELLO = HEAD + FORBIDDEN_BLOCK;

function errorsOf(source: string): readonly { code: string; pointer: string }[] {
  const result = parse(source);
  if (result.ok) throw new Error('expected the document to be rejected');
  return result.errors.map(({ code, pointer }) => ({ code, pointer }));
}

describe('parse', () => {
  it('accepts the smallest real governance', () => {
    const result = parse(HELLO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.governance.slug).toBe('hello');
    expect(result.value.context.forbidden).toBe('- Commit a secret.\n');
    // Unlisted blocks default to empty, so a caller never has to guard.
    expect(result.value.context.allowed).toBe('');
  });

  it('reads JSON as well as YAML', () => {
    const asJson = JSON.stringify({
      rhs: 1,
      governance: { slug: 'hello', name: 'H', domain: 'it', category: 'conventions' },
      context: { preamble: 'p', forbidden: 'Commit a secret.' },
    });
    expect(parse(asJson).ok).toBe(true);
  });

  describe('ADR-0082 — a block is one text', () => {
    it('rejects a block written as a list of rules, at the block', () => {
      const source = `${HEAD}  forbidden:\n    - key: no-secrets-in-git\n      text: Commit a secret.\n`;
      expect(errorsOf(source)).toEqual([{ code: 'RHS-SCHEMA', pointer: '/context/forbidden' }]);
    });

    it('rejects a block longer than the cap, and accepts one at the cap', () => {
      const block = (length: number): string =>
        JSON.stringify({
          rhs: 1,
          governance: { slug: 'hello', name: 'H', domain: 'it', category: 'conventions' },
          context: { preamble: 'p', allowed: 'a'.repeat(length) },
        });
      expect(parse(block(MAX_BLOCK_TEXT)).ok).toBe(true);
      expect(errorsOf(block(MAX_BLOCK_TEXT + 1))).toEqual([
        { code: 'RHS-SCHEMA', pointer: '/context/allowed' },
      ]);
    });
  });

  describe('RHS-V11 — a context must say something', () => {
    const bare = `
rhs: 1
governance: { slug: hello, name: H, domain: it, category: conventions }
context:
`;

    it('rejects a context whose five fields are all empty', () => {
      const source = `${bare}  preamble: ''\n`;
      expect(errorsOf(source)).toEqual([{ code: 'RHS-V11', pointer: '/context' }]);
      expect(errorsOf(`${bare}  {}\n`)).toEqual([{ code: 'RHS-V11', pointer: '/context' }]);
    });

    it('rejects fields that hold only spaces and line breaks', () => {
      const source = `${bare}  preamble: "  "\n  allowed: "  \\n "\n  forbidden: "\\n"\n`;
      expect(errorsOf(source)).toEqual([{ code: 'RHS-V11', pointer: '/context' }]);
    });

    it('accepts the preamble alone, and a block alone with no preamble (ADR-0082)', () => {
      expect(parse(`${bare}  preamble: Only context.\n`).ok).toBe(true);
      const withoutPreamble = parse(`${bare}  forbidden: Never.\n`);
      expect(withoutPreamble.ok).toBe(true);
      if (withoutPreamble.ok) expect(withoutPreamble.value.context.preamble).toBe('');
    });
  });

  it('rejects an unknown key instead of dropping it silently', () => {
    // A silently ignored field means the author believes something is
    // enforced that never reaches the tool.
    const source = HELLO.replace('  domain: it', '  domain: it\n  unexpected: value');
    const errors = errorsOf(source);
    expect(errors.map((error) => error.pointer)).toContain('/governance/unexpected');
  });

  it('rejects the old block name recommended (ADR-0055)', () => {
    const source = HELLO.replace('  forbidden:', '  recommended: x\n  forbidden:');
    expect(errorsOf(source).map((error) => error.pointer)).toContain('/context/recommended');
  });

  it('reports a syntax error rather than throwing', () => {
    expect(errorsOf('rhs: [unclosed').map((error) => error.code)).toEqual(['RHS-SYNTAX']);
  });

  it('accepts components but warns that they are not compiled', () => {
    const source = `${HELLO}\ncomponents:\n  - kind: rule\n    key: ts-strict\n`;
    const result = parse(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.pointer).toBe('/components');
  });

  it('sorts errors so the output is stable', () => {
    const source = `
rhs: 1
governance: { slug: hello, name: H, domain: it, category: conventions }
context:
  preamble: p
  allowed: [one]
  preferred: [two]
  forbidden: [three]
`;
    const first = errorsOf(source);
    expect(first).toEqual(errorsOf(source));
    expect(first.map((error) => error.pointer)).toEqual([
      '/context/allowed',
      '/context/forbidden',
      '/context/preferred',
    ]);
  });
});

describe('enforceable rules (ADR-0114)', () => {
  const RULES = `${HELLO}rules:
  - id: no-force-push
    kind: command
    decision: forbid
    reason: A force-push rewrites shared history.
    executable: git
    argv_prefix: [push]
    flags_any: [--force, -f]
    required: false
  - id: no-secrets-dir
    kind: path
    decision: forbid
    reason: Secrets stay in the vault.
    access: any
    glob: secrets/**
`;

  it('accepts typed path and command rules, and defaults required to true', () => {
    const result = parse(RULES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [command, path] = result.value.rules ?? [];
    expect(command).toMatchObject({ kind: 'command', executable: 'git', required: false });
    expect(path).toMatchObject({ kind: 'path', access: 'any', required: true });
  });

  it('keeps a document without rules valid, and its rules undefined', () => {
    const result = parse(HELLO);
    expect(result.ok && result.value.rules).toBeUndefined();
  });

  it('refuses a selector it does not know, such as a regular expression', () => {
    const regex = RULES.replace('kind: command', 'kind: regex');
    expect(parse(regex).ok).toBe(false);
    const unknownKey = RULES.replace('executable: git', 'executable: git\n    pattern: "git .*"');
    expect(errorsOf(unknownKey).some((error) => error.pointer.endsWith('/pattern'))).toBe(true);
  });

  it('refuses two rules with the same id, naming the second', () => {
    const twice = `${RULES}  - id: no-force-push
    kind: path
    decision: forbid
    reason: Again.
    access: read
    glob: x
`;
    expect(errorsOf(twice)).toContainEqual({ code: 'RHS-V20', pointer: '/rules/2/id' });
  });

  it('refuses a flag that is not a flag and an id that is not a slug', () => {
    expect(parse(RULES.replace('[--force, -f]', '[force]')).ok).toBe(false);
    expect(parse(RULES.replace('id: no-secrets-dir', 'id: No Secrets')).ok).toBe(false);
  });
});

describe('the glob contract of a path rule (ADR-0114)', () => {
  const withGlob = (glob: string): string => `${HELLO}rules:
  - id: gl
    kind: path
    decision: forbid
    reason: No.
    access: any
    glob: ${JSON.stringify(glob)}
`;
  it.each([
    'vault/**',
    '**/id_rsa',
    'a/**/b',
    '~/.ssh/**',
    '/etc/shadow',
    'config/*.pem',
    'v?ult',
    './x',
  ])('accepts %s', (glob) => {
    expect(parse(withGlob(glob)).ok).toBe(true);
  });
  it.each([
    'vault/[ab]',
    'vault/{a,b}',
    'vault/\\x',
    '../outside',
    'a/../b',
    'a/**b',
    'a/b**',
    '!vault',
    '#x',
    'a b',
  ])('refuses %s: the three barriers would not read it the same way', (glob) => {
    expect(parse(withGlob(glob)).ok).toBe(false);
  });
});

describe('content rules (ADR-0117)', () => {
  const rule = (constraint: string, extra = ''): string => `${HELLO}rules:
  - id: max-discount
    kind: content
    decision: forbid
    reason: A tender discount stays at 5 % or less.
    topic: discount
    text: No discount above 5 %.
    subject_aliases: [remise, discount]
    scopes: [prompt, file_write]
${extra}    constraint:
${constraint}
`;
  const bound = `      kind: number_bound
      operator: lte
      limit: "5"
      unit: percent`;

  it('accepts a number bound and defaults window, required and alternatives', () => {
    const result = parse(rule(bound));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rules?.[0]).toMatchObject({
      kind: 'content',
      required: true,
      alternatives: [],
      constraint: { kind: 'number_bound', limit: '5', binding_window: 6 },
    });
  });

  it('accepts forbidden terms with exceptions and authored alternatives', () => {
    const terms = `      kind: forbidden_terms
      terms: [noir, black]
      context_exceptions: [black friday]`;
    expect(parse(rule(terms, '    alternatives: [Use the brand navy.]\n')).ok).toBe(true);
  });

  it('wants a decimal string, never a float, and a currency only for an amount', () => {
    expect(parse(rule(bound.replace('"5"', '5'))).ok).toBe(false);
    expect(parse(rule(bound.replace('"5"', '"5,5"'))).ok).toBe(false);
    expect(parse(rule(`${bound}\n      currency: EUR`)).ok).toBe(false);
    const amount = bound.replace('percent', 'amount');
    expect(parse(rule(amount)).ok).toBe(false);
    expect(parse(rule(`${amount}\n      currency: EUR`)).ok).toBe(true);
    expect(parse(rule(`${amount}\n      currency: eur`)).ok).toBe(false);
  });

  it('bounds the window, the lists and the unknown fields', () => {
    expect(parse(rule(`${bound}\n      binding_window: 13`)).ok).toBe(false);
    expect(parse(rule(`${bound}\n      binding_window: 0`)).ok).toBe(false);
    expect(parse(rule(`${bound}\n      regex: ".*"`)).ok).toBe(false);
    expect(parse(rule(bound).replace('[remise, discount]', '[]')).ok).toBe(false);
    expect(parse(rule(bound).replace('[prompt, file_write]', '[chat]')).ok).toBe(false);
    expect(parse(rule(bound, `    alternatives: [${'x'.repeat(301)}]\n`)).ok).toBe(false);
  });

  it('refuses a phrase listed twice after NFKC and case folding, naming the second', () => {
    const twice = rule(bound).replace('[remise, discount]', '[remise, "Ｒemise"]');
    expect(errorsOf(twice)).toContainEqual({
      code: 'RHS-V21',
      pointer: '/rules/0/subject_aliases/1',
    });
    const scopes = rule(bound).replace('[prompt, file_write]', '[prompt, prompt]');
    expect(errorsOf(scopes)).toContainEqual({ code: 'RHS-V21', pointer: '/rules/0/scopes/1' });
  });

  describe('the fiche (ADR-0118)', () => {
    const fiche = {
      schema_version: 1,
      matcher_version: 'content-matcher/1',
      interpretation: 'At most 5 % discount in a tender.',
      examples: {
        violation: ['Remise de 10 %'],
        compliant: ['Remise de 4 %'],
        other_subject: ['Gains de productivité de 10 %'],
        ambiguous: [],
      },
      tests: [{ text: 'Remise de 10 %', expected: 'violation' }],
      origin: 'form',
    };
    const document = (extra: Record<string, unknown>): string => {
      const base = parse(rule(bound));
      if (!base.ok) throw new Error('a valid rule');
      const rules = (base.value.rules ?? []).map((each) => ({ ...each, ...extra }));
      return JSON.stringify({ ...base.value, rules });
    };

    it('is optional: a rule without one stays valid', () => {
      expect(parse(rule(bound)).ok).toBe(true);
    });

    it('accepts a complete fiche, with or without the server’s approval', () => {
      expect(parse(document({ fiche })).ok).toBe(true);
      const approval = {
        by: 'mbr_x',
        at: '2026-10-19T10:00:00.000Z',
        digest: `sha256:${'a'.repeat(64)}`,
      };
      expect(parse(document({ fiche: { ...fiche, approval } })).ok).toBe(true);
    });

    it('bounds the lists, the texts, the verdicts and the fields', () => {
      const tests = Array.from({ length: 61 }, () => ({ text: 'x', expected: 'none' }));
      expect(parse(document({ fiche: { ...fiche, tests } })).ok).toBe(false);
      expect(
        parse(document({ fiche: { ...fiche, tests: [{ text: 'x', expected: 'maybe' }] } })).ok,
      ).toBe(false);
      const examples = { ...fiche.examples, violation: Array.from({ length: 13 }, () => 'x') };
      expect(parse(document({ fiche: { ...fiche, examples } })).ok).toBe(false);
      expect(parse(document({ fiche: { ...fiche, interpretation: '' } })).ok).toBe(false);
      expect(parse(document({ fiche: { ...fiche, extra: 1 } })).ok).toBe(false);
      expect(
        parse(document({ fiche: { ...fiche, approval: { by: 'x', at: 'soon', digest: 'x' } } })).ok,
      ).toBe(false);
    });
  });

  it('shares the 200-rule cap with path and command rules', () => {
    const many = Array.from(
      { length: 201 },
      (_, index) =>
        `  - id: r-${String(index)}\n    kind: path\n    decision: forbid\n    reason: x\n    access: any\n    glob: a${String(index)}`,
    ).join('\n');
    expect(parse(`${HELLO}rules:\n${many}\n`).ok).toBe(false);
  });
});
