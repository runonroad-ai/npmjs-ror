/**
 * What this device can really enforce, rule by rule (ADR-0083, ADR-0085). A
 * rule is `enforced` only when every boundary it needs exists here; a rule the
 * author marked `required` that is not enforced refuses the whole policy,
 * instead of silently delivering less than was asked.
 */
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

import { hasInteriorDoubleStar } from '@runonroad/codex';

import type { PolicyRule } from './evaluate.js';
import type { HookTarget } from './protocol.js';

/** The releases the attack suites were run against. Others are `uncertified`. */
export const CERTIFIED_CLAUDE_CODE: readonly string[] = ['2.1.301'];
export const CERTIFIED_CODEX: readonly string[] = ['0.162.1'];

export interface Capabilities {
  /** The OS confines what the agent's shell commands do (Linux: bubblewrap, plus socat for Claude Code; macOS: Seatbelt). */
  readonly sandbox: boolean;
  readonly claudeVersion: string | undefined;
  readonly codexVersion?: string | undefined;
  /** `process.platform`, injectable so every OS's rules are tested on any machine. */
  readonly platform?: NodeJS.Platform | undefined;
}

export type RuleStatus = 'enforced' | 'partial' | 'uncertified' | 'experimental';

export interface RuleCoverage {
  readonly id: string;
  readonly required: boolean;
  readonly status: RuleStatus;
  readonly why: string;
}

function succeeds(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, [...args], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const versionOf = (command: string): string | undefined => {
  try {
    const out = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      shell: platform() === 'win32',
    });
    return /\d+\.\d+\.\d+/u.exec(out)?.[0];
  } catch {
    return undefined;
  }
};

export function detectCapabilities(target: HookTarget = 'claude_code'): Capabilities {
  const os = platform();
  const bubblewrap = os === 'linux' && succeeds('bwrap', ['--ro-bind', '/', '/', 'true']);
  // Claude Code's sandbox needs socat on Linux; on macOS it is built in; native Windows has none
  const sandbox =
    target === 'claude_code'
      ? (bubblewrap && succeeds('socat', ['-V'])) || os === 'darwin'
      : bubblewrap || os === 'darwin';
  return {
    sandbox,
    claudeVersion: target === 'claude_code' ? versionOf('claude') : undefined,
    codexVersion: target === 'codex' ? versionOf('codex') : undefined,
    platform: os,
  };
}

export function coverageOf(
  rule: PolicyRule,
  capabilities: Capabilities,
  target: HookTarget = 'claude_code',
): RuleCoverage {
  const base = { id: rule.id, required: rule.required };
  if (target === 'cursor') {
    return {
      ...base,
      status: 'experimental',
      why: 'Cursor’s hooks are not reliable enough to count as enforcement (denials not applied, failures let the call through)',
    };
  }
  const certified = target === 'codex' ? CERTIFIED_CODEX : CERTIFIED_CLAUDE_CODE;
  const found = target === 'codex' ? capabilities.codexVersion : capabilities.claudeVersion;
  const name = target === 'codex' ? 'Codex' : 'Claude Code';
  if (found === undefined || !certified.includes(found)) {
    return {
      ...base,
      status: 'uncertified',
      why: `${name} ${found ?? 'not installed'} was not tested`,
    };
  }
  if (rule.kind === 'command') {
    return {
      ...base,
      status: 'partial',
      why: 'the tool call is checked; what a program does by itself is not',
    };
  }
  if (!capabilities.sandbox) {
    return {
      ...base,
      status: 'partial',
      why:
        target === 'codex'
          ? 'the OS sandbox of Codex is not available here (Linux needs bubblewrap)'
          : 'the OS sandbox (bubblewrap, socat) is not available',
    };
  }
  if (
    target === 'codex' &&
    hasInteriorDoubleStar(rule.glob) &&
    (capabilities.platform ?? platform()) !== 'darwin'
  ) {
    return {
      ...base,
      status: 'partial',
      why: 'Codex expands `**` to a limited depth outside macOS: deeper files are only covered by the hook',
    };
  }
  return {
    ...base,
    status: 'enforced',
    why:
      target === 'codex'
        ? 'permission profile of Codex (sandbox: shell, patches, subprocesses), hook as a second guard'
        : 'permission rules, hook and OS sandbox',
  };
}

/** The rules that stop a policy from being activated. */
export function blockers(
  rules: readonly PolicyRule[],
  capabilities: Capabilities,
  target: HookTarget = 'claude_code',
): RuleCoverage[] {
  return rules
    .map((rule) => coverageOf(rule, capabilities, target))
    .filter((coverage) => coverage.required && coverage.status !== 'enforced');
}
