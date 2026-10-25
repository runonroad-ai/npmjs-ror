/**
 * The RHS subset the walking skeleton needs (SPEC-003 §2): the preamble and
 * the four blocks of ADR-0029, each block one free text (ADR-0082), and
 * nothing else.
 *
 * Unknown keys are REJECTED rather than ignored. A governance is a contract
 * an organization writes once and an agent obeys everywhere; a silently
 * dropped field would mean the author believes something is enforced that
 * never reaches the tool.
 */
import { z } from 'zod';

/** SPEC-003 §3.1: a block's text is capped so the rule file stays readable by the model. */
export const MAX_BLOCK_TEXT = 10_000;

const BlockText = z.string().max(MAX_BLOCK_TEXT).default('');

export const ContextSchema = z.strictObject({
  // Optional (ADR-0082): RHS-V11 asks for one non-empty field among the five, not for this one.
  preamble: z.string().default(''),
  allowed: BlockText,
  preferred: BlockText,
  ask_first: BlockText,
  forbidden: BlockText,
});

export const GovernanceHeaderSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9-]{2,48}$/u, 'must match [a-z0-9-]{2,48}'),
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  purpose: z.string().min(1).optional(),
  domain: z.string().min(1),
  category: z.string().min(1),
});

/**
 * Enforceable rules (ADR-0114), next to the free text. Only a rule written here
 * can be claimed as enforced; the blocks stay the human-readable intent. A
 * selector is typed, never a regular expression: what it matches is the same
 * for every client and every tool.
 */
const RuleId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u, 'must match [a-z0-9][a-z0-9-]{1,62}');

const RuleBase = {
  id: RuleId,
  /** `forbid` blocks; `ask` is an Ask-first, which denies until a derogation exists (ADR-0056). */
  decision: z.enum(['forbid', 'ask']),
  reason: z.string().min(1).max(300),
  /** True: a client that cannot fully enforce this rule refuses to activate the policy. */
  required: z.boolean().default(true),
};

/**
 * A glob, relative to the project (`secrets/**`), under the home (`~/.ssh/**`) or
 * absolute. Only `*`, `?` and a `**` that is a whole path segment: the three
 * barriers (permission rules, hook, sandbox) agree on these and on nothing
 * richer, so brackets, braces and escapes are refused here rather than
 * enforced differently in each (ADR-0114).
 */
const Glob = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_~./*?+@-]+$/u, 'only letters, digits, _ ~ . / * ? + @ - are allowed')
  .refine(
    (glob) =>
      !glob.split('/').some((part) => part === '..' || (part.includes('**') && part !== '**')),
    "no '..' segment, and '**' only as a whole segment",
  );

const PathRuleSchema = z.strictObject({
  ...RuleBase,
  kind: z.literal('path'),
  access: z.enum(['read', 'write', 'any']),
  glob: Glob,
});

/** `executable` run with `argv_prefix` as its leading positional words and any of `flags_any`. */
const CommandRuleSchema = z.strictObject({
  ...RuleBase,
  kind: z.literal('command'),
  executable: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/u),
  argv_prefix: z.array(z.string().min(1).max(64)).max(4).default([]),
  flags_any: z
    .array(z.string().regex(/^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/u))
    .max(8)
    .default([]),
});

const Phrase = z.string().min(1).max(80);
const Decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/u, 'a decimal string such as "5" or "2.5"')
  // beyond double precision a limit would be compared rounded
  .refine((value) => value.replace('.', '').replace(/^0+/u, '').length <= 15, {
    message: 'at most 15 significant digits',
  })
  // and a bounded scale, so a tiny positive limit never rounds to zero
  .refine((value) => (value.split('.')[1] ?? '').length <= 12, {
    message: 'at most 12 decimals',
  });

/**
 * What a content rule measures (ADR-0117). `operator` and `limit` describe the PERMITTED value:
 * `lte` + `5` + `percent` is "at most 5 %". The limit is a decimal string, never a float.
 */
const NumberBound = z
  .strictObject({
    kind: z.literal('number_bound'),
    operator: z.enum(['lt', 'lte', 'gt', 'gte']),
    limit: Decimal,
    unit: z.enum(['percent', 'amount', 'count']),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u, 'an ISO 4217 code such as EUR')
      .optional(),
    binding_window: z.number().int().min(1).max(12).default(6),
  })
  .refine((bound) => (bound.unit === 'amount') === (bound.currency !== undefined), {
    message: 'a currency is required for an amount and forbidden for any other unit',
    path: ['currency'],
  });

const ForbiddenTerms = z.strictObject({
  kind: z.literal('forbidden_terms'),
  terms: z.array(Phrase).min(1).max(32),
  context_exceptions: z.array(Phrase).max(32).default([]),
});

/**
 * The fiche of a content rule (ADR-0118): what the author reviewed once, at the centre, and what every
 * device then receives identically. `examples` say what the rule MEANS; `tests` are executable
 * boundary cases with the verdict the matcher must give. `approval` is written by the server only:
 * a draft never carries one, a published version carries the one the server sealed.
 */
const FicheExamples = z.strictObject({
  violation: z.array(z.string().min(1).max(300)).max(12).default([]),
  compliant: z.array(z.string().min(1).max(300)).max(12).default([]),
  other_subject: z.array(z.string().min(1).max(300)).max(12).default([]),
  ambiguous: z.array(z.string().min(1).max(300)).max(12).default([]),
});

export const FicheSchema = z.strictObject({
  schema_version: z.literal(1),
  matcher_version: z.string().min(1).max(60),
  interpretation: z.string().min(1).max(2000),
  examples: FicheExamples,
  tests: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(500),
        expected: z.enum(['violation', 'ambiguous', 'none']),
      }),
    )
    .min(1)
    .max(60),
  origin: z.enum(['form', 'assisted']),
  approval: z
    .strictObject({
      by: z.string().min(1).max(100),
      at: z.iso.datetime(),
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    })
    .optional(),
});
export type Fiche = z.infer<typeof FicheSchema>;

/**
 * A rule about what is said or written, not about a file or a command: the plain-language `text`
 * stays authoritative, the structured fields are data a client can check without code per rule.
 */
const ContentRuleSchema = z
  .strictObject({
    ...RuleBase,
    kind: z.literal('content'),
    topic: z.string().min(1).max(80),
    text: z.string().min(1).max(2000),
    /** The words that name what a number is about; a rule on terms has no number, so none. */
    subject_aliases: z.array(Phrase).max(32).default([]),
    scopes: z
      .array(z.enum(['prompt', 'file_write', 'answer']))
      .min(1)
      .max(3),
    constraint: z.discriminatedUnion('kind', [NumberBound, ForbiddenTerms]),
    /**
     * `block`: code stops an explicit violation by itself. `review`: the rule only applies under a
     * condition the code cannot read ("in a tender", "in public material"), so a finding is always
     * handed to the conversation's own AI to decide, never blocked by code.
     */
    mode: z.enum(['block', 'review']).default('block'),
    fiche: FicheSchema.optional(),
    /** Authored text shown with a refusal; checked against every prohibition by the client. */
    alternatives: z.array(z.string().min(1).max(300)).max(8).default([]),
  })
  .refine((rule) => rule.constraint.kind !== 'number_bound' || rule.subject_aliases.length > 0, {
    message: 'a rule on a number needs at least one word that names its subject',
    path: ['subject_aliases'],
  });

export const RuleSchema = z.discriminatedUnion('kind', [
  PathRuleSchema,
  CommandRuleSchema,
  ContentRuleSchema,
]);

export const MAX_RULES = 200;

export const RhsDocumentSchema = z.strictObject({
  rhs: z.literal(1),
  governance: GovernanceHeaderSchema,
  context: ContextSchema,
  /**
   * Technical components are out of this task's scope (EP-04). They are
   * accepted so that a real document still parses, and reported as a warning
   * so that nobody believes they were applied.
   */
  components: z.array(z.unknown()).optional(),
  rules: z.array(RuleSchema).max(MAX_RULES).optional(),
});

export type RhsDocument = z.infer<typeof RhsDocumentSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type RhsContext = z.infer<typeof ContextSchema>;

/** The four blocks, in the order SPEC-005 §5.1 renders them. */
export const BLOCK_KEYS = ['allowed', 'preferred', 'ask_first', 'forbidden'] as const;
export type BlockKey = (typeof BLOCK_KEYS)[number];
