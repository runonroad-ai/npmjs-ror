/**
 * What a draft must satisfy before it is saved (SPEC-003 §3, « bloquantes à
 * l'enregistrement du brouillon »): the RHS rules, plus RHS-V05 on the text of
 * the document. A governance is read by every agent of the organization, so a
 * credential written in it is a leak that no later edit takes back.
 */
import { compareErrors, RHS_CODES, toJsonPointer, type RhsError } from './errors.js';
import { validate, type ParseResult } from './parse.js';

/** Shapes a credential has by construction: a vendor prefix, a PEM header, or a key assigned to its name. */
const CREDENTIALS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: 'an API key', pattern: /\bsk-[\w-]{20,}/u },
  { kind: 'a payment key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/u },
  { kind: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { kind: 'a Google API key', pattern: /\bAIza[\w-]{35}/u },
  { kind: 'a GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,})/u },
  { kind: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/u },
  { kind: 'a RunOnRoad token', pattern: /\bror[ad]_[A-Za-z0-9]{20,}/u },
  { kind: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  {
    kind: 'a credential assigned to its name',
    pattern: /\b(?:api[_-]?key|secret|token|passw(?:or)?d)\b\s*[:=]\s*["']?[\w/+.-]{16,}/iu,
  },
];

// shortcut: strings deeper than this are not scanned, so a hostile document cannot overflow the
// stack; the RHS keeps its text at depth 4 and its unbounded `components` are not compiled yet (EP-04).
const MAX_DEPTH = 8;

function findSecrets(value: unknown, path: readonly PropertyKey[] = []): RhsError[] {
  if (typeof value === 'string') {
    const found = CREDENTIALS.find(({ pattern }) => pattern.test(value));
    if (found === undefined) return [];
    return [
      {
        code: RHS_CODES.secret,
        pointer: toJsonPointer(path),
        // The place and the kind, never the value: the answer travels through logs and caches.
        message: `RHS-V05: this text holds ${found.kind}; remove it, a governance is readable by every agent`,
      },
    ];
  }
  if (typeof value !== 'object' || value === null || path.length >= MAX_DEPTH) return [];
  return Object.entries(value).flatMap(([key, child]) => findSecrets(child, [...path, key]));
}

/** PostgreSQL's jsonb refuses U+0000 in any string or key, at any depth: refuse it here as a 422. */
function findNul(raw: unknown): RhsError[] {
  const nuls: string[] = [];
  JSON.stringify(raw, (key: string, value: unknown) => {
    if (key.includes('\0') || (typeof value === 'string' && value.includes('\0'))) nuls.push(key);
    return value;
  });
  if (nuls.length === 0) return [];
  return [
    {
      code: RHS_CODES.schema,
      pointer: '',
      message: 'a text holds a NUL character (U+0000), which cannot be stored',
    },
  ];
}

/** `validate`, RHS-V05 on every string of the document and no NUL character, in the one answer. */
export function validateDraft(raw: unknown): ParseResult {
  const result = validate(raw);
  const refused = [...findSecrets(raw), ...findNul(raw)];
  if (refused.length === 0) return result;
  const errors = [...(result.ok ? [] : result.errors), ...refused];
  return { ok: false, errors: errors.sort(compareErrors) };
}
