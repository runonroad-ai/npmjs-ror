/**
 * The Codex adapter (ADR-0086): what the signed policy becomes in Codex's own
 * configuration, so that Codex refuses the same things `ror hook` does even with
 * the hook off (the hook is a guardrail there: it fails open, ADR-0086).
 *
 *  - command rules → `prefix_rule(..., decision="forbidden")` in a rules file;
 *  - path rules → entries of a permission profile (`none` / `read`), enforced by
 *    Codex's sandbox on every OS, apply_patch included.
 *
 * Pure and deterministic. Path roots stay tokens (`${project}`, `${home}`): the
 * client resolves them and escapes them for TOML.
 */
import {
  enforcedRules,
  rootedGlob,
  type CompiledPolicy,
  type CompiledRule,
} from '@runonroad/claude-code';

export const TARGET = 'codex';
export const PROFILE = 'ror';
export const RULES_MARK = '# Managed by RunOnRoad';

/** Linux expands a glob to a fixed depth (`**` is unbounded elsewhere); deeper files are not covered natively. */
export const GLOB_SCAN_MAX_DEPTH = 8;

/** The text Codex reads; a path rule with an interior `**` is only partly native on Linux. */
export const INSTRUCTIONS_PATH = '${project}/.runonroad/instructions/ror-governance.md';

const text = (value: string): string =>
  // eslint-disable-next-line no-control-regex -- control characters never reach a rules file
  JSON.stringify(value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 200));

type CommandRule = Extract<CompiledRule, { kind: 'command' }>;

/** `git push --force` is `["git","push","--force"]`; a rule with several flags is one pattern each. */
export function prefixPatterns(rule: CommandRule): string[][] {
  const head = [rule.executable, ...rule.argv_prefix];
  if (rule.flags_any.length === 0) return [head];
  return rule.flags_any.map((flag) => [...head, flag]);
}

/** The rules file of one project. `ask` is `forbidden` until a derogation lifts it (it is then absent). */
export function rulesFile(policy: CompiledPolicy): string {
  const lines = [RULES_MARK, '# Do not edit: `ror sync` rewrites this file.'];
  const seen = new Set<string>();
  for (const rule of enforcedRules(policy)) {
    if (rule.kind !== 'command') continue;
    for (const pattern of prefixPatterns(rule)) {
      const key = JSON.stringify(pattern);
      if (seen.has(key)) continue;
      seen.add(key);
      const reason = `Blocked by RunOnRoad rule ${rule.id}: ${rule.reason}`;
      lines.push(
        `prefix_rule(pattern=[${pattern.map((word) => JSON.stringify(word)).join(', ')}], decision="forbidden", justification=${text(reason)})`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** `dir/**` is the directory and everything below it; Codex's entry for a path already is. */
const entryPath = (glob: string): string => rootedGlob(glob).replace(/\/\*\*$/u, '');

/** True when the glob has a `**` Codex cannot expand beyond GLOB_SCAN_MAX_DEPTH on Linux. */
export const hasInteriorDoubleStar = (glob: string): boolean =>
  glob.replace(/\/\*\*$/u, '').includes('**');

/** A write-only rule leaves the path readable (`read`); anything that forbids reading denies it (`none`). */
export function profileEntries(policy: CompiledPolicy): [string, 'none' | 'read'][] {
  const levels = new Map<string, 'none' | 'read'>();
  for (const rule of enforcedRules(policy)) {
    if (rule.kind !== 'path') continue;
    const path = entryPath(rule.glob);
    const level = rule.access === 'write' ? 'read' : 'none';
    // the stricter level wins when two rules name the same path
    if (levels.get(path) !== 'none') levels.set(path, level);
  }
  return [...levels.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'));
}

const tomlKey = (path: string): string =>
  `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export type ProfileLevel = 'none' | 'read';
export type ProfileEntry = readonly [path: string, level: ProfileLevel];

/** The stricter level wins when two sources name one path: `none` over `read`. */
export function mergeEntries(...lists: readonly (readonly ProfileEntry[])[]): ProfileEntry[] {
  const levels = new Map<string, ProfileLevel>();
  for (const [path, level] of lists.flat()) {
    if (levels.get(path) !== 'none') levels.set(path, level);
  }
  return [...levels.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'));
}

/**
 * The whole profile of a device, one block, written once from the union of every
 * project's entries (a key defined twice would make the file invalid TOML) and what
 * must stay out of the agent's hands. The profile extends Codex's own workspace
 * profile, so ordinary work is unchanged, and caps Linux glob expansion.
 */
export function profileBlock(entries: readonly ProfileEntry[]): string[] {
  return [
    `default_permissions = "${PROFILE}"`,
    `permissions.${PROFILE}.extends = ":workspace"`,
    `permissions.${PROFILE}.filesystem.glob_scan_max_depth = ${String(GLOB_SCAN_MAX_DEPTH)}`,
    ...mergeEntries(entries).map(
      ([path, level]) => `permissions.${PROFILE}.filesystem.${tomlKey(path)} = "${level}"`,
    ),
  ];
}
