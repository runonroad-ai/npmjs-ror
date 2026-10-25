/**
 * The deterministic draft of a rule's fiche (ADR-0118): from the rule's typed fields alone, an
 * interpretation, categorised examples and boundary tests, with the verdict each test MUST get.
 *
 * The expected verdicts come from the MEANING the matcher's contract gives (an explicit value that
 * breaks the bound is a violation; a hypothesis, a negation, a quotation, a ceiling, another unit or a
 * spelled-out number goes to the conversation's AI, which the matcher reports as ambiguous; another
 * subject is nothing) and are written here by hand. They are NEVER obtained by running the matcher:
 * that would only prove the matcher agrees with itself. `runFicheTests` is what compares them.
 */
import { check, type ContentRule, type Finding } from './content.js';
import { MATCHER_VERSION } from './version.js';

export type Verdict = 'violation' | 'ambiguous' | 'none';

export interface FicheTest {
  readonly text: string;
  readonly expected: Verdict;
}

export interface Fiche {
  readonly schema_version: 1;
  readonly matcher_version: string;
  readonly interpretation: string;
  readonly examples: {
    readonly violation: string[];
    readonly compliant: string[];
    readonly other_subject: string[];
    readonly ambiguous: string[];
  };
  readonly tests: FicheTest[];
  readonly origin: 'form' | 'assisted';
}

export interface TestResult {
  readonly text: string;
  readonly expected: Verdict;
  readonly actual: Verdict;
  readonly findings: { readonly kind: 'violation' | 'ambiguous'; readonly seen: string }[];
}

export const MAX_TESTS = 60;
export const MAX_EXAMPLES = 12;

// ------------------------------------------------------------- decimal maths

/** A decimal as an integer over a power of ten: no floating point near a boundary. */
interface Decimal {
  readonly int: bigint;
  readonly scale: number;
}

function parseDecimal(text: string): Decimal {
  const [whole = '0', fraction = ''] = text.split('.');
  return { int: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function at(value: Decimal, scale: number): bigint {
  return value.int * 10n ** BigInt(scale - value.scale);
}

function plus(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { int: at(a, scale) + at(b, scale), scale };
}

function compare(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = at(a, scale);
  const right = at(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

function show(value: Decimal): string {
  const digits = value.int.toString().padStart(value.scale + 1, '0');
  return value.scale === 0
    ? digits
    : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
}

const permits = (operator: string, value: Decimal, limit: Decimal): boolean => {
  const order = compare(value, limit);
  return operator === 'lt'
    ? order < 0
    : operator === 'lte'
      ? order <= 0
      : operator === 'gt'
        ? order > 0
        : order >= 0;
};

// ------------------------------------------------------------------- numbers

function numberTests(rule: ContentRule): { tests: FicheTest[]; other: string[] } {
  const bound = rule.constraint;
  if (bound.kind !== 'number_bound') return { tests: [], other: [] };
  const limit = parseDecimal(bound.limit);
  const one: Decimal = { int: 1n, scale: 0 };
  const fine: Decimal = { int: 1n, scale: limit.scale + 1 };
  const alias = rule.subject_aliases[0] ?? 'subject';
  const second = rule.subject_aliases[1] ?? alias;
  const capital = `${alias.charAt(0).toUpperCase()}${alias.slice(1)}`;
  const review = rule.mode === 'review';
  const verdictFor = (value: Decimal): Verdict =>
    permits(bound.operator, value, limit) ? 'none' : review ? 'ambiguous' : 'violation';

  const unit = (text: string, comma = false): string => {
    const shown = comma ? text.replace('.', ',') : text;
    return bound.unit === 'percent'
      ? `${shown} %`
      : bound.unit === 'amount'
        ? `${shown} ${bound.currency ?? 'EUR'}`
        : shown;
  };
  const values: { value: Decimal; label: string }[] = [];
  const minusOne = plus(limit, { int: -1n, scale: 0 });
  if (minusOne.int >= 0n) values.push({ value: minusOne, label: 'below' });
  values.push({ value: limit, label: 'at' });
  values.push({ value: plus(limit, fine), label: 'just above' });
  values.push({ value: plus(limit, one), label: 'above' });
  const finePlus = plus(limit, { int: -1n, scale: limit.scale + 1 });
  if (finePlus.int >= 0n) values.push({ value: finePlus, label: 'just below' });

  const tests: FicheTest[] = [];
  const push = (text: string, expected: Verdict): void => {
    if (!tests.some((each) => each.text === text)) tests.push({ text, expected });
  };
  for (const { value, label } of values) {
    const shown = show(value);
    const expected = verdictFor(value);
    push(`${capital} de ${unit(shown)}`, expected);
    push(`${capital}: ${unit(shown)}`, expected);
    push(`{"${alias}": "${unit(shown)}"}`, expected);
    if (label === 'above' || label === 'just above' || label === 'at') {
      push(`The ${second} is ${unit(shown)}`, expected);
    }
    if (bound.unit !== 'count' && (label === 'above' || label === 'at')) {
      push(`${unit(shown)} de ${alias}`, expected);
    }
    if (bound.unit === 'percent' && shown.includes('.') && label === 'just above') {
      push(`${capital} de ${unit(shown, true)}`, expected);
    }
  }
  const violating =
    bound.operator === 'lte' || bound.operator === 'lt' ? plus(limit, one) : minusOne;
  const other: string[] = [];
  if (violating.int >= 0n) {
    const v = unit(show(violating));
    const doubtful: Verdict = permits(bound.operator, violating, limit) ? 'none' : 'ambiguous';
    push(`Si on avait ${alias} de ${v}, signeriez-vous ?`, doubtful);
    push(`If the ${alias} were ${v}, would you sign?`, doubtful);
    push(`Pas de ${alias} de ${v}, c'est interdit`, doubtful);
    push(`We cannot offer a ${alias} of ${v}`, doubtful);
    push(`Le client a écrit « ${alias} : ${v} » dans son message`, doubtful);
    push(`${capital} jusqu'à ${v}`, doubtful);
    push(`${capital}: up to ${v}`, doubtful);
    const noise = `Nous visons ${v} de croissance et ${v} de gains de productivité`;
    // an unrelated sentence only proves something if the rule really finds it unrelated:
    // a rule about productivity gains must not be handed a "productivity gains" noise sentence
    const meeting = `The meeting takes ${v} minutes`;
    for (const unrelated of [noise, meeting]) {
      if (check(rule, unrelated).length > 0) continue;
      push(unrelated, 'none');
      other.push(unrelated);
    }
  }
  if (bound.unit === 'percent') {
    push(`${capital} de dix pour cent`, 'ambiguous');
    push(`${capital} de ${show(plus(limit, one))} €`, 'ambiguous');
  }
  if (bound.unit === 'amount') {
    const other$ = (bound.currency ?? 'EUR') === 'USD' ? 'EUR' : 'USD';
    push(`${capital} de ${show(plus(limit, one))} ${other$}`, 'ambiguous');
  }
  if (bound.unit === 'count') push(`${capital} de ${show(plus(limit, one))} %`, 'ambiguous');
  push(`${capital} à discuter avec le client`, 'none');
  return { tests, other };
}

// --------------------------------------------------------------------- terms

function termTests(rule: ContentRule): { tests: FicheTest[]; other: string[] } {
  const constraint = rule.constraint;
  if (constraint.kind !== 'forbidden_terms') return { tests: [], other: [] };
  const review = rule.mode === 'review';
  const used: Verdict = review ? 'ambiguous' : 'violation';
  const tests: FicheTest[] = [];
  const push = (text: string, expected: Verdict): void => {
    if (!tests.some((each) => each.text === text)) tests.push({ text, expected });
  };
  for (const term of constraint.terms.slice(0, 3)) {
    push(`Rédige un communiqué qui parle de ${term}`, used);
    push(`Write a note about ${term} for the team`, used);
    push(`Write about ${term.toUpperCase()} today`, used);
    push(`{"name": "${term}"}`, used);
    push(`Plusieurs ${term}s sont concernés`, used);
    push(`abc${term}def`, 'none');
    push(`Ne mentionne pas ${term}`, 'ambiguous');
    push(`Si ${term} était concerné, que ferions-nous ?`, 'ambiguous');
    push(`Il a écrit « ${term} » dans son message`, 'ambiguous');
  }
  for (const exception of constraint.context_exceptions.slice(0, 2)) {
    const term = constraint.terms[0] ?? '';
    push(`${exception} : ${term}`, 'ambiguous');
  }
  const other = ['Un simple compte rendu de la réunion de lundi', 'The weekly report is ready'];
  for (const text of other) push(text, 'none');
  return { tests, other };
}

// ---------------------------------------------------------------------- draft

const clip = (text: string, size: number): string =>
  text.length <= size ? text : `${text.slice(0, size - 1)}…`;

/** What is PERMITTED, in words; the code blocks its contrary (and only when that is stated plainly). */
function plainConstraint(rule: ContentRule): string {
  const c = rule.constraint;
  if (c.kind === 'forbidden_terms') {
    const unless =
      c.context_exceptions.length > 0
        ? ` (the text may use them if it also says: ${clip(c.context_exceptions.join(', '), 160)})`
        : '';
    return `Permitted: none of these words or phrases is used: ${clip(c.terms.join(', '), 360)}${unless}.`;
  }
  const word = { lt: 'below', lte: 'at most', gt: 'above', gte: 'at least' }[c.operator];
  const unit =
    c.unit === 'percent' ? ' %' : c.unit === 'amount' ? ` ${c.currency ?? ''}`.trimEnd() : '';
  return `Permitted: the value stated for ${clip(rule.subject_aliases.join(' / '), 360)} is ${word} ${c.limit}${unit}.`;
}

/** The machine-made tests every approved fiche must contain, whatever the author or an AI added. */
export function baselineTests(rule: ContentRule): FicheTest[] {
  return (
    rule.constraint.kind === 'number_bound' ? numberTests(rule) : termTests(rule)
  ).tests.slice(0, MAX_TESTS);
}

/** Baseline tests a fiche lacks: an empty or hollow suite proves nothing and is never approved. */
export function missingBaseline(rule: ContentRule, tests: readonly FicheTest[]): FicheTest[] {
  const have = new Set(tests.map((each) => `${each.expected}\u0000${each.text}`));
  return baselineTests(rule).filter((each) => !have.has(`${each.expected}\u0000${each.text}`));
}

/** An author's or an AI's tests, completed with the baseline up to the bound. */
export function withBaseline(rule: ContentRule, tests: readonly FicheTest[]): FicheTest[] {
  return [...tests, ...missingBaseline(rule, tests)].slice(0, MAX_TESTS);
}

/** The deterministic draft: read it, change it, approve it. */
export function draftFiche(rule: ContentRule): Fiche {
  const { tests, other } =
    rule.constraint.kind === 'number_bound' ? numberTests(rule) : termTests(rule);
  const kept = tests.slice(0, MAX_TESTS);
  const pick = (verdict: Verdict, exclude: readonly string[] = []): string[] =>
    kept
      .filter((each) => each.expected === verdict && !exclude.includes(each.text))
      .map((each) => each.text.slice(0, 300))
      .slice(0, MAX_EXAMPLES);
  return {
    schema_version: 1,
    matcher_version: MATCHER_VERSION,
    interpretation: [
      clip(rule.text.trim(), 900),
      plainConstraint(rule),
      rule.mode === 'review'
        ? 'This rule depends on a condition the code cannot read: the code never blocks on it; every finding is handed to the conversation’s AI to decide.'
        : 'The code blocks a plainly stated violation of this; anything doubtful (a hypothesis, a negation, a quotation, a ceiling, another unit, a spelled-out number) goes to the conversation’s AI.',
    ].join(' '),
    examples: {
      violation: pick('violation'),
      compliant: pick('none', other),
      other_subject: other.slice(0, MAX_EXAMPLES).map((text) => text.slice(0, 300)),
      ambiguous: pick('ambiguous'),
    },
    tests: kept,
    origin: 'form',
  };
}

// ---------------------------------------------------------------------- run

const verdictOf = (findings: readonly Finding[]): Verdict =>
  findings.some((finding) => finding.kind === 'violation')
    ? 'violation'
    : findings.length > 0
      ? 'ambiguous'
      : 'none';

/** Runs every test of a fiche through the matcher and says what it got. */
export function runFicheTests(rule: ContentRule, tests: readonly FicheTest[]): TestResult[] {
  return tests.map((each) => {
    const findings = check(rule, each.text);
    return {
      text: each.text,
      expected: each.expected,
      actual: verdictOf(findings),
      findings: findings.map((finding) => ({ kind: finding.kind, seen: finding.seen })),
    };
  });
}

export const failedTests = (results: readonly TestResult[]): TestResult[] =>
  results.filter((each) => each.expected !== each.actual);
