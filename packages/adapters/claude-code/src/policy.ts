/**
 * The enforceable rules of every governance that reaches a principal, compiled
 * for Claude Code (ADR-0085): the policy `ror hook` evaluates, and the native
 * settings that make Claude Code refuse the same things itself (permission
 * rules and the OS sandbox of its Bash tool).
 *
 * Pure and deterministic. Path roots stay as tokens (`${project}`, `${home}`):
 * the server does not know where a project lives on a device.
 */
import type { Rule } from '@runonroad/harness-spec';

import type { Contribution } from './render.js';

export const SETTINGS_PATH = '${project}/.claude/settings.local.json';
export const POLICY_OWNER = '_runonroad';

export type CompiledRule = Rule & { readonly id: string; readonly source: string };

/** A rule about what is said or written (ADR-0088): not enforceable natively, judged by the client's hook. */
export type ContentRule = Extract<CompiledRule, { kind: 'content' }>;

/** An Ask-first rule lifted for this principal until `expires_at` (ADR-0087). */
export interface CompiledDerogation {
  readonly rule_id: string;
  readonly expires_at: string;
}

export interface CompiledPolicy {
  readonly schema_version: 1;
  readonly principal: string | null;
  readonly rules: readonly CompiledRule[];
  readonly mcp_allow: readonly string[];
  /** Active when the bundle was resolved; absent or empty when nothing is lifted. */
  readonly derogations?: readonly CompiledDerogation[];
}

/**
 * The rules a native barrier must carry: every rule except the Ask-first ones a
 * derogation lifts right now. The signed policy keeps the lifted rules too, so
 * `ror hook` can enforce the expiry by its own clock. A `forbid` is never lifted.
 */
export function enforcedRules(policy: CompiledPolicy): CompiledRule[] {
  const lifted = new Set((policy.derogations ?? []).map((derogation) => derogation.rule_id));
  return policy.rules.filter((rule) => !(rule.decision === 'ask' && lifted.has(rule.id)));
}

export interface SettingsOperation {
  readonly op: 'merge_json';
  readonly path: string;
  readonly pointer: string;
  readonly value: unknown;
  readonly strategy: 'set' | 'append_unique';
  readonly owner: string;
}

/**
 * Every rule of every contributing version: like Forbidden and Ask-first, a
 * rule of a broader layer is never dropped by a narrower one (ADR-0084). Ids are
 * `governance@version:rule`, so two versions of one governance never collide.
 */
export function collectRules(contributions: readonly Contribution[]): CompiledRule[] {
  return contributions
    .flatMap((contribution) => {
      const { slug } = contribution.document.governance;
      const source = `${slug}@${contribution.version}`;
      return (contribution.document.rules ?? []).map((rule): CompiledRule => ({
        ...rule,
        id: `${source}:${rule.id}`,
        source,
      }));
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

export function compilePolicy(
  contributions: readonly Contribution[],
  principal: string | null,
): CompiledPolicy | undefined {
  const rules = collectRules(contributions);
  if (rules.length === 0) return undefined;
  return { schema_version: 1, principal, rules, mcp_allow: [] };
}

/** `secrets/**` → `${project}/secrets/**`; `~/.ssh/**` → `${home}/.ssh/**`; `/etc/x` stays. */
export function rootedGlob(glob: string): string {
  if (glob.startsWith('~/')) return `\${home}/${glob.slice(2)}`;
  if (glob.startsWith('/')) return glob;
  return `\${project}/${glob.replace(/^\.\//u, '')}`;
}

/** Claude Code's absolute-path form: a leading `//`. */
const claudePath = (glob: string): string => `/${rootedGlob(glob)}`;

const merge = (
  pointer: string,
  value: unknown,
  strategy: SettingsOperation['strategy'],
): SettingsOperation => ({
  op: 'merge_json',
  path: SETTINGS_PATH,
  pointer,
  value,
  strategy,
  owner: POLICY_OWNER,
});

/**
 * The native settings for a policy. A path rule becomes Read/Edit deny rules
 * (the built-in file tools and the file commands Claude Code recognises in
 * Bash) and, for what runs inside Bash, a filesystem deny of the OS sandbox,
 * whose unsandboxed fallback is switched off. An `ask` rule is a deny too: an
 * organization's Ask-first needs a derogation, which does not exist yet.
 */
export function settingsOperations(policy: CompiledPolicy): SettingsOperation[] {
  const paths = enforcedRules(policy).filter((rule) => rule.kind === 'path');
  const deny: string[] = [];
  const denyRead: string[] = [];
  const denyWrite: string[] = [];
  for (const rule of paths) {
    const read = rule.access === 'read' || rule.access === 'any';
    const write = rule.access === 'write' || rule.access === 'any';
    if (read) {
      deny.push(`Read(${claudePath(rule.glob)})`);
      denyRead.push(rootedGlob(rule.glob));
    }
    if (write) {
      deny.push(`Edit(${claudePath(rule.glob)})`);
      denyWrite.push(rootedGlob(rule.glob));
    }
  }
  const required = paths.some((rule) => rule.required);
  return [
    merge('/permissions/disableBypassPermissionsMode', 'disable', 'set'),
    merge('/sandbox/enabled', true, 'set'),
    merge('/sandbox/allowUnsandboxedCommands', false, 'set'),
    ...(required ? [merge('/sandbox/failIfUnavailable', true, 'set')] : []),
    ...(deny.length > 0
      ? [merge('/permissions/deny', [...new Set(deny)].sort(), 'append_unique')]
      : []),
    ...(denyRead.length > 0
      ? [merge('/sandbox/filesystem/denyRead', [...new Set(denyRead)].sort(), 'append_unique')]
      : []),
    ...(denyWrite.length > 0
      ? [merge('/sandbox/filesystem/denyWrite', [...new Set(denyWrite)].sort(), 'append_unique')]
      : []),
  ];
}
