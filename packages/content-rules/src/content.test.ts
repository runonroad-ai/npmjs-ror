/**
 * The labelled set behind the claim "a number is not a violation until it is the rule's number"
 * (ADR-0117). Each line says what a rule on discounts (at most 5 %) must do with a sentence; the
 * counts at the bottom are the measured false blocks and false allows of the deterministic part.
 */
import { describe, expect, it } from 'vitest';

import { check, mentions, normalize, sentences, type ContentRule } from './content.js';

const discount: ContentRule = {
  id: 'g@1:discount',
  kind: 'content',
  decision: 'forbid',
  reason: 'A tender discount never exceeds 5 %.',
  required: true,
  topic: 'tenders',
  text: 'No discount above 5 % in a tender.',
  subject_aliases: ['remise', 'rabais', 'discount', 'réduction', 'reduction', 'ristourne'],
  scopes: ['prompt', 'file_write', 'answer'],
  constraint: {
    kind: 'number_bound',
    operator: 'lte',
    limit: '5',
    unit: 'percent',
    binding_window: 6,
  },
  alternatives: ['Offer a longer payment term', 'Offer a volume tier'],
};

const customers: ContentRule = {
  id: 'g@1:customer',
  kind: 'content',
  decision: 'forbid',
  reason: 'Never name Acme in public material.',
  required: true,
  topic: 'marketing',
  text: 'Never name the customer Acme.',
  subject_aliases: [],
  scopes: ['prompt', 'file_write', 'answer'],
  constraint: {
    kind: 'forbidden_terms',
    terms: ['Acme', 'Acme Corp'],
    context_exceptions: ['internal only'],
  },
  alternatives: ['Say "a leading retailer"'],
};

type Expected = 'violation' | 'ambiguous' | 'none';
const verdictOf = (rule: ContentRule, text: string): Expected => {
  const findings = check(rule, text);
  if (findings.some((f) => f.kind === 'violation')) return 'violation';
  return findings.length > 0 ? 'ambiguous' : 'none';
};

const DISCOUNT_CASES: readonly (readonly [string, Expected])[] = [
  // the founder's examples
  ['Je veux mettre 10% de remise sur cet appel d’offres', 'violation'],
  ['Nous avons besoin de gains de productivité d’au moins 10%', 'none'],
  ['Ajoute une remise de 10 % pour le client', 'violation'],
  ['Applique une remise de 5 %', 'none'],
  ['Applique une remise de 4,9 %', 'none'],
  ['Applique une remise de 5,1 %', 'violation'],
  // spellings of the value
  ['remise de 10 pct', 'violation'],
  ['remise de 10 pour cent', 'violation'],
  ['remise de 10 percent', 'violation'],
  ['discount of 12.5%', 'violation'],
  ['discount: 15%', 'violation'],
  ['discount = 8 %', 'violation'],
  ['"discount": "10%"', 'violation'],
  ['remise : 1000 bps', 'violation'],
  ['remise de 300 bps', 'none'],
  ['un rabais de 20 %', 'violation'],
  ['10 % de remise', 'violation'],
  ['10% discount on the whole order', 'violation'],
  ['offer them a 10% discount', 'violation'],
  ['Une remise de dix pour cent', 'ambiguous'],
  ['a discount of ten percent', 'ambiguous'],
  // other subjects must never be blocked
  ['Increase conversion by 10% this quarter', 'none'],
  ['La marge brute doit rester supérieure à 30%', 'none'],
  ['Nous visons 15 % de croissance', 'none'],
  ['Pay within 30 days, 2% late fee', 'none'],
  ['Le taux de TVA est de 20 %', 'none'],
  ['Remise en état du site : 12 jours', 'none'],
  // a discount sentence that carries another subject's number
  ['La remise reste à 5 % mais la productivité monte de 10 %', 'none'],
  ['Discount stays at 5% while productivity rises 10%', 'ambiguous'],
  // restating or refusing the rule is not breaking it
  ['La remise ne doit pas dépasser 5 %', 'none'],
  ['Pas de remise de 10 %, c’est interdit', 'ambiguous'],
  ['We cannot offer a 10% discount', 'ambiguous'],
  ['The policy says "discount of 10%" is forbidden', 'ambiguous'],
  // amounts and counts are other units
  ['remise de 500 €', 'ambiguous'],
  ['3 remises possibles', 'none'],
  // several sentences
  ['Bonjour. La remise sera de 7 %. Merci.', 'violation'],
  ['Bonjour. Productivité +10 %. Remise 2 %.', 'none'],
  // round 4 of Codex's review: what looks like a discount and is not, or is not stated
  ['Discount for 10% of the customers', 'ambiguous'],
  ['Remise pour 10 % des clients', 'ambiguous'],
  ['Discount < 10%', 'ambiguous'],
  ['Remise ≤ 10 %', 'ambiguous'],
  ['Remise jusqu’à 10 %', 'ambiguous'],
  ['Remise maximum de 10 %', 'ambiguous'],
  ['Discount up to 3%', 'none'],
  ['Remise: -10%', 'ambiguous'],
  ['Remise d’au moins 10 %', 'violation'],
  ['Discount of at least 3%', 'none'],
  ['Remise de 4,999 %', 'ambiguous'],
  ['Remise de 5,001 %', 'violation'],
  ['Remise de 5,000 %', 'ambiguous'],
  // decimals do not split a sentence
  ['remise de 5.5%', 'violation'],
  ['réduction de 1 000 €', 'ambiguous'],
];

describe('the discount rule on labelled sentences', () => {
  for (const [text, expected] of DISCOUNT_CASES) {
    it(`${expected}: ${text}`, () => {
      expect(verdictOf(discount, text)).toBe(expected);
    });
  }

  it('measures zero bare-number blocks, zero false blocks and zero false allows on this set', () => {
    const wrong = DISCOUNT_CASES.filter(
      ([text, expected]) => verdictOf(discount, text) !== expected,
    );
    expect(wrong).toEqual([]);
    const bare = DISCOUNT_CASES.filter(
      ([text, expected]) => expected === 'none' && verdictOf(discount, text) === 'violation',
    );
    expect(bare).toEqual([]);
  });
});

describe('forbidden terms', () => {
  const cases: readonly (readonly [string, Expected])[] = [
    ['Write a press release about Acme', 'violation'],
    ['Write a press release about ACME Corp.', 'violation'],
    ['Rédige un communiqué sur le client Acme', 'violation'],
    ['Write a press release about acmeology', 'none'],
    ['Write a press release about a leading retailer', 'none'],
    ['Never mention "Acme" in the text', 'ambiguous'],
    ['Do not name Acme anywhere', 'ambiguous'],
    ['Acme is internal only, keep it in the notes', 'ambiguous'],
  ];
  for (const [text, expected] of cases) {
    it(`${expected}: ${text}`, () => {
      expect(verdictOf(customers, text)).toBe(expected);
    });
  }
});

describe('helpers', () => {
  it('reads each way of writing a value', () => {
    const found = mentions(normalize('remise de 1 234,5 € puis 10 % et 250 bps'));
    expect(found.map((m) => [m.unit, m.value])).toEqual([
      ['amount', 1234.5],
      ['percent', 10],
      ['percent', 2.5],
    ]);
  });
  it('does not end a sentence on a decimal point', () => {
    expect(sentences('Remise de 5.5 %. Merci')).toEqual(['Remise de 5.5 %', 'Merci']);
  });
  it('flags a spelled-out percentage without reading it', () => {
    expect(mentions('remise de dix pour cent').map((m) => m.unit)).toEqual(['spelled']);
  });
});

describe('generic fixes from the broad corpus (ADR-0117)', () => {
  const cap = (
    decision: 'forbid' | 'ask',
    unit: 'percent' | 'amount' | 'count',
    limit: string,
    currency?: string,
  ): ContentRule => ({
    ...discount,
    decision,
    subject_aliases: ['remise', 'discount', 'budget', 'pages'],
    constraint: {
      kind: 'number_bound',
      operator: 'lte',
      limit,
      unit,
      ...(currency === undefined ? {} : { currency }),
      binding_window: 6,
    },
  });
  const amount = cap('forbid', 'amount', '5000', 'USD');
  const count = cap('forbid', 'count', '30');

  it('reads English thousands as thousands for an amount and a count', () => {
    expect(verdictOf(amount, 'Budget of 12,500 USD')).toBe('violation');
    expect(verdictOf(amount, 'Budget of 2,000,000 USD')).toBe('violation');
    expect(verdictOf(count, '1.250 pages')).toBe('violation');
    expect(verdictOf(count, '25 pages')).toBe('none');
  });
  it('reads "150k €", "1,2 M€" and "2 millions d’euros"', () => {
    const eur = cap('forbid', 'amount', '100000', 'EUR');
    expect(verdictOf(eur, 'Budget de 150k €')).toBe('violation');
    expect(verdictOf(eur, 'Budget de 85 k€')).toBe('none');
    expect(verdictOf(eur, 'Budget de 1,2 M€')).toBe('violation');
    expect(verdictOf(eur, 'Budget de 2 millions d’euros')).toBe('violation');
  });
  it('never takes a date or a time for a value', () => {
    expect(verdictOf(count, 'Report of 2026-10-18 at 14:30: 12 pages')).toBe('none');
    expect(verdictOf(count, 'Du 12/10/2026 au 15/10/2026 : 40 pages')).toBe('violation');
  });
  it('lets one qualifying word through, and not a recipient or a distant subject', () => {
    expect(verdictOf(discount, 'Une remise exceptionnelle de 15 %')).toBe('violation');
    expect(verdictOf(discount, 'Discount rate of 12%')).toBe('violation');
    expect(verdictOf(discount, 'Discount for 10% of the customers')).toBe('ambiguous');
    expect(
      verdictOf(discount, 'Revenue is up 12% year on year and the discount rate stays at 2%'),
    ).toBe('none');
  });
  it('ends a phrase at a comma: "31%, discount offered 4%" is not "31% discount"', () => {
    expect(verdictOf(discount, 'Gross margin is 31%, discount offered 4%, payment 30 days')).toBe(
      'none',
    );
  });
  it('binds a table cell and a key to their value, not the other way round', () => {
    expect(verdictOf(discount, '| Remise | 12 % |')).toBe('violation');
    expect(verdictOf(discount, '| 12 % | Remise |')).toBe('none');
  });
  it('finds a term in data, plural, typed without accents, and not inside another word', () => {
    expect(verdictOf(customers, '{"client": "Acme"}')).toBe('violation');
    expect(verdictOf(customers, 'Rédige pour les Acmes')).toBe('violation');
    expect(verdictOf(customers, 'Le sommet, l’acmé du parcours')).toBe('none');
    const bank: ContentRule = {
      ...customers,
      constraint: { kind: 'forbidden_terms', terms: ['Société Générale'], context_exceptions: [] },
    };
    expect(verdictOf(bank, 'Contrat avec Societe Generale')).toBe('violation');
    expect(verdictOf(bank, 'Contrat avec SOCIÉTÉ GÉNÉRALE')).toBe('violation');
  });
  it('does not take a negation inside the term for a negation of the sentence', () => {
    const rule: ContentRule = {
      ...customers,
      constraint: { kind: 'forbidden_terms', terms: ['sans engagement'], context_exceptions: [] },
    };
    expect(verdictOf(rule, 'Une offre sans engagement pour tous')).toBe('violation');
    expect(verdictOf(rule, 'Jamais de formule sans engagement')).toBe('ambiguous');
  });
  it('finds a term made of symbols such as "eval(" and keeps the edges that are letters', () => {
    const code: ContentRule = {
      ...customers,
      constraint: { kind: 'forbidden_terms', terms: ['eval('], context_exceptions: [] },
    };
    expect(verdictOf(code, 'const x = eval(input)')).toBe('violation');
    expect(verdictOf(code, 'medieval(2)')).toBe('none');
  });
  it('tells a quotation of a word from a string in data', () => {
    expect(verdictOf(customers, 'Le mot « Acme » est interdit')).toBe('ambiguous');
    expect(verdictOf(customers, 'Note: "Acme choisit notre solution"')).toBe('violation');
  });
});

describe('review mode and alternatives', () => {
  it('a rule that depends on a condition code cannot read is never blocked by code', () => {
    const review: ContentRule = { ...discount, mode: 'review' };
    expect(verdictOf(review, 'Je veux mettre 10% de remise')).toBe('ambiguous');
    expect(verdictOf(discount, 'Je veux mettre 10% de remise')).toBe('violation');
  });
});

describe('a currency written before the amount', () => {
  const expense: ContentRule = {
    ...discount,
    id: 'g@1:expense',
    subject_aliases: ['expenses', 'expense', 'note de frais'],
    constraint: {
      kind: 'number_bound',
      operator: 'lte',
      limit: '500',
      unit: 'amount',
      currency: 'EUR',
      binding_window: 6,
    },
  };
  it('reads EUR 1,250.00 and € 700 the way it reads 700 €', () => {
    expect(verdictOf(expense, 'Expenses: EUR 1,250.00.')).toBe('violation');
    expect(verdictOf(expense, 'Expenses: EUR 550 total for this claim.')).toBe('violation');
    expect(verdictOf(expense, 'Note de frais : € 700')).toBe('violation');
    expect(verdictOf(expense, 'Expenses: EUR 120.')).toBe('none');
    expect(verdictOf(expense, 'Expenses: USD 900.')).toBe('ambiguous');
  });
});

describe('review findings: currencies, key boundary, precision', () => {
  const chf: ContentRule = {
    ...discount,
    id: 'g@1:chf',
    subject_aliases: ['budget'],
    constraint: {
      kind: 'number_bound',
      operator: 'lte',
      limit: '100',
      unit: 'amount',
      currency: 'CHF',
      binding_window: 6,
    },
  };
  it('enforces any ISO currency, not only EUR USD GBP', () => {
    expect(verdictOf(chf, 'Budget: 101 CHF')).toBe('violation');
    expect(verdictOf(chf, 'Budget: 90 CHF')).toBe('none');
  });
  it('does not bind a key that merely ends with the subject', () => {
    expect(verdictOf(discount, '{"not_discount": "10%"}')).not.toBe('violation');
    expect(verdictOf(discount, '{"discount": "10%"}')).toBe('violation');
  });
  it('doubts a value beyond double precision instead of rounding it into compliance', () => {
    expect(verdictOf(discount, 'discount: 5.0000000000000001%')).toBe('ambiguous');
  });
});

describe('review round 2', () => {
  it('enforces a currency only the rule names (ISK)', () => {
    const isk: ContentRule = {
      ...discount,
      id: 'g@1:isk',
      subject_aliases: ['budget'],
      constraint: {
        kind: 'number_bound',
        operator: 'lte',
        limit: '100',
        unit: 'amount',
        currency: 'ISK',
        binding_window: 6,
      },
    };
    expect(verdictOf(isk, 'Budget: 101 ISK')).toBe('violation');
    expect(verdictOf(isk, 'Budget: ISK 101')).toBe('violation');
  });
});

describe('review round 3', () => {
  it('reads a multiplier after a currency written first', () => {
    const budget: ContentRule = {
      ...discount,
      id: 'g@1:b',
      subject_aliases: ['budget'],
      constraint: {
        kind: 'number_bound',
        operator: 'lte',
        limit: '100',
        unit: 'amount',
        currency: 'EUR',
        binding_window: 6,
      },
    };
    expect(verdictOf(budget, 'Budget: EUR 1 million')).toBe('violation');
    expect(verdictOf(budget, 'Budget: EUR 90')).toBe('none');
  });
});

describe('review round 5', () => {
  it('a dot after one digit in an amount may be a decimal mark', () => {
    const budget: ContentRule = {
      ...discount,
      id: 'g@1:c',
      subject_aliases: ['budget'],
      constraint: {
        kind: 'number_bound',
        operator: 'lte',
        limit: '5',
        unit: 'amount',
        currency: 'EUR',
        binding_window: 6,
      },
    };
    expect(verdictOf(budget, 'Budget: 1.001 EUR')).toBe('ambiguous');
    expect(verdictOf(budget, 'Budget: 100,000 EUR')).toBe('violation');
  });
});

describe('review round 6', () => {
  it('reads .9% as 0.9, not 9', () => {
    expect(verdictOf(discount, 'discount: .9%')).toBe('none');
    expect(verdictOf(discount, 'discount: 9%')).toBe('violation');
  });
});

describe('review round 10', () => {
  it('reads .9 EUR as 0.9', () => {
    const budget: ContentRule = {
      ...discount,
      id: 'g@1:d',
      subject_aliases: ['budget'],
      constraint: {
        kind: 'number_bound',
        operator: 'lte',
        limit: '5',
        unit: 'amount',
        currency: 'EUR',
        binding_window: 6,
      },
    };
    expect(verdictOf(budget, 'Budget: .9 EUR')).toBe('none');
    expect(verdictOf(budget, 'Budget: EUR .9')).toBe('none');
    expect(verdictOf(budget, 'Budget: 9 EUR')).toBe('violation');
  });
});

describe('review round 15', () => {
  it('doubts 12.500 EUR instead of blocking a compliant 12.50', () => {
    const b: ContentRule = {
      ...discount,
      id: 'g@1:e',
      subject_aliases: ['budget'],
      constraint: {
        kind: 'number_bound',
        operator: 'lte',
        limit: '20',
        unit: 'amount',
        currency: 'EUR',
        binding_window: 6,
      },
    };
    expect(verdictOf(b, 'Budget: 12.500 EUR')).toBe('ambiguous');
    expect(verdictOf(b, 'Budget: 25.000 EUR')).toBe('violation');
  });
});

describe('review round 23', () => {
  it('doubts scientific notation instead of reading its exponent', () => {
    expect(verdictOf(discount, 'discount: 1e2%')).toBe('ambiguous');
  });
});
