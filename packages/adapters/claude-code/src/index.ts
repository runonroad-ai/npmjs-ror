/** The Claude Code adapter: project layer, instruction file only (ADR-0006). */
export {
  collectRules,
  compilePolicy,
  enforcedRules,
  rootedGlob,
  settingsOperations,
  SETTINGS_PATH,
  type CompiledDerogation,
  type CompiledPolicy,
  type ContentRule,
  type CompiledRule,
} from './policy.js';
export {
  GIT_EXCLUDE_PATTERNS,
  GOVERNANCE_FILE_PATH,
  HarnessTooLargeError,
  MAX_FILE_BYTES,
  PROJECT_ROOT,
  renderGovernanceFile,
  type Contribution,
  type Layer,
  type Locale,
} from './render.js';
