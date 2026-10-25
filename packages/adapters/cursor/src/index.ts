/** The Cursor adapter: instruction file for the project, hooks and CLI permissions derived by the client (experimental). */
import { renderGovernanceFile, type Contribution, type Locale } from '@runonroad/claude-code';

import { INSTRUCTIONS_PATH, withFrontmatter } from './policy.js';

export { cliDeny, GUARDED_EVENTS, INSTRUCTIONS_PATH, TARGET, withFrontmatter } from './policy.js';

export type CursorOperation =
  | { readonly op: 'write_file'; readonly path: string; readonly content: string }
  | { readonly op: 'git_exclude'; readonly pattern: string };

export function cursorOperations(
  contributions: readonly Contribution[],
  locale: Locale,
): CursorOperation[] {
  return [
    {
      op: 'write_file',
      path: INSTRUCTIONS_PATH,
      content: withFrontmatter(renderGovernanceFile(contributions, locale)),
    },
    { op: 'git_exclude', pattern: '.cursor/rules/ror-*' },
    { op: 'git_exclude', pattern: '.runonroad/' },
  ];
}
