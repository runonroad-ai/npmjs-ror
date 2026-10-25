/**
 * `ror sync`, `ror status`, `ror install` and `ror uninstall` (SPEC-007): the verbs around the
 * bundle of a project. The work is in `sync.ts`, `status.ts` and `install.ts`; these are the verbs.
 * Exit codes of `sync`: 0 · 11 login needed · 30 partial · 31 failure · 32 signature.
 */
import { existsSync } from 'node:fs';

import { listHooks } from './codex.js';
import { flagValue } from './flags.js';
import { hookInstalled, installHook, installTimer, removeHook, removeTimer } from './install.js';
import { syncLibrary } from './library.js';
import type { LoginContext } from './login.js';
import { RefusedOperationError } from './managed.js';
import type { HookTarget } from './protocol.js';
import { loadEnrolment } from './session.js';
import { BusyError, loadState, withMachineLock, withMachineLockAsync } from './state.js';
import { status } from './status.js';
import {
  anythingGoverned,
  projectRootOf,
  removeTarget,
  sync,
  TARGET,
  type SyncOutcome,
} from './sync.js';
import { lockFileOf } from './sync-plan.js';

const TARGET_LIST: readonly HookTarget[] = ['claude_code', 'codex', 'cursor'];

/** `--target codex`; Claude Code when absent. `undefined` for a name ror does not know. */
function targetOf(args: readonly string[]): HookTarget | undefined {
  const given = flagValue(args, '--target');
  if (given === undefined) return TARGET;
  return TARGET_LIST.find((target) => target === given);
}

const UNKNOWN_TARGET = 'unknown --target: claude_code, codex or cursor';

export async function syncVerb(args: readonly string[], context: LoginContext): Promise<number> {
  const enrolment = loadEnrolment(context);
  if (enrolment === undefined) {
    context.err('ROR-E401: not logged in; run `ror login --server <url>`');
    return 11;
  }
  const target = targetOf(args);
  if (target === undefined) {
    context.err(UNKNOWN_TARGET);
    return 31;
  }
  const fetchImpl = context.fetch ?? fetch;
  const directories = args.includes('--all')
    ? loadState().projects.filter((directory) => existsSync(directory))
    : [projectRootOf(flagValue(args, '--project-dir') ?? process.cwd())];
  let worst = 0;
  const changed: string[] = [];
  for (const projectDir of directories) {
    // --all refreshes every tool this project was synced for
    const targets = args.includes('--all')
      ? TARGET_LIST.filter((each) => existsSync(lockFileOf(projectDir, each)))
      : [target];
    for (const each of targets) {
      const outcome: SyncOutcome = await sync(
        { fetch: fetchImpl, now: () => new Date(), projectDir, target: each },
        enrolment,
      );
      (outcome.code === 0 ? context.out : context.err)(
        `${projectDir} (${each}): ${outcome.message}`,
      );
      worst = Math.max(worst, outcome.code);
      if (each === 'codex' && outcome.instructions !== undefined && outcome.instructions !== '') {
        changed.push(outcome.instructions);
      } else changed.push(...outcome.changedContent);
    }
  }
  // the person's skill library (ADR-0096) follows the sync, unless a project-less run asked for rules only
  if (!args.includes('--no-library')) {
    const library = await withMachineLockAsync(() =>
      syncLibrary({ fetch: fetchImpl, now: () => new Date() }, enrolment),
    );
    for (const line of library.lines) (library.code === 0 ? context.out : context.err)(line);
    worst = Math.max(worst, library.code);
  }
  if (args.includes('--from-hook')) {
    // a hook never blocks the session; changed rules are injected into it now
    if (changed.length > 0) {
      context.out(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: `RunOnRoad updated the governance for this project:\n\n${changed.join('\n\n')}`,
          },
        }),
      );
    }
    return 0;
  }
  return worst;
}

export async function statusVerb(args: readonly string[], context: LoginContext): Promise<number> {
  const target = targetOf(args);
  if (target === undefined) {
    context.err(UNKNOWN_TARGET);
    return 31;
  }
  const projectDir = projectRootOf(flagValue(args, '--project-dir') ?? process.cwd());
  const codexHooks = target === 'codex' ? await listHooks(projectDir) : undefined;
  const report = status(projectDir, undefined, target, codexHooks);
  const { out } = context;
  if (args.includes('--json')) out(JSON.stringify(report, null, 2));
  else {
    out(`enrolled: ${report.enrolled ? `yes (${report.organization ?? ''})` : 'no'}`);
    out(
      `applied: ${report.hash ?? 'nothing'}${report.appliedAt === null ? '' : ` at ${report.appliedAt}`}`,
    );
    out(`bundle expires: ${report.expiresAt ?? 'never'}`);
    out(`session hook: ${report.hook ? 'installed' : 'not installed'}`);
    out(report.drifted.length > 0 ? `drift: ${report.drifted.join(', ')}` : 'drift: none');
    if (report.enforcement !== null) {
      out(
        `enforcement: ${report.enforcement.active ? 'ACTIVE' : 'NOT ACTIVE'} (${report.enforcement.why})`,
      );
    }
    if (report.rules.length > 0) {
      out('structured rules on this device:');
      for (const rule of report.rules) {
        out(
          `  ${rule.status.padEnd(11)} ${rule.id}${rule.required ? ' (required)' : ''}: ${rule.why}`,
        );
      }
    }
    out(`coverage (${target}):`);
    for (const row of report.coverage)
      out(`  ${row.guarantee.padEnd(8)} ${row.capability}: ${row.note}`);
  }
  return report.drifted.length > 0 ? 40 : 0;
}

export function installVerb(args: readonly string[], context: LoginContext): number {
  try {
    context.out(`hook written to ${installHook(args.includes('--managed'))}`);
  } catch (error) {
    context.err(
      `could not write the settings: ${(error as Error).message} (managed settings need sudo)`,
    );
    return 31;
  }
  if (args.includes('--timer')) {
    try {
      context.out(installTimer());
    } catch (error) {
      if (!(error instanceof RefusedOperationError)) throw error;
      context.err(`could not write the timer: ${error.message}`);
      return 31;
    }
  }
  return 0;
}

export function uninstallVerb(args: readonly string[], context: LoginContext): number {
  const projectDir = projectRootOf(flagValue(args, '--project-dir') ?? process.cwd());
  const given = args.includes('--target') ? targetOf(args) : undefined;
  if (args.includes('--target') && given === undefined) {
    context.err(UNKNOWN_TARGET);
    return 31;
  }
  // with the machine lock held throughout: a sync must not rebuild the profile or the registry
  // while they are taken apart, and the "is anything still governed" answer must stay true
  try {
    withMachineLock(() => {
      for (const each of given === undefined ? TARGET_LIST : [given]) {
        const result = removeTarget(projectDir, each);
        if (result.removed + result.kept > 0) {
          context.out(
            `${each}: removed ${String(result.removed)} item(s), kept ${String(result.kept)} edited`,
          );
        }
      }
      // the session hook and the refresh timer serve every project: they go with the last one
      if (!anythingGoverned()) {
        for (const managed of [false, true]) {
          try {
            if (hookInstalled(managed) && removeHook(managed)) context.out('session hook removed');
          } catch {
            context.err('the managed hook needs sudo to be removed');
          }
        }
        if (removeTimer()) context.out('timer removed');
      }
    });
  } catch (error) {
    if (error instanceof BusyError) {
      context.err(error.message);
      return 31;
    }
    throw error;
  }
  return 0;
}
