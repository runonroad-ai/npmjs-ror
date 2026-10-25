/**
 * Validation errors carry a STABLE code from the SPEC-003 §3 table and a JSON
 * pointer (RFC 6901). The code is what an editor branches on and what a
 * changelog can reference; the message is prose and may be reworded.
 */

export const RHS_CODES = {
  /** A structural problem the schema caught: wrong type, unknown key, missing field. */
  schema: 'RHS-SCHEMA',
  /** No secret in clear: a credential in a block is refused, never echoed. */
  secret: 'RHS-V05',
  /** A context needs a non-empty preamble and at least one non-empty block. */
  emptyContext: 'RHS-V11',
  /** Two rules of one document share an id. */
  duplicateRuleId: 'RHS-V20',
  /** A content rule lists the same phrase twice (after NFKC and case folding), or twice a scope. */
  duplicateInContentRule: 'RHS-V21',
  /** The input is not valid YAML or JSON at all. */
  syntax: 'RHS-SYNTAX',
} as const;

export type RhsCode = (typeof RHS_CODES)[keyof typeof RHS_CODES];

export interface RhsError {
  readonly code: RhsCode;
  /** RFC 6901 pointer into the document, `''` for the document itself. */
  readonly pointer: string;
  readonly message: string;
}

export interface RhsWarning {
  readonly pointer: string;
  readonly message: string;
}

/** RFC 6901: `~` becomes `~0` and `/` becomes `~1`, in that order. */
export function toJsonPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '';
  return `/${path
    .map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`;
}

export function compareErrors(a: RhsError, b: RhsError): number {
  return a.pointer.localeCompare(b.pointer, 'en') || a.code.localeCompare(b.code, 'en');
}
