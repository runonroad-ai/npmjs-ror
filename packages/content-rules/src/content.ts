/**
 * Content rules on the device (ADR-0117): is a value or a term in a piece of text a
 * violation of a governance rule? Deterministic and conservative.
 *
 * The line it draws, because a number is not a violation until it is the rule's number:
 *  - VIOLATION: the text states a value for the rule's subject through an explicit local
 *    relation ("remise de 10 %", "discount: 10%", "10 % de remise") and the value breaks
 *    the bound. Code may block on this alone.
 *  - AMBIGUOUS: something looks related but the relation is not explicit (a word between
 *    the subject and the number, a negation, a quotation, a spelled-out number...). Code
 *    never blocks on it: it hands the conversation's own AI a targeted instruction.
 *  - NONE: nothing binds a value to the subject. "Productivity gains of 10 %" is NONE for
 *    a rule on discounts.
 * No stemming, no inference, no world knowledge: the AI does the rest.
 */

export type ContentScope = 'prompt' | 'file_write' | 'answer';

export interface NumberBound {
  readonly kind: 'number_bound';
  readonly operator: 'lt' | 'lte' | 'gt' | 'gte';
  readonly limit: string;
  readonly unit: 'percent' | 'amount' | 'count';
  readonly currency?: string | undefined;
  readonly binding_window: number;
}

export interface ForbiddenTerms {
  readonly kind: 'forbidden_terms';
  readonly terms: readonly string[];
  readonly context_exceptions: readonly string[];
}

export interface ContentRule {
  readonly id: string;
  readonly kind: 'content';
  readonly decision: 'forbid' | 'ask';
  readonly reason: string;
  readonly required: boolean;
  readonly topic: string;
  readonly text: string;
  readonly subject_aliases: readonly string[];
  readonly scopes: readonly ContentScope[];
  readonly constraint: NumberBound | ForbiddenTerms;
  /** `review`: the rule depends on a condition code cannot read, so code never blocks on it, the AI decides. */
  readonly mode?: 'block' | 'review' | undefined;
  readonly alternatives: readonly string[];
  /** The reviewed artifact the centre signed with the rule (ADR-0118); absent on a legacy rule. */
  readonly fiche?:
    | {
        readonly interpretation: string;
        readonly examples: {
          readonly violation: readonly string[];
          readonly compliant: readonly string[];
          readonly other_subject: readonly string[];
          readonly ambiguous: readonly string[];
        };
      }
    | undefined;
}

export interface Finding {
  readonly rule: ContentRule;
  readonly kind: 'violation' | 'ambiguous';
  /** What was seen, short and from the text itself, for the explanation. */
  readonly seen: string;
  /** The value or term itself, normalized: what an attestation's evidence must contain. */
  readonly mention: string;
}

// ------------------------------------------------------------ normalization

/** NFKC, lower case, one space between words, typographic quotes and dashes made plain. */
export function normalize(text: string): string {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\u2018\u2019\u02bc]/gu, "'")
      // prose quotes stay apart from the plain `"` that also delimits strings in data (JSON, tables)
      .replace(/[\u201c\u00ab]/gu, '«')
      .replace(/[\u201d\u00bb]/gu, '»')
      .replace(/[\u2010-\u2015\u2212]/gu, '-')
      .replace(/[\u00a0\u202f\u2009]/gu, ' ')
  );
}

const tokenize = (text: string): string[] => text.match(/[\p{L}\p{N}_]+/gu) ?? [];

/** A sentence is the unit of binding; decimals and abbreviations with digits do not end one. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<![\d])[.!?]+(?=\s|$)|[\n;]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

// ------------------------------------------------------------------ values

export interface Mention {
  /** Index in the normalized sentence where the value starts and ends. */
  readonly start: number;
  readonly end: number;
  readonly value: number;
  /** Every plausible reading of the digits: "4,999" is 4.999 in French and 4999 in English. */
  readonly values: readonly number[];
  readonly unit: 'percent' | 'amount' | 'count' | 'spelled';
  readonly currency?: string;
  readonly raw: string;
}

const PERCENT_WORDS = String.raw`%|pct|p\.c\.|pour\s*cent|pourcent|percent|per\s*cent`;
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:[\s.]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?`;

const decimal = (raw: string): number => {
  // 1 234,5 / 1.234,5 / 1,234.5 / 2,000,000 / 12,5 / 12.5
  const compact = raw.replace(/\s/gu, '');
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    return lastComma > lastDot
      ? Number(compact.replaceAll('.', '').replace(',', '.'))
      : Number(compact.replaceAll(',', ''));
  }
  const separator = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : '';
  if (separator === '') return Number(compact);
  const parts = compact.split(separator);
  // several of the same separator group thousands; one comma before three digits is read as grouping here
  if (parts.length > 2 || (parts[1]?.length === 3 && separator === ',')) {
    return Number(parts.join(''));
  }
  return Number(parts.join('.'));
};

/**
 * The readings of a written number. A single separator before exactly three digits is a decimal
 * mark in French and a thousands mark in English: for a percentage both are plausible ("4,999 %"),
 * for an amount or a count only grouping is ("12,500 USD", "1.250 pages").
 */
function readings(raw: string, unit: 'percent' | 'amount' | 'count'): number[] {
  const compact = raw.replace(/\s/gu, '');
  const single = /^\d{1,3}[.,]\d{3}$/u.test(compact);
  if (!single) return [decimal(raw)];
  const grouped = Number(compact.replace(/[.,]/u, ''));
  // a dot after a single digit ("1.001 EUR") is as likely a decimal mark as a thousands one
  const decimalToo = unit === 'percent' || (unit === 'amount' && /^\d{1,3}\.\d{3}$/u.test(compact));
  return decimalToo ? [grouped, Number(compact.replace(',', '.'))] : [grouped];
}

const SPELLED =
  /\b(?:un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent|one|two|three|four|five|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundred)\b(?:[\s-]+(?:et|and|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|quinze|vingt|trente|quarante|cinquante|soixante|cent|one|two|three|four|five|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|hundred))*\s*(?:pour\s*cent|pourcent|percent|per\s*cent|%)/gu;

/** "150k €", "1,2 M€", "2 millions d'euros", "3 Md$". */
const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1e3,
  m: 1e6,
  mio: 1e6,
  million: 1e6,
  millions: 1e6,
  md: 1e9,
  mds: 1e9,
  bn: 1e9,
  milliard: 1e9,
  milliards: 1e9,
};

const CURRENCIES: Record<string, string> = {
  '€': 'EUR',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  $: 'USD',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  '£': 'GBP',
  gbp: 'GBP',
  livres: 'GBP',
};
// any ISO code the schema accepts is enforced, not only the three common ones
const ISO =
  'chf cad aud nzd jpy cny inr sek nok dkk pln czk huf ron bgn brl mxn zar try krw sgd hkd aed sar ils thb idr'.split(
    ' ',
  );
for (const code of ISO) CURRENCIES[code] = code.toUpperCase();
const CURRENCY_AFTER = `€|eur(?:os?)?|usd|dollars?|\\$|£|gbp|${ISO.join('|')}`;
const CURRENCY_BEFORE = `€|\\$|£|eur|usd|gbp|${ISO.join('|')}`;

/** Every value a sentence states, with where it is. Spelled-out numbers are only flagged. */
export function mentions(sentence: string, extraCurrencies: readonly string[] = []): Mention[] {
  const extra = extraCurrencies
    .map((code) => code.toLowerCase())
    .filter((code) => /^[a-z]{3}$/u.test(code));
  for (const code of extra) CURRENCIES[code] = code.toUpperCase();
  const after = [CURRENCY_AFTER, ...extra].join('|');
  const before = [CURRENCY_BEFORE, ...extra].join('|');
  const found: Mention[] = [];
  // ISO dates, slash dates and clock times are not values anyone caps
  const dates = [
    ...sentence.matchAll(
      /\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|\d{1,2}:\d{2}(?::\d{2})?/gu,
    ),
  ].map((match) => [match.index, match.index + match[0].length] as const);
  const taken = (start: number, end: number): boolean =>
    found.some((m) => start < m.end && end > m.start) ||
    dates.some(([from, to]) => start < to && end > from);
  // 1e2 is a hundred: written this way it cannot be read as the 2 that follows, so it is a doubt
  for (const match of sentence.matchAll(/\d+(?:[.,]\d+)?e[+-]?\d+/gu)) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      value: Number.NaN,
      values: [],
      unit: 'spelled',
      raw: match[0],
    });
  }
  const percent = new RegExp(`(\\.\\d+|${NUMBER})\\s*(?:${PERCENT_WORDS})(?![\\p{L}\\d])`, 'gu');
  for (const match of sentence.matchAll(percent)) {
    const start = match.index;
    if (taken(start, start + match[0].length)) continue;
    found.push({
      start,
      end: start + match[0].length,
      value: decimal(match[1] ?? ''),
      values: readings(match[1] ?? '', 'percent'),
      unit: 'percent',
      raw: match[0],
    });
  }
  const bps = new RegExp(
    `(${NUMBER})\\s*(?:bps|bp|points?\\s+de\\s+base|basis\\s+points?)(?![\\p{L}\\d])`,
    'gu',
  );
  for (const match of sentence.matchAll(bps)) {
    const start = match.index;
    if (taken(start, start + match[0].length)) continue;
    found.push({
      start,
      end: start + match[0].length,
      value: decimal(match[1] ?? '') / 100,
      values: [decimal(match[1] ?? '') / 100],
      unit: 'percent',
      raw: match[0],
    });
  }
  for (const match of sentence.matchAll(SPELLED)) {
    const start = match.index;
    if (taken(start, start + match[0].length)) continue;
    found.push({
      start,
      end: start + match[0].length,
      value: Number.NaN,
      values: [],
      unit: 'spelled',
      raw: match[0],
    });
  }
  const amountAfter = new RegExp(
    `(\\.\\d+|${NUMBER})\\s*(k|md|mds|bn|mio|m|millions?|milliards?)?\\s*(?:d['’]\\s*)?(${after})(?![\\p{L}\\d])`,
    'gu',
  );
  for (const match of sentence.matchAll(amountAfter)) {
    const start = match.index;
    if (taken(start, start + match[0].length)) continue;
    const factor = MULTIPLIERS[match[2] ?? ''] ?? 1;
    found.push({
      start,
      end: start + match[0].length,
      value: decimal(match[1] ?? '') * factor,
      values: readings(match[1] ?? '', 'amount').map((value) => value * factor),
      unit: 'amount',
      currency: CURRENCIES[match[3] ?? ''] ?? '',
      raw: match[0],
    });
  }
  const amountBefore = new RegExp(
    `(?<![\\p{L}])(${before})\\s*(\\.\\d+|${NUMBER})(?:\\s*(k|md|mds|bn|mio|m|millions?|milliards?)(?![\\p{L}\\d]))?`,
    'gu',
  );
  for (const match of sentence.matchAll(amountBefore)) {
    const start = match.index;
    if (taken(start, start + match[0].length)) continue;
    found.push({
      start,
      end: start + match[0].length,
      value: decimal(match[2] ?? '') * (MULTIPLIERS[match[3] ?? ''] ?? 1),
      values: readings(match[2] ?? '', 'amount').map(
        (value) => value * (MULTIPLIERS[match[3] ?? ''] ?? 1),
      ),
      unit: 'amount',
      currency: CURRENCIES[match[1] ?? ''] ?? '',
      raw: match[0],
    });
  }
  for (const match of sentence.matchAll(
    new RegExp(`(?<![\\p{L}\\d.,])(${NUMBER})(?![\\p{L}\\d%])`, 'gu'),
  )) {
    const start = match.index;
    if (taken(start, start + match[0].length)) continue;
    found.push({
      start,
      end: start + match[0].length,
      value: decimal(match[1] ?? ''),
      values: readings(match[1] ?? '', 'count'),
      unit: 'count',
      raw: match[0],
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

// ----------------------------------------------------------------- binding

/** Words that may stand between a subject and its value without changing whose value it is. */
const FILLERS = new Set([
  'de',
  'd',
  'du',
  'des',
  'of',
  'the',
  'a',
  'an',
  'un',
  'une',
  'le',
  'la',
  'l',
  'les',
  'est',
  'is',
  'sera',
  'will',
  'be',
  'to',
  'at',
  'up',
  'jusqu',
  'jusque',
  'off',
  'au',
  'aux',
  'moins',
  'plus',
  'least',
  'most',
  'than',
  'that',
  'que',
  'minimum',
  'maximum',
  'min',
  'max',
  'maximale',
  'minimale',
  'supplementaire',
  'additionnelle',
  'additional',
  'extra',
  'totale',
  'total',
  'globale',
  'fixe',
  'flat',
  'standard',
]);

const LINKS = new Set([
  'for',
  'pour',
  'with',
  'avec',
  'on',
  'sur',
  'per',
  'par',
  'by',
  'among',
  'parmi',
  'chez',
  'among',
]);

/** The sentence is not stating a value or a use: it supposes one, or sets it aside. */
const HYPOTHETICALS = new Set([
  'si',
  'if',
  'would',
  'could',
  'might',
  'serait',
  'seraient',
  'etait',
  'etaient',
  'were',
  'imaginons',
  'imagine',
  'suppose',
  'supposons',
  'hypothese',
  'hypothetique',
  'pourrait',
  'pourraient',
  'signeriez',
  'accepteriez',
  'whether',
  'quand',
]);

const NEGATIONS = new Set([
  'exclude',
  'excluded',
  'excluding',
  'exclure',
  'exclu',
  'exclue',
  'avoid',
  'avoiding',
  'eviter',
  'evitez',
  'bannir',
  'banned',
  'retirer',
  'retirez',
  'ne',
  'pas',
  'jamais',
  'sans',
  'no',
  'not',
  'never',
  'without',
  'aucun',
  'aucune',
  'interdit',
  'interdite',
  'forbidden',
  'prohibited',
  'depasse',
  'depasser',
  'depassent',
  'exceed',
  'exceeds',
  'exceeding',
  'cannot',
  'cant',
  "can't",
  'impossible',
  'refuse',
  'refused',
  'refuser',
  'non',
]);

const stripAccents = (word: string): string => word.normalize('NFD').replace(/\p{M}/gu, '');

/**
 * Is the span quoted as a mention ("the word « Acme » is banned") rather than used? A plain `"` that
 * opens a value in data (`{"note": "Acme"}`, `| x | "Acme" |`) delimits a string, it quotes nothing.
 */
const hasQuoteAround = (sentence: string, start: number, end: number): boolean => {
  const before = sentence.slice(0, start);
  const after = sentence.slice(end);
  const opened = before.lastIndexOf('«');
  if (opened > before.lastIndexOf('»') && after.includes('»')) return true;
  if ((before.match(/"/gu)?.length ?? 0) % 2 !== 1 || !after.includes('"')) return false;
  const lead = before.slice(0, before.lastIndexOf('"')).trimEnd().slice(-1);
  return !':{[,=(|'.includes(lead) || lead === '';
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

type Binding = 'explicit' | 'ambiguous' | 'none';

/** How a mention relates to the nearest occurrence of one of the subject's names. */
function bind(
  sentence: string,
  mention: Mention,
  aliases: readonly string[],
  window: number,
): { binding: Binding; alias?: string } {
  let best: { binding: Binding; alias?: string } = { binding: 'none' };
  for (const alias of aliases) {
    const needle = normalize(alias);
    let from = 0;
    for (;;) {
      const at = sentence.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;
      const before = at + needle.length <= mention.start;
      const gap = before
        ? sentence.slice(at + needle.length, mention.start)
        : sentence.slice(mention.end, at);
      // the alias must be a whole phrase, not the middle of a word
      const left = sentence[at - 1] ?? ' ';
      const right = sentence[at + needle.length] ?? ' ';
      if (/[\p{L}\d]/u.test(left) || /[\p{L}\d]/u.test(right)) continue;
      // a comma, a semicolon or a bracket between them ends the clause: they are not one phrase.
      // A `|` and a `:` bind a table cell or a key to its value, but only the subject-first way round.
      const split = before ? /[,;()[\]{}]/u : /[,;()[\]{}|:=]/u;
      if (split.test(gap)) continue;
      const between = tokenize(gap).map(stripAccents);
      if (between.length > window) continue;
      const unknown = between.filter((word) => !FILLERS.has(word) && !/^\d/u.test(word)).length;
      const another = between.some((word) => /^\d/u.test(word));
      // far apart (three or more unrelated words) is another subject, whatever the words are
      if (unknown >= 3 && !another) continue;
      // "for", "with", "on", "per"...: a recipient, a purpose or a basis, not the value's own phrase
      if (between.some((word) => LINKS.has(word))) {
        best = { binding: 'ambiguous', alias };
        continue;
      }
      // one qualifying word is still the same phrase ("remise exceptionnelle de 15 %", "net 90 days");
      // three or more unrelated words and the subject is somewhere else in the sentence
      if (unknown <= 1 && !another && !gap.includes('"')) return { binding: 'explicit', alias };
      best = { binding: 'ambiguous', alias };
    }
  }
  return best;
}

const holds = (value: number, operator: NumberBound['operator'], limit: number): boolean =>
  operator === 'lt'
    ? value < limit
    : operator === 'lte'
      ? value <= limit
      : operator === 'gt'
        ? value > limit
        : value >= limit;

/** How the text qualifies a value: a floor ("at least 10"), a ceiling ("up to 10", "< 10"), a sign, or nothing. */
function qualifier(sentence: string, mention: Mention): 'floor' | 'ceiling' | 'signed' | 'exact' {
  const before = sentence.slice(Math.max(0, mention.start - 22), mention.start);
  if (/[-+\u2212]\s*$/u.test(before)) return 'signed';
  if (
    /(?:au moins|at least|minimum|\bmin\.?|plus de|more than|\bover|\babove|>=?|\u2265|a partir de|à partir de|\bfrom)\s*(?:de|d'|of|than|que|to|à|a)?\s*$/u.test(
      before,
    )
  )
    return 'floor';
  if (
    /(?:au plus|at most|up to|jusqu['’]?\s*[aà]?|maximum|\bmax\.?|moins de|less than|\bunder|\bbelow|<=?|\u2264|no more than|pas plus de|capped at|plafonn\p{L}* [aà])\s*(?:de|d'|of|than|que|to|à|a)?\s*$/u.test(
      before,
    )
  )
    return 'ceiling';
  return 'exact';
}

function checkNumber(rule: ContentRule, constraint: NumberBound, sentence: string): Finding[] {
  const out: Finding[] = [];
  const limit = Number(constraint.limit);
  const negated = tokenize(sentence)
    .map(stripAccents)
    .some((word) => NEGATIONS.has(word) || HYPOTHETICALS.has(word));
  for (const mention of mentions(
    sentence,
    constraint.currency !== undefined ? [constraint.currency] : [],
  )) {
    const seen = sentence
      .slice(Math.max(0, mention.start - 24), Math.min(sentence.length, mention.end + 24))
      .trim();
    // `"remise": "10%"`, `discount = 10%`: a key and its value are bound by the syntax, quotes included
    const structured = rule.subject_aliases.some((alias) =>
      new RegExp(
        `(?<![\\p{L}\\d_])"?${escapeRegExp(normalize(alias))}"?\\s*[:=]\\s*"?\\s*${escapeRegExp(mention.raw)}`,
        'u',
      ).test(sentence),
    );
    const { binding } = structured
      ? { binding: 'explicit' as const }
      : bind(sentence, mention, rule.subject_aliases, constraint.binding_window);
    if (binding === 'none') continue;
    if (mention.unit === 'spelled') {
      out.push({ rule, kind: 'ambiguous', seen, mention: mention.raw });
      continue;
    }
    // a bare count next to a percent rule is somebody else's number
    const sameUnit =
      mention.unit === constraint.unit &&
      (constraint.unit !== 'amount' || mention.currency === constraint.currency);
    if (!sameUnit) {
      if (mention.unit !== 'count')
        out.push({ rule, kind: 'ambiguous', seen, mention: mention.raw });
      continue;
    }
    // beyond double precision "5.0000000000000001" equals 5: the comparison cannot be trusted, so it is a doubt
    if (mention.raw.replace(/\D/gu, '').replace(/^0+/u, '').length > 15) {
      out.push({ rule, kind: 'ambiguous', seen, mention: mention.raw });
      continue;
    }
    const kept = mention.values.filter((value) => holds(value, constraint.operator, limit));
    if (kept.length === mention.values.length) continue;
    // JSON quotes are syntax and prose quotes are somebody's words: hasQuoteAround tells them apart
    const quoted = hasQuoteAround(sentence, mention.start, mention.end);
    const how = qualifier(sentence, mention);
    // a floor above the cap breaks it whatever the exact value; a ceiling, a sign or an unsure
    // reading of the digits is not a stated value
    const stated =
      kept.length === 0 &&
      (how === 'exact' || (how === 'floor' && mention.values.every((value) => value > limit)));
    out.push({
      rule,
      kind: binding === 'explicit' && !negated && !quoted && stated ? 'violation' : 'ambiguous',
      seen,
      mention: mention.raw,
    });
  }
  return out;
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '');

function checkTerms(rule: ContentRule, constraint: ForbiddenTerms, sentence: string): Finding[] {
  const out: Finding[] = [];
  const clean = (text: string): string => normalize(text);
  const folded = fold(sentence);
  const needles = constraint.terms.map(clean);
  // diacritics are ignored only when the TERM carries them: "Société Générale" is found typed as
  // "Societe Generale", while the plain name "Acme" is not found inside the French word "acmé"
  const view = (needle: string): { haystack: string; word: string } =>
    fold(needle) === needle
      ? { haystack: sentence, word: needle }
      : { haystack: folded, word: fold(needle) };
  // a negation inside the term itself ("sans engagement") is not a negation of the sentence
  let rest = sentence;
  for (const needle of needles) rest = rest.split(needle).join(' ').split(fold(needle)).join(' ');
  const negated = tokenize(rest)
    .map(stripAccents)
    .some((word) => NEGATIONS.has(word) || HYPOTHETICALS.has(word));
  const excepted = constraint.context_exceptions.some(
    (phrase) => sentence.includes(clean(phrase)) || folded.includes(fold(clean(phrase))),
  );
  for (const needle of needles) {
    const { haystack, word } = view(needle);
    // a boundary only matters where the term itself ends in a letter or digit ("eval(" has none on the right)
    const guardLeft = /^[\p{L}\d]/u.test(word);
    const guardRight = /[\p{L}\d]$/u.test(word);
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(word, from);
      if (at < 0) break;
      from = at + word.length;
      const left = haystack[at - 1] ?? ' ';
      // a plural "s" still names the term; any other letter means a longer word
      const tail = haystack.slice(at + word.length);
      const right = /^s(?![\p{L}\d])/u.test(tail) ? (tail[1] ?? ' ') : (tail[0] ?? ' ');
      if (guardLeft && /[\p{L}\d]/u.test(left)) continue;
      if (guardRight && /[\p{L}\d]/u.test(right)) continue;
      const quoted = hasQuoteAround(sentence, at, at + word.length);
      out.push({
        rule,
        kind: negated || quoted || excepted ? 'ambiguous' : 'violation',
        seen: sentence
          .slice(Math.max(0, at - 24), Math.min(sentence.length, at + word.length + 24))
          .trim(),
        mention: word,
      });
    }
  }
  return out;
}

/** What `text` does to `rule`: its violations and the places a human or the AI must look at. */
export function check(rule: ContentRule, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const raw of sentences(normalize(text))) {
    findings.push(
      ...(rule.constraint.kind === 'number_bound'
        ? checkNumber(rule, rule.constraint, raw)
        : checkTerms(rule, rule.constraint, raw)),
    );
  }
  // a rule that depends on what code cannot read (a tender, a public text) is never blocked by code
  return rule.mode === 'review'
    ? findings.map((finding) => ({ ...finding, kind: 'ambiguous' as const }))
    : findings;
}
