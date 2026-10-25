/**
 * `ror status`: what is applied, what drifted, and, per capability, what is
 * enforced, advisory or absent. Unsupported coverage is never silent
 * (design review, 2026-10-17).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { clientEnvironment } from '@runonroad/config/client';

import { HarnessBundleSchema } from '@runonroad/api-contract/harness';

import { driftOf, readLock, type Lock } from './managed.js';
import { hooksTrusted, type CodexHook } from './codex.js';
import type { HookTarget } from './protocol.js';
import {
  coverageOf,
  detectCapabilities,
  type Capabilities,
  type RuleCoverage,
} from './coverage.js';
import type { PolicyRule } from './evaluate.js';
import { loadPolicy, loadTrust, readRules } from './hook.js';
import { hookInstalled, managedSettingsPath, MARK } from './install.js';
import { TARGET } from './sync.js';
import { defaultHome } from './paths.js';
import { loadCache, projectKey, readPinnedKeys, rorHome } from './state.js';
import { layerOf, lockFileOf } from './sync-plan.js';

export interface Coverage {
  readonly capability: string;
  readonly guarantee: 'enforced' | 'advisory' | 'none';
  readonly note: string;
}

/** The claude_code coverage matrix as this ror delivers it on this device. */
/**
 * Is the enforcement really installed and sound right now: the signed policy
 * verifies, the PreToolUse hook is registered, nothing drifted. A rule that
 * this device could enforce is not an enforced rule while any of this is broken.
 */
export function installedEnforcement(
  projectDir: string,
  drifted: readonly string[],
  now: Date = new Date(),
  target: HookTarget = 'claude_code',
  codexHooks?: readonly CodexHook[],
): { readonly active: boolean; readonly why: string } {
  const trust = loadTrust(projectDir, rorHome(), target);
  if (trust === undefined) return { active: false, why: 'this device is not enrolled' };
  const policy = loadPolicy(projectDir, trust, Math.max(now.getTime(), trust.lastSeenMs), target);
  if (!policy.ok) return { active: false, why: policy.why };
  if (target === 'cursor') {
    return {
      active: false,
      why: 'Cursor is experimental: its hooks are not reliable enough to count',
    };
  }
  if (target === 'codex') {
    if (codexHooks === undefined)
      return { active: false, why: 'Codex did not answer (is `codex` installed?)' };
    if (!hooksTrusted(codexHooks)) {
      return {
        active: false,
        why: 'Codex does not run the RunOnRoad hooks (not registered or not trusted): run `ror sync --target codex`',
      };
    }
    if (codexUserLocks(projectDir).some((lock) => lock === undefined)) {
      return {
        active: false,
        why: 'Codex rules and profile are not applied: run `ror sync --target codex`',
      };
    }
    if (codexUserDrift(projectDir).length + drifted.length > 0) {
      return { active: false, why: 'managed files drifted; run `ror sync`' };
    }
    return {
      active: true,
      why: 'policy verified, hooks trusted, rules and profile applied (installation check)',
    };
  }
  const local = readSettings(join(projectDir, '.claude', 'settings.local.json'));
  if (!hookRegistered(local)) {
    return { active: false, why: 'the PreToolUse hook is not registered as ror writes it' };
  }
  const switches = [
    ['the project’s local settings', local],
    ['the project’s settings', readSettings(join(projectDir, '.claude', 'settings.json'))],
    [
      'the user’s settings',
      readSettings(join(clientEnvironment().home ?? homedir(), '.claude', 'settings.json')),
    ],
    ['the machine’s managed settings', readSettings(managedSettingsPath())],
  ] as const;
  for (const [where, settings] of switches) {
    if (settings?.['disableAllHooks'] === true) {
      return { active: false, why: `hooks are disabled in ${where} (disableAllHooks)` };
    }
    if (settings?.['allowManagedHooksOnly'] === true) {
      return { active: false, why: `only managed hooks may run (${where})` };
    }
  }
  if (drifted.length > 0) return { active: false, why: 'managed files drifted; run `ror sync`' };
  // what no file shows: a command-line `--settings` of a session. This is an installation check.
  return { active: true, why: 'policy verified, hook registered (installation check)' };
}

type Settings = Record<string, unknown>;

function readSettings(path: string): Settings | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Settings)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The PreToolUse entry ror writes: every tool, our command, and a failure that blocks. */
function hookRegistered(settings: Settings | undefined): boolean {
  const hooks = settings?.['hooks'];
  const entries =
    typeof hooks === 'object' && hooks !== null ? (hooks as Settings)['PreToolUse'] : undefined;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry: unknown) => {
    const listed = (entry as { matcher?: unknown; hooks?: unknown } | null)?.hooks;
    const matcher = (entry as { matcher?: unknown } | null)?.matcher;
    return (
      (matcher === '*' || matcher === '' || matcher === undefined) &&
      Array.isArray(listed) &&
      listed.some((hook: unknown) => {
        const command = (hook as { command?: unknown } | null)?.command;
        return (
          typeof command === 'string' &&
          command.includes(MARK) &&
          (hook as { onFailure?: unknown }).onFailure === 'block'
        );
      })
    );
  });
}

export const coverage = (
  hook: boolean,
  rules: readonly RuleCoverage[],
  enforcement: { readonly active: boolean; readonly why: string } | undefined,
): readonly Coverage[] => [
  {
    capability: 'rules as instructions',
    guarantee: 'advisory',
    note: 'the model reads them; only the structured rules below block an action',
  },
  {
    capability: 'blocking a forbidden action',
    guarantee:
      rules.length === 0 || enforcement?.active !== true
        ? 'none'
        : rules.every((r) => r.status === 'enforced')
          ? 'enforced'
          : 'advisory',
    note:
      rules.length === 0
        ? 'no governance carries a structured rule'
        : enforcement?.active === true
          ? 'tier advisory-plus (unmanaged): these files are the user’s to edit; ror restores them at every sync. Not tamper resistant.'
          : `NOT ACTIVE: ${enforcement?.why ?? 'unknown'}`,
  },
  {
    capability: 'surfaces not covered',
    guarantee: 'none',
    note: 'MCP servers are denied unless allowed; an unknown tool is denied; WebFetch/WebSearch are not filtered; commands the user types themselves are out of scope',
  },
  {
    capability: 'update of a running session',
    guarantee: hook ? 'advisory' : 'none',
    note: hook
      ? 'the SessionStart hook injects changed rules; a session already open is not updated'
      : 'install the SessionStart hook with `ror install` (Codex and Cursor: `ror sync --target <tool>`)',
  },
  {
    capability: 'revocation',
    guarantee: 'none',
    note: 'unbounded for running sessions: no prompt-time admission check yet',
  },
];

export interface StatusReport {
  readonly enrolled: boolean;
  readonly organization: string | null;
  readonly hash: string | null;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly appliedAt: string | null;
  readonly drifted: readonly string[];
  readonly hook: boolean;
  readonly coverage: readonly Coverage[];
  /** Per structured rule: what this device really enforces. */
  readonly rules: readonly RuleCoverage[];
  /** Whether the enforcement is installed and sound now, apart from what the device could do. */
  readonly enforcement: { readonly active: boolean; readonly why: string } | null;
}

export function status(
  projectDir: string,
  capabilities?: Capabilities,
  target: HookTarget = TARGET,
  codexHooks?: readonly CodexHook[],
): StatusReport {
  const enrolment = readPinnedKeys(defaultHome());
  const lockPath = lockFileOf(projectDir, target);
  const lock = existsSync(lockPath) ? readLock(lockPath) : undefined;
  const cache = loadCache(projectDir, target);
  const bundle =
    cache === undefined ? undefined : HarnessBundleSchema.safeParse(JSON.parse(cache.body));
  const hook =
    target === 'codex'
      ? codexHooks !== undefined && hooksTrusted(codexHooks)
      : hookInstalled(false) || hookInstalled(true);
  const read = readRules(bundle?.success === true ? (bundle.data.policy?.rules ?? []) : []);
  const policyRules: PolicyRule[] = read.rules;
  const anyRule = policyRules.length + read.content.length > 0;
  const device = anyRule ? (capabilities ?? detectCapabilities(target)) : undefined;
  const rules = [
    ...(device === undefined ? [] : policyRules.map((rule) => coverageOf(rule, device, target))),
    // a content rule is checked by code where a value or a term is explicit, and by the conversation's
    // own AI for the rest: never "enforced", and said so (ADR-0088)
    ...read.content.map((rule): RuleCoverage => ({
      id: rule.id,
      required: rule.required,
      status: target === 'cursor' ? 'experimental' : 'partial',
      why: 'code blocks an explicit value or term in the prompt, the file about to be written and the answer; the conversation’s own AI decides the rest',
    })),
  ];
  const drifted = [
    ...(lock === undefined ? [] : driftOf(layerOf('project', lockPath, projectDir))),
    // Codex also writes in the user's home: a hand edit there is drift too
    ...(target === 'codex' ? codexUserDrift(projectDir) : []),
  ];
  const enforcement = !anyRule
    ? undefined
    : installedEnforcement(projectDir, drifted, new Date(), target, codexHooks);
  return {
    enrolled: enrolment !== undefined,
    organization: enrolment?.organization_id ?? null,
    hash: lock?.effective_hash ?? null,
    issuedAt: lock?.issued_at ?? null,
    expiresAt: bundle?.success === true ? bundle.data.expires_at : null,
    appliedAt: lock?.applied_at ?? null,
    drifted,
    hook,
    coverage: coverage(hook, rules, enforcement),
    rules,
    enforcement: enforcement ?? null,
  };
}

/** The two user-layer locks Codex writes: this project's rules and the device's profile. */
const codexUserLocks = (projectDir: string) =>
  [`${projectKey(projectDir)}.codex.json`, '_device.codex.json'].map((name) =>
    userLock(join(rorHome(), 'user', name)),
  );

const codexUserDrift = (projectDir: string): string[] =>
  codexUserLocks(projectDir).flatMap((lock) => (lock === undefined ? [] : driftOf(lock.layer)));

/** A lock of the user layer that exists, with the managed layer that reads it. */
function userLock(lockPath: string): { lock: Lock; layer: ReturnType<typeof layerOf> } | undefined {
  if (!existsSync(lockPath)) return undefined;
  return { lock: readLock(lockPath), layer: layerOf('user', lockPath, undefined) };
}
