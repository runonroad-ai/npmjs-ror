/**
 * The content-rule matcher (ADR-0117), shared by the device (`ror`) and the server, which runs a
 * rule's boundary tests with it when an author approves a fiche (ADR-0118).
 *
 * Its behaviour is pinned by MATCHER_VERSION: an approved fiche records the version its tests were
 * run with, so ANY change to what `check` answers bumps it, and a published fiche is never silently
 * reinterpreted.
 */
export { MATCHER_VERSION } from './version.js';
export {
  baselineTests,
  draftFiche,
  missingBaseline,
  withBaseline,
  failedTests,
  MAX_EXAMPLES,
  MAX_TESTS,
  runFicheTests,
  type Fiche,
  type FicheTest,
  type TestResult,
  type Verdict,
} from './fiche.js';

export {
  check,
  mentions,
  normalize,
  sentences,
  type ContentRule,
  type ContentScope,
  type Finding,
  type ForbiddenTerms,
  type Mention,
  type NumberBound,
} from './content.js';
