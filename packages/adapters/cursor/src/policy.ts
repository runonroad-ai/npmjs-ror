/**
 * The Cursor adapter (ADR-0086), EXPERIMENTAL: contract-tested against Cursor's
 * documented formats, never run against the real product, and never counted as
 * `enforced` (Cursor's hooks have reported bugs: a deny on a file read that is
 * not applied, a malformed answer that lets the call through, user hooks not
 * firing on Windows). It carries the instructions and a best-effort barrier.
 */
import { enforcedRules, rootedGlob, type CompiledPolicy } from '@runonroad/claude-code';

export const TARGET = 'cursor';
export const INSTRUCTIONS_PATH = '${project}/.cursor/rules/ror-governance.mdc';

/** The events whose hook can refuse an action, as Cursor names them. */
export const GUARDED_EVENTS = [
  'beforeShellExecution',
  'beforeReadFile',
  'beforeMCPExecution',
  'preToolUse',
] as const;

/** An `.mdc` rule Cursor always loads. */
export const withFrontmatter = (markdown: string): string =>
  `---\ndescription: RunOnRoad governance\nalwaysApply: true\n---\n${markdown}`;

/** Cursor CLI's permission strings: `Shell(git push)`, `Read(path)`, `Write(path)`. */
export function cliDeny(policy: CompiledPolicy): string[] {
  const deny = new Set<string>();
  for (const rule of enforcedRules(policy)) {
    if (rule.kind === 'command') {
      deny.add(`Shell(${[rule.executable, ...rule.argv_prefix].join(' ')})`);
    } else if (rule.kind === 'path') {
      const glob = rootedGlob(rule.glob);
      if (rule.access !== 'write') deny.add(`Read(${glob})`);
      if (rule.access !== 'read') deny.add(`Write(${glob})`);
    }
  }
  return [...deny].sort();
}
