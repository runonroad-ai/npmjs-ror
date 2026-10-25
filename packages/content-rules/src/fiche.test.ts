/**
 * The deterministic draft of a fiche (ADR-0118), proved GENERIC: for each of the 169 invented rules of
 * 21 departments, the draft built from its typed fields alone must pass its own boundary tests. The
 * expected verdicts are written by hand in fiche.ts from the meaning of the contract, never taken from
 * the matcher, so a failure here is either a wrong generator or a real matcher gap.
 */
import { describe, expect, it } from 'vitest';

import {
  baselineTests,
  draftFiche,
  failedTests,
  MAX_EXAMPLES,
  MAX_TESTS,
  missingBaseline,
  runFicheTests,
  withBaseline,
} from './fiche.js';
import { MATCHER_VERSION } from './version.js';
import { corpus } from './testing/corpus.js';
import type { ContentRule } from './content.js';

const discount: ContentRule = {
  id: 'discount',
  kind: 'content',
  decision: 'forbid',
  reason: 'A tender discount never exceeds 5 %.',
  required: true,
  topic: 'tenders',
  text: 'No discount above 5 % in a tender.',
  subject_aliases: ['remise', 'discount'],
  scopes: ['prompt', 'file_write', 'answer'],
  constraint: {
    kind: 'number_bound',
    operator: 'lte',
    limit: '5',
    unit: 'percent',
    binding_window: 6,
  },
  alternatives: [],
};

describe('draftFiche', () => {
  it('is deterministic and bounded', () => {
    const first = draftFiche(discount);
    expect(draftFiche(discount)).toEqual(first);
    expect(first.matcher_version).toBe(MATCHER_VERSION);
    expect(first.tests.length).toBeGreaterThan(10);
    expect(first.tests.length).toBeLessThanOrEqual(MAX_TESTS);
    for (const list of Object.values(first.examples))
      expect(list.length).toBeLessThanOrEqual(MAX_EXAMPLES);
    expect(first.interpretation.length).toBeLessThanOrEqual(2000);
  });

  it('puts the boundary where the operator puts it, decimal-safe', () => {
    const verdict = (rule: ContentRule, text: string) =>
      draftFiche(rule).tests.find((each) => each.text === text)?.expected;
    expect(verdict(discount, 'Remise de 5 %')).toBe('none');
    expect(verdict(discount, 'Remise de 5.1 %')).toBe('violation');
    expect(verdict(discount, 'Remise de 6 %')).toBe('violation');
    expect(verdict(discount, 'Remise de 4 %')).toBe('none');
    const strict = {
      ...discount,
      constraint: { ...discount.constraint, operator: 'lt' },
    } as ContentRule;
    expect(verdict(strict, 'Remise de 5 %')).toBe('violation');
    const floor = {
      ...discount,
      constraint: { ...discount.constraint, operator: 'gte', limit: '20' },
    } as ContentRule;
    expect(verdict(floor, 'Remise de 19 %')).toBe('violation');
    expect(verdict(floor, 'Remise de 20 %')).toBe('none');
    const fine = {
      ...discount,
      constraint: { ...discount.constraint, limit: '2.5' },
    } as ContentRule;
    expect(verdict(fine, 'Remise de 2.51 %')).toBe('violation');
    expect(verdict(fine, 'Remise de 2.5 %')).toBe('none');
  });

  it('turns every finding into a doubt for a rule that depends on a condition code cannot read', () => {
    const tests = draftFiche({ ...discount, mode: 'review' }).tests;
    expect(tests.some((each) => each.expected === 'violation')).toBe(false);
    expect(tests.find((each) => each.text === 'Remise de 6 %')?.expected).toBe('ambiguous');
  });

  it('writes the labels by hand: an edited matcher expectation is a failure, not a new truth', () => {
    const results = runFicheTests(discount, [{ text: 'Remise de 6 %', expected: 'none' }]);
    expect(failedTests(results)).toHaveLength(1);
    expect(results[0]?.actual).toBe('violation');
  });
});

describe('the draft is generic: every invented rule of every department passes its own tests', () => {
  const cases = corpus();
  it('covers the whole corpus', () => {
    expect(cases.length).toBeGreaterThanOrEqual(160);
  });
  it('passes all of its generated tests, in French and in English', () => {
    const failures: string[] = [];
    let tests = 0;
    for (const entry of cases) {
      const fiche = draftFiche(entry.rule);
      tests += fiche.tests.length;
      for (const bad of failedTests(runFicheTests(entry.rule, fiche.tests))) {
        failures.push(
          `${entry.rule.id} | ${bad.text} | expected ${bad.expected} got ${bad.actual}`,
        );
      }
    }
    expect(tests).toBeGreaterThan(3000);
    expect(failures).toEqual([]);
  });
});

describe('the baseline and the wording of a drafted fiche', () => {
  const discount: ContentRule = {
    id: 'g@1:d',
    kind: 'content',
    decision: 'forbid',
    reason: 'x',
    required: true,
    topic: 't',
    text: 'No discount above 5 %.',
    subject_aliases: ['remise', 'discount'],
    scopes: ['prompt'],
    constraint: {
      kind: 'number_bound',
      operator: 'lte',
      limit: '5',
      unit: 'percent',
      binding_window: 6,
    },
    alternatives: [],
  };

  it('says what is PERMITTED, never the contrary, and stays within its bound for the longest valid rule', () => {
    const text = draftFiche(discount).interpretation;
    expect(text).toContain('Permitted: the value stated for remise / discount is at most 5 %.');
    expect(text).not.toContain('blocks only when');
    const terms: ContentRule = {
      ...discount,
      subject_aliases: [],
      text: 'x'.repeat(2000),
      constraint: {
        kind: 'forbidden_terms',
        terms: Array.from({ length: 32 }, (_, i) => `term-${String(i)}-${'y'.repeat(70)}`),
        context_exceptions: Array.from(
          { length: 32 },
          (_, i) => `exception-${String(i)}-${'z'.repeat(60)}`,
        ),
      },
    };
    expect(draftFiche(terms).interpretation.length).toBeLessThanOrEqual(2000);
    expect(draftFiche(terms).interpretation).toContain('Permitted: none of these words');
    const review = draftFiche({ ...discount, mode: 'review' }).interpretation;
    expect(review).toContain('the code never blocks on it');
  });

  it('knows which baseline tests a fiche lacks, and completes a hollow one', () => {
    expect(missingBaseline(discount, []).length).toBe(baselineTests(discount).length);
    expect(missingBaseline(discount, baselineTests(discount))).toEqual([]);
    const completed = withBaseline(discount, [{ text: 'une remise de 5 %', expected: 'none' }]);
    expect(missingBaseline(discount, completed)).toEqual([]);
    expect(completed.length).toBeLessThanOrEqual(60);
  });
});

describe('review round 35', () => {
  it('drafts a fiche that passes for a rule about productivity gains', () => {
    const rule: ContentRule = {
      id: 'g@1:prod',
      text: 'Productivity gains must be at least 10 %.',
      kind: 'content',
      scopes: ['prompt', 'file_write', 'answer'],
      subject_aliases: ['gains de productivité', 'productivity gains'],
      constraint: {
        kind: 'number_bound',
        operator: 'gte',
        limit: '10',
        unit: 'percent',
        binding_window: 6,
      },
      mode: 'block',
      alternatives: [],
    } as unknown as ContentRule;
    const fiche = draftFiche(rule);
    expect(failedTests(runFicheTests(rule, fiche.tests))).toHaveLength(0);
    expect(missingBaseline(rule, fiche.tests)).toHaveLength(0);
  });
});
