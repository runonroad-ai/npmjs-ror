/**
 * The semantics of `check` are pinned by this version: an approved fiche records the version its tests
 * were run with, so ANY change to what `check` answers bumps it, and a published fiche is never
 * silently reinterpreted (ADR-0118).
 */
export const MATCHER_VERSION = 'content-matcher/1';
