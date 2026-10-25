/** The Codex adapter: instruction file for the session, native artifacts derived from the signed policy (ADR-0086). */
import { renderGovernanceFile, type Contribution, type Locale } from '@runonroad/claude-code';

import { INSTRUCTIONS_PATH } from './policy.js';

export {
  GLOB_SCAN_MAX_DEPTH,
  hasInteriorDoubleStar,
  INSTRUCTIONS_PATH,
  prefixPatterns,
  PROFILE,
  profileEntries,
  mergeEntries,
  profileBlock,
  type ProfileEntry,
  type ProfileLevel,
  RULES_MARK,
  rulesFile,
  TARGET,
} from './policy.js';

/** What the server compiles for Codex: the project layer only (a bundle for a project never reaches the user's home). */
export type CodexOperation =
  | { readonly op: 'write_file'; readonly path: string; readonly content: string }
  | { readonly op: 'git_exclude'; readonly pattern: string };

export function codexOperations(
  contributions: readonly Contribution[],
  locale: Locale,
): CodexOperation[] {
  return [
    {
      op: 'write_file',
      path: INSTRUCTIONS_PATH,
      content: renderGovernanceFile(contributions, locale),
    },
    { op: 'git_exclude', pattern: '.runonroad/' },
  ];
}
