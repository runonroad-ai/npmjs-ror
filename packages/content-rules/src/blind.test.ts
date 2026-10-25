/**
 * An independent set (ADR-0117): 150 adversarial texts written by Codex WITHOUT reading the matcher,
 * against eight rule shapes. It is the check on the author's own corpus, whose labels were written by
 * the same hand as the code. A false block (code says violation, expected something else) is the
 * worst error and must stay at zero; every other mismatch is listed, not hidden.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { check, type ContentRule } from './content.js';

type Expected = 'violation' | 'ambiguous' | 'none';
interface Case {
  readonly rule: string;
  readonly text: string;
  readonly expected: Expected;
  readonly why: string;
}

const base = {
  kind: 'content' as const,
  decision: 'forbid' as const,
  reason: 'x',
  required: true,
  topic: 't',
  text: 't',
  scopes: ['prompt', 'file_write', 'answer'] as const,
  alternatives: [] as string[],
};
const bound = (
  id: string,
  aliases: string[],
  operator: 'lte' | 'gte',
  limit: string,
  unit: 'percent' | 'amount' | 'count',
  currency?: string,
): ContentRule => ({
  ...base,
  id,
  subject_aliases: aliases,
  scopes: [...base.scopes],
  constraint: { kind: 'number_bound', operator, limit, unit, currency, binding_window: 6 },
});
const terms = (id: string, list: string[], exceptions: string[] = []): ContentRule => ({
  ...base,
  id,
  subject_aliases: [],
  scopes: [...base.scopes],
  constraint: { kind: 'forbidden_terms', terms: list, context_exceptions: exceptions },
});

const RULES: Record<string, ContentRule> = {
  R1: bound(
    'R1',
    ['remise', 'rabais', 'discount', 'réduction', 'ristourne'],
    'lte',
    '5',
    'percent',
  ),
  R2: bound('R2', ['marge', 'margin', 'margin rate'], 'gte', '20', 'percent'),
  R3: bound(
    'R3',
    ['note de frais', 'dépense', 'expense', 'expenses'],
    'lte',
    '500',
    'amount',
    'EUR',
  ),
  R4: bound('R4', ['pages', 'page count', 'longueur du document'], 'lte', '20', 'count'),
  R5: bound('R5', ['délai de paiement', 'payment terms', 'payment term'], 'lte', '60', 'count'),
  R6: terms('R6', ['Globex', 'Initech'], ['comparatif interne']),
  R7: terms('R7', ['garanti', 'guaranteed', '100% guaranteed']),
  R8: terms('R8', ['noir', 'black'], ['texte noir sur blanc']),
};

const cases = JSON.parse(
  readFileSync(fileURLToPath(new URL('./testing/blind-set.json', import.meta.url)), 'utf8'),
) as Case[];

const verdict = (rule: ContentRule, text: string): Expected => {
  const findings = check(rule, text);
  if (findings.some((finding) => finding.kind === 'violation')) return 'violation';
  return findings.length > 0 ? 'ambiguous' : 'none';
};

const plain = (text: string): string => text.normalize('NFKC');

/**
 * Where the code and the independent reviewer disagree ON PURPOSE, and why. Each one is asserted as
 * the code's current behaviour so that it cannot drift unnoticed.
 */
const BY_DESIGN: Readonly<Record<string, string>> = {
  'Remise : à partir de 6 %.': 'a floor above the cap: every admissible value breaks it',
  'Page count: min 21.': 'a floor above the cap: every admissible value breaks it',
  'Délai de paiement : à partir de 75 jours.':
    'a floor above the cap: every admissible value breaks it',
  'Délai de paiement : au moins 65 jours.':
    'a floor above the cap: every admissible value breaks it',
  'Expense: EUR 1,000.':
    'an amount or a count with a comma and three digits is thousands; only a percentage keeps both readings',
  'Expense: from EUR 600.': 'a floor above the cap: every admissible value breaks it',
  '{"vendor":"Globex"}':
    'JSON quotes are syntax: writing the name into a file names the competitor',
  '{"color":"black"}': 'JSON quotes are syntax: writing the word into a file uses it',
  'Les résultats sont garantis.':
    'the plural or feminine form of the same word is the same promise',
  'Les panneaux sont noirs.': 'the plural of the same word is the same colour',
};

describe('the independent set written by Codex', () => {
  it('asserts every deliberate disagreement as the code’s behaviour', () => {
    const matched = cases.filter((entry) => BY_DESIGN[plain(entry.text)] !== undefined);
    expect(matched).toHaveLength(Object.keys(BY_DESIGN).length);
    for (const item of matched) {
      expect(verdict(RULES[item.rule] as ContentRule, item.text), item.text).toBe('violation');
    }
  });

  const results = cases.map((item) => ({
    ...item,
    got: verdict(RULES[item.rule] as ContentRule, item.text),
  }));

  it('has no false block: the code never blocks what the reviewer did not call a violation', () => {
    const falseBlocks = results.filter(
      (item) =>
        item.got === 'violation' &&
        item.expected !== 'violation' &&
        BY_DESIGN[plain(item.text)] === undefined,
    );
    expect(
      falseBlocks.map(
        (item) => `${item.rule} | ${item.text} | expected ${item.expected} | ${item.why}`,
      ),
    ).toEqual([]);
  });

  it('reports every other disagreement instead of hiding it', () => {
    const falseAllows = results.filter(
      (item) => item.expected === 'violation' && item.got !== 'violation',
    );
    const demoted = results.filter((item) => item.expected === 'ambiguous' && item.got === 'none');
    // a measured, reviewed list: the day it changes, a human reads why
    console.info(
      `independent set: ${String(results.length)} texts, ${String(falseAllows.length)} expected violations not blocked by code, ${String(demoted.length)} doubtful texts code saw nothing in`,
    );
    for (const item of [...falseAllows, ...demoted]) {
      console.info(`  ${item.rule} expected ${item.expected} got ${item.got}: ${item.text}`);
    }
    expect(results.length).toBe(150);
  });
});
