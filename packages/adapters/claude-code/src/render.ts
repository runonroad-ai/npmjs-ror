/**
 * Renders every governance that reaches a principal into the one instruction
 * file Claude Code always loads, restrictions first (ADR-0084).
 *
 * Pure and deterministic: same document in, same bytes out. Line endings are
 * forced to \n and the output is UTF-8, otherwise the golden tests disagree
 * between a Mac and a Windows runner for reasons that have nothing to do with
 * the governance.
 */
import type { RhsDocument } from '@runonroad/harness-spec';

export type Locale = 'fr' | 'en';

/**
 * SPEC-003 §3.1 fixes the meaning of each block; SPEC-005 §5.1 fixes the
 * order. Titles follow the organization's language, the "How to read this"
 * line stays English because its reader is the model, not a person.
 */
const BLOCK_TITLES: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  fr: {
    context: '📋 Contexte',
    allowed: '✅ Autorisé',
    preferred: '👍 Préféré',
    ask_first: '✋ Sous dérogation',
    forbidden: '⛔ Interdit',
  },
  en: {
    context: '📋 Context',
    allowed: '✅ Allowed',
    preferred: '👍 Preferred',
    ask_first: '✋ Ask first',
    forbidden: '⛔ Forbidden',
  },
};

const HOW_TO_READ =
  '> How to read this: sections are ordered by strength. Restrictions come first. ' +
  'When instructions conflict, follow the stricter one and ask. ' +
  'FORBIDDEN = never, explain and offer the alternative · ' +
  'ASK FIRST = stop and tell the user who approves · ' +
  'PREFERRED = default way · ALLOWED = do it freely.';

const MANAGED_COMMENT = '<!-- Managed by RunOnRoad — do not edit -->';

/** `${project}` is resolved by the CLI, never here (SPEC-006 §2). */
export const PROJECT_ROOT = '${project}';

/** One file for the whole harness: precedence is read top to bottom. */
export const GOVERNANCE_FILE_PATH = `${PROJECT_ROOT}/.claude/rules/ror-governance.md`;

/** The patterns Claude Code's managed output must never reach a commit through. */
export const GIT_EXCLUDE_PATTERNS = ['.claude/rules/ror-*', '.runonroad/lock/'] as const;

export type Layer = 'org' | 'team' | 'project';
const LAYER_RANK: Readonly<Record<Layer, number>> = { org: 1, team: 2, project: 3 };

/** The cap of the rendered file: a restriction is never truncated, the compile fails (ADR-0084). */
export const MAX_FILE_BYTES = 256 * 1024;

export class HarnessTooLargeError extends Error {
  override readonly name = 'HarnessTooLargeError';
}

/**
 * One published version that reaches the principal. `assignments` lists every
 * assignment that brings this very version (the first, by layer then id, places
 * it); `winner` is true when it is the version its governance resolves to:
 * only a winner gives its Preferred, Allowed and preamble, while every
 * contributing version gives its Forbidden and Ask-first (a narrower layer
 * never erases a broader layer's restriction).
 */
export interface Contribution {
  readonly document: RhsDocument;
  readonly version: string;
  readonly assignments: readonly { readonly id: string; readonly layer: Layer }[];
  readonly winner: boolean;
}

/** A browser textarea submits \r\n; the file keeps \n only, whoever wrote the text. */
function blockText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').trim();
}

const placement = (contribution: Contribution): Layer =>
  contribution.assignments[0]?.layer ?? 'org';

/** Layer (broad first), then governance slug, then the first assignment id: a total order. */
function ordered(contributions: readonly Contribution[]): Contribution[] {
  return [...contributions].sort(
    (a, b) =>
      LAYER_RANK[placement(a)] - LAYER_RANK[placement(b)] ||
      a.document.governance.slug.localeCompare(b.document.governance.slug, 'en') ||
      (a.assignments[0]?.id ?? '').localeCompare(b.assignments[0]?.id ?? '', 'en') ||
      a.version.localeCompare(b.version, 'en'),
  );
}

type Section = 'forbidden' | 'ask_first' | 'preferred' | 'allowed' | 'context';

/** Strongest first. */
const SECTIONS: readonly Section[] = ['forbidden', 'ask_first', 'preferred', 'allowed', 'context'];
const RESTRICTIONS: ReadonlySet<Section> = new Set(['forbidden', 'ask_first']);

export function renderGovernanceFile(
  contributions: readonly Contribution[],
  locale: Locale,
): string {
  const titles = BLOCK_TITLES[locale];
  const lines: string[] = ['# RunOnRoad governance', MANAGED_COMMENT, HOW_TO_READ];

  for (const section of SECTIONS) {
    const parts: string[] = [];
    for (const contribution of ordered(contributions)) {
      if (!RESTRICTIONS.has(section) && !contribution.winner) continue;
      const { context, governance } = contribution.document;
      const text = blockText(section === 'context' ? context.preamble : context[section]);
      if (text === '') continue;
      const source = `${governance.slug}@${contribution.version}`;
      parts.push(`### ${source} · ${placement(contribution)}`, text, `<!-- /${source} -->`);
    }
    // An empty section is omitted: a heading with nothing under it reads to the
    // model as "there are no rules here", which is not the same as "not used".
    if (parts.length > 0) lines.push('', `## ${titles[section] ?? section}`, ...parts);
  }

  const rendered = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(rendered, 'utf8') > MAX_FILE_BYTES) {
    throw new HarnessTooLargeError(
      `the rendered governance is larger than ${String(MAX_FILE_BYTES)} bytes`,
    );
  }
  return rendered;
}
