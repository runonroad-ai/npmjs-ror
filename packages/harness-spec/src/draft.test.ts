import { describe, expect, it } from 'vitest';

import { validateDraft } from './draft.js';

/** Credential-shaped values assembled here, so no scanner takes the file for a leak. */
const FAKE_KEYS = {
  'an Anthropic or OpenAI key': 'sk-' + 'ant-api03-' + 'x'.repeat(40),
  'an AWS access key id': 'AKIA' + 'A'.repeat(16),
  'a GitHub token': 'ghp_' + 'a'.repeat(36),
  'a Slack token': 'xoxb-' + '1'.repeat(24),
  'a RunOnRoad token': 'rora_' + 'a'.repeat(32),
  'a private key': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'a key assigned to its name': 'api_key = ' + 'k'.repeat(24),
} as const;

const document = (text: unknown, preamble = 'A short preamble.'): Record<string, unknown> => ({
  rhs: 1,
  governance: { slug: 'hello', name: 'Hello', domain: 'it', category: 'custom' },
  context: {
    preamble,
    allowed: '',
    preferred: '',
    ask_first: '',
    forbidden: text,
  },
});

describe('validateDraft', () => {
  it('accepts a document with no preamble when a block has text (ADR-0082)', () => {
    expect(validateDraft(document('Commit a secret.', '')).ok).toBe(true);
  });

  it('accepts a document that parses and holds no secret', () => {
    const result = validateDraft(document('Commit a secret.'));
    expect(result.ok).toBe(true);
  });

  it('reports the RHS codes of a document that does not parse', () => {
    const result = validateDraft(document('', ''));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.code)).toEqual(['RHS-V11']);
  });

  it('refuses a block written as a list of rules (ADR-0082)', () => {
    const result = validateDraft(document([{ key: 'no-leak', text: 'Commit a secret.' }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatchObject({ pointer: '/context/forbidden' });
  });

  it.each(Object.entries(FAKE_KEYS))('refuses rule text holding %s (RHS-V05)', (_name, key) => {
    const result = validateDraft(document(`Use ${key} to call the service.`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'RHS-V05',
      pointer: '/context/forbidden',
    });
    // The finding names the place, never the value.
    expect(JSON.stringify(result.errors)).not.toContain(key.slice(4));
  });

  it('adds the secret to the other findings, in one answer', () => {
    const both = document(`Use ${FAKE_KEYS['a GitHub token']}.`);
    (both.governance as { unexpected?: string }).unexpected = 'x';
    const result = validateDraft(both);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code).sort()).toEqual(['RHS-SCHEMA', 'RHS-V05']);
    }
  });

  it('refuses a NUL character anywhere in the document, which jsonb cannot store', () => {
    const result = validateDraft(document('Deploy\u0000 now.'));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toEqual([expect.objectContaining({ code: 'RHS-SCHEMA', pointer: '' })]);
  });

  it('accepts the escape sequence written out in prose', () => {
    expect(validateDraft(document('Strip every \\u0000 from the logs.')).ok).toBe(true);
  });

  it('lets prose that names a secret go through', () => {
    const prose = 'Never paste a password, a token or an api key in a prompt.';
    expect(validateDraft(document(prose)).ok).toBe(true);
  });
});
