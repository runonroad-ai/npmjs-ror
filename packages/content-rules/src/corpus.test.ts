/**
 * The broad corpus (ADR-0117): ~165 invented rules from 20 departments, in French and English,
 * each with labelled texts. Every rule goes through the real RHS parser first, then every text
 * through the matcher. The summary at the end is the measured false-block and false-allow rate;
 * `DECLARED_GAPS` lists what the matcher is known not to do, asserted as its CURRENT behaviour so
 * that a fix shows up as a failing test to move out of the list.
 */
import { parse } from '@runonroad/harness-spec';
import { describe, expect, it } from 'vitest';

import { check } from './content.js';
import { corpus, REALISTIC, type Expect, type Sample, type Verdict } from './testing/corpus.js';

const cases = corpus();
// the hand-written texts ride on the rule they name
for (const [id, text, expect, note] of REALISTIC) {
  const entry = cases.find((candidate) => candidate.rule.id === id);
  if (entry === undefined) throw new Error(`the realistic text names an unknown rule: ${id}`);
  (entry.samples as Sample[]).push({ text, expect, category: 'edge', note: `realistic: ${note}` });
}

const verdictOf = (text: string, rule: (typeof cases)[number]['rule']): Verdict => {
  const findings = check(rule, text);
  if (findings.some((finding) => finding.kind === 'violation')) return 'violation';
  return findings.length > 0 ? 'ambiguous' : 'none';
};
const accepted = (expect: Expect): readonly Verdict[] =>
  typeof expect === 'string' ? [expect] : expect;

/** Texts the matcher does not get right today, with the verdict it gives (rule id, text, actual). */
const DECLARED_GAPS: readonly (readonly [string, string, Verdict])[] = [
  // cumulated discounts are never summed by code (ADR-0117): the AI is handed the rule and decides
  ['sales-discount-cap', 'Remise 5 % + 3 % de remise volume, soit 8 % cumulés.', 'none'],
  // the author must list the words that name the subject: "N % off" names no alias, the AI still sees the rule
  ['sales-discount-cap-en', 'Customer asked for a 20% off coupon.', 'none'],
  ['sales-discount-cap-en', 'We give them 10 percent off the list price.', 'none'],
  ['mkt-promo-cap', 'Jusqu’à -40 % sur toute la collection !', 'none'],
  // irregular plurals are not guessed (only a trailing "s" is)
  ['term-gender', 'Salesmen wanted', 'none'],
];

describe('the rules are valid RHS', () => {
  it('parses every rule through the real schema, in documents of at most 200 rules', () => {
    for (let from = 0; from < cases.length; from += 150) {
      const rules = cases.slice(from, from + 150).map((entry) => entry.rule);
      const result = parse(
        JSON.stringify({
          rhs: 1,
          governance: { slug: 'corpus', name: 'Corpus', domain: 'it', category: 'conventions' },
          context: { preamble: 'A corpus.' },
          rules,
        }),
      );
      expect(result.ok ? [] : result.errors.map((e) => `${e.pointer}: ${e.message}`)).toEqual([]);
    }
  });
});

describe('the matcher on the corpus', () => {
  const rows = cases.flatMap((entry) =>
    entry.samples.map((sample): [typeof entry, Sample, Verdict] => [
      entry,
      sample,
      verdictOf(sample.text, entry.rule),
    ]),
  );
  const gap = (id: string, text: string): Verdict | undefined =>
    DECLARED_GAPS.find(([ruleId, gapText]) => ruleId === id && gapText === text)?.[2];
  const mismatches = rows.filter(([entry, sample, actual]) => {
    const known = gap(entry.rule.id, sample.text);
    return known === undefined ? !accepted(sample.expect).includes(actual) : known !== actual;
  });

  it('measures and prints the rates', () => {
    const count = (predicate: (r: (typeof rows)[number]) => boolean): number =>
      rows.filter(predicate).length;
    const falseBlock = (r: (typeof rows)[number]): boolean =>
      r[2] === 'violation' && !accepted(r[1].expect).includes('violation');
    const falseAllow = (r: (typeof rows)[number]): boolean =>
      r[2] !== 'violation' && accepted(r[1].expect).length === 1 && r[1].expect === 'violation';
    const summary = {
      rules: cases.length,
      departments: new Set(cases.map((entry) => entry.dept)).size,
      texts: rows.length,
      falseBlocks: count(falseBlock),
      falseAllows: count(falseAllow),
      ambiguousMismatches: count(
        (r) => !falseBlock(r) && !falseAllow(r) && !accepted(r[1].expect).includes(r[2]),
      ),
      declaredGaps: DECLARED_GAPS.length,
    };
    console.log(`corpus summary ${JSON.stringify(summary)}`);
    for (const [entry, sample, actual] of mismatches) {
      console.log(
        `MISMATCH ${entry.rule.id} [${sample.category}/${sample.note}] expected ${JSON.stringify(sample.expect)} got ${actual}: ${sample.text}`,
      );
    }
    expect(summary.rules).toBeGreaterThanOrEqual(150);
    expect(summary.departments).toBeGreaterThanOrEqual(18);
    // the founder's requirement: no number is ever blocked for being the wrong subject
    expect(summary.falseBlocks).toBe(0);
    // what is left to find is exactly the declared gaps
    expect(summary.falseAllows + summary.ambiguousMismatches).toBe(DECLARED_GAPS.length);
  });

  it('has no unexplained mismatch', () => {
    expect(
      mismatches.map(
        ([entry, sample, actual]) => `${entry.rule.id} ${sample.note}: ${sample.text} → ${actual}`,
      ),
    ).toEqual([]);
  });
});
