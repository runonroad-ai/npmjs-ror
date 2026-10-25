/**
 * Parsing and validation. Pure: no file access, no network, no clock.
 *
 * The result is a discriminated union rather than an exception, because a
 * caller almost always wants to show every problem at once — an editor that
 * reports one error per save is an editor nobody finishes a document in.
 */
import { parse as parseYaml } from 'yaml';

import {
  compareErrors,
  RHS_CODES,
  toJsonPointer,
  type RhsError,
  type RhsWarning,
} from './errors.js';
import { BLOCK_KEYS, RhsDocumentSchema, type RhsDocument, type Rule } from './schema.js';

export type ParseResult =
  | { readonly ok: true; readonly value: RhsDocument; readonly warnings: readonly RhsWarning[] }
  | { readonly ok: false; readonly errors: readonly RhsError[] };

const isWritten = (text: string): boolean => text.trim() !== '';

const fold = (phrase: string): string => phrase.normalize('NFKC').toLowerCase().trim();

/** RHS-V21: a phrase or scope listed twice in a content rule says nothing more and hides a typo. */
function contentListErrors(rule: Rule, index: number): RhsError[] {
  if (rule.kind !== 'content') return [];
  const lists: [string, readonly string[]][] = [
    ['subject_aliases', rule.subject_aliases],
    ['scopes', rule.scopes],
    ...(rule.constraint.kind === 'forbidden_terms'
      ? ([
          ['constraint/terms', rule.constraint.terms],
          ['constraint/context_exceptions', rule.constraint.context_exceptions],
        ] as [string, readonly string[]][])
      : []),
  ];
  return lists.flatMap(([name, items]) => {
    const seen = new Set<string>();
    return items.flatMap((item, at) => {
      const key = fold(item);
      if (key === '') {
        return [
          {
            code: RHS_CODES.duplicateInContentRule,
            pointer: `/rules/${String(index)}/${name}/${String(at)}`,
            message: 'an empty phrase',
          },
        ];
      }
      if (!seen.has(key)) {
        seen.add(key);
        return [];
      }
      return [
        {
          code: RHS_CODES.duplicateInContentRule,
          pointer: `/rules/${String(index)}/${name}/${String(at)}`,
          message: `"${item}" is listed twice`,
        },
      ];
    });
  });
}

/** Rules that a per-field schema cannot express (SPEC-003 §3). */
function crossFieldErrors(document: RhsDocument): RhsError[] {
  const seen = new Set<string>();
  const duplicates: RhsError[] = (document.rules ?? []).flatMap((rule, index) => {
    if (!seen.has(rule.id)) {
      seen.add(rule.id);
      return [];
    }
    return [
      {
        code: RHS_CODES.duplicateRuleId,
        pointer: `/rules/${String(index)}/id`,
        message: `the rule id "${rule.id}" is used twice in this document`,
      },
    ];
  });
  const lists = (document.rules ?? []).flatMap(contentListErrors);
  duplicates.push(...lists);
  // RHS-V11: a context with nothing in it is a published document that tells
  // an agent nothing — accepted here it would ship as an empty rule file.
  // Any one of the five fields is enough, the preamble included (ADR-0082).
  const { context } = document;
  if ([context.preamble, ...BLOCK_KEYS.map((block) => context[block])].some(isWritten)) {
    return duplicates;
  }
  return [
    ...duplicates,
    {
      code: RHS_CODES.emptyContext,
      pointer: '/context',
      message:
        'a context needs at least one non-empty field among the preamble and the four blocks',
    },
  ];
}

function warningsFor(document: RhsDocument): RhsWarning[] {
  if (document.components === undefined || document.components.length === 0) return [];
  return [
    {
      pointer: '/components',
      message:
        `${String(document.components.length)} technical component(s) accepted but not compiled: ` +
        'this milestone renders the preamble and the four blocks only (EP-04).',
    },
  ];
}

/** Accepts YAML or JSON — YAML is a superset, so one parser covers both. */
export function parse(source: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: RHS_CODES.syntax,
          pointer: '',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  return validate(raw);
}

/** The rules of SPEC-003 §3 on a document already parsed: what an API receives as JSON. */
export function validate(raw: unknown): ParseResult {
  const parsed = RhsDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.flatMap((issue) => {
      const code = RHS_CODES.schema;
      // Zod reports an unknown key against the PARENT object and names the key
      // in the message. A pointer that does not point is no use to an editor
      // trying to underline the offending line, so it is expanded here.
      if (issue.code === 'unrecognized_keys') {
        return issue.keys.map((key) => ({
          code,
          pointer: toJsonPointer([...issue.path, key]),
          message: `unrecognized key "${key}": the subset rejects what it cannot compile`,
        }));
      }
      return [
        {
          code,
          pointer: toJsonPointer(issue.path),
          message: issue.message,
        },
      ];
    });
    return { ok: false, errors: [...errors].sort(compareErrors) };
  }

  const errors = crossFieldErrors(parsed.data);
  if (errors.length > 0) return { ok: false, errors: [...errors].sort(compareErrors) };

  return { ok: true, value: parsed.data, warnings: warningsFor(parsed.data) };
}
