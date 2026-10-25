/**
 * `ror sync` (SPEC-007): fetch the signed bundle with a conditional request,
 * verify the signature BEFORE parsing, refuse an older or expired bundle,
 * plan then apply, and keep the last verified bundle for offline runs.
 * Exit codes: 0 · 11 login needed · 30 partial · 31 failure · 32 signature.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ContractOperation, HarnessBundle } from '@runonroad/api-contract';
import { HarnessBundleSchema, SIGNATURE_HEADER } from '@runonroad/api-contract/harness';
import { SETTINGS_PATH, settingsOperations, type CompiledPolicy } from '@runonroad/claude-code';
import { cliDeny, GUARDED_EVENTS } from '@runonroad/cursor';

import { blockers, detectCapabilities, type Capabilities } from './coverage.js';
import {
  deviceOperations,
  listHooks,
  loadEntries,
  projectEntries,
  projectOperations,
  saveEntries,
  trustOperation,
  type CodexHook,
} from './codex.js';
import { contextSize, MAX_CONTEXT_BYTES } from './conversation.js';
import type { PolicyRule } from './evaluate.js';
import { readRules } from './hook.js';
import { reportHealth } from './health-report.js';
import { hookCommand, SETTINGS_FILE, targetCommand } from './install.js';
import { applyManaged, readLock, uninstallManaged, type ApplyResult } from './managed.js';
import { RefusedError, defaultHome } from './paths.js';
import type { HookTarget } from './protocol.js';
import { clientOf, call, pinnedKeys, type Enrolment } from './session.js';
import {
  BusyError,
  loadCache,
  loadState,
  projectKey,
  rorHome,
  saveCache,
  saveState,
  withMachineLockAsync,
} from './state.js';
import { gitDirOf, layerOf, lockFileOf, plan } from './sync-plan.js';
import { RefusedOperationError, UnsupportedOperationError } from './managed.js';
import { SignatureError, verifyBody } from './verify.js';

export { projectRootOf } from './sync-plan.js';

/** The default target; `--target codex` or `--target cursor` select another. */
export const TARGET: HookTarget = 'claude_code';

export type SyncStatus =
  | 'applied'
  | 'unchanged'
  | 'offline'
  | 'refused'
  | 'unauthorized'
  | 'signature'
  | 'expired'
  | 'busy'
  | 'failed';

export interface SyncOutcome {
  readonly status: SyncStatus;
  readonly code: 0 | 11 | 30 | 31 | 32;
  readonly message: string;
  /** The managed files written by this run (paths). */
  readonly written: readonly string[];
  /** Text of the instruction files written, for a hook to inject. */
  readonly changedContent: readonly string[];
  /** The whole instruction file of the project, for a tool whose session start injects it every time. */
  readonly instructions?: string;
}

export interface SyncEnv {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly projectDir: string;
  /** What this device can enforce; detected when absent (tests hand their own). */
  readonly capabilities?: Capabilities;
  readonly target?: HookTarget;
  /** Codex's own list of hooks (its app server); a test hands a fake. */
  readonly listHooks?: (cwd: string) => Promise<CodexHook[] | undefined>;
}

const fail = (
  status: SyncStatus,
  code: SyncOutcome['code'],
  message: string,
  extra: Partial<SyncOutcome> = {},
): SyncOutcome => ({ status, code, message, written: [], changedContent: [], ...extra });

interface Fetched {
  readonly body: string;
  readonly signature: string;
  readonly etag: string | null;
  readonly fresh: boolean;
}

async function fetchBundle(
  env: SyncEnv,
  enrolment: Enrolment,
): Promise<Fetched | SyncOutcome | 'offline'> {
  const cache = loadCache(env.projectDir, env.target ?? TARGET);
  let answered: Awaited<ReturnType<typeof call>>;
  try {
    answered = await call(clientOf(enrolment, env.fetch), 'GET', '/harness', {
      query: { targets: env.target ?? TARGET, layer: 'project' },
      ...(cache === undefined ? {} : { headers: { 'if-none-match': cache.etag } }),
    });
  } catch {
    return 'offline';
  }
  if (answered.status === 304 && cache !== undefined) {
    return { body: cache.body, signature: cache.signature, etag: cache.etag, fresh: false };
  }
  if (answered.status === 401) {
    return fail('unauthorized', 11, 'ROR-E401: this device is no longer enrolled; run `ror login`');
  }
  if (answered.status !== 200) {
    return fail('failed', 31, `the server answered ${String(answered.status)}`);
  }
  return {
    body: answered.text,
    signature: answered.headers.get(SIGNATURE_HEADER) ?? '',
    etag: answered.headers.get('etag'),
    fresh: true,
  };
}

// The fetch is resolved before the lock, so a slow network never holds other writers.
export async function sync(env: SyncEnv, enrolment: Enrolment): Promise<SyncOutcome> {
  const fetched = await fetchBundle(env, enrolment);
  if (fetched !== 'offline' && 'status' in fetched) return fetched;
  // the hook's declared health goes up here, never from the hook (ADR-0091)
  if (fetched !== 'offline') {
    await reportHealth({ client: clientOf(enrolment, env.fetch), now: env.now }, rorHome()).catch(
      () => undefined,
    );
  }
  try {
    return await withMachineLockAsync(() => finish(env, enrolment, fetched));
  } catch (error) {
    if (error instanceof BusyError) return fail('busy', 31, error.message);
    throw error;
  }
}

async function finish(
  env: SyncEnv,
  enrolment: Enrolment,
  fetched: Fetched | 'offline',
): Promise<SyncOutcome> {
  const target = env.target ?? TARGET;
  const state = loadState();
  const nowMs = Math.max(env.now().getTime(), state.last_seen_ms);
  const cache = loadCache(env.projectDir, target);
  const offline = fetched === 'offline';
  const source = offline
    ? cache === undefined
      ? undefined
      : { body: cache.body, signature: cache.signature, etag: cache.etag, fresh: false }
    : fetched;
  if (source === undefined) {
    return fail('offline', 31, 'the server is unreachable and there is no verified bundle yet');
  }

  let bundle: HarnessBundle;
  try {
    verifyBody(new TextEncoder().encode(source.body), source.signature, pinnedKeys(enrolment));
    const parsed = HarnessBundleSchema.safeParse(JSON.parse(source.body));
    if (!parsed.success) return fail('refused', 31, 'the bundle does not match the contract');
    bundle = parsed.data;
  } catch (error) {
    if (error instanceof SignatureError) return fail('signature', 32, error.message);
    return fail('refused', 31, 'the bundle is not valid JSON');
  }
  if (
    bundle.organization_id !== enrolment.organization_id ||
    bundle.layer !== 'project' ||
    bundle.target !== target
  ) {
    return fail('refused', 31, 'the bundle is not for this device, target or layer');
  }
  if (source.fresh && cache !== undefined) {
    const known = HarnessBundleSchema.safeParse(JSON.parse(cache.body));
    if (known.success && Date.parse(bundle.issued_at) < Date.parse(known.data.issued_at)) {
      return fail('signature', 32, 'the bundle is older than the one already applied (rollback)');
    }
  }
  if (bundle.expires_at !== null && Date.parse(bundle.expires_at) <= nowMs) {
    return fail('expired', 31, 'the bundle has expired; the previous rules stay in place');
  }

  const read = readRules(bundle.policy?.rules ?? []);
  const policyRules: PolicyRule[] = read.rules;
  const principals = { ...state.principals };
  let policy: CompiledPolicy | undefined;
  let tightened = false;
  if (bundle.policy !== undefined) {
    if (read.unknown > 0) {
      return fail('refused', 31, 'the policy holds a rule this ror does not understand');
    }
    // the rules put in front of the AI at every prompt must fit: a rule is never cut to make room
    if (contextSize(read.content) > MAX_CONTEXT_BYTES) {
      return fail(
        'refused',
        31,
        `the content rules need more than ${String(MAX_CONTEXT_BYTES)} bytes of context: reduce them or split them`,
      );
    }
    const principal = bundle.policy.principal;
    // one person per project; and, for the tools that keep their rules in the user's home, one per device
    for (const key of target === 'claude_code'
      ? [env.projectDir]
      : [env.projectDir, `device:${target}`]) {
      const pinned = principals[key];
      if (pinned !== undefined && principal !== null && pinned !== principal) {
        return fail(
          'refused',
          31,
          key === env.projectDir
            ? 'the policy is for another person than the one it was activated for'
            : `this account already applies ${target} rules for another person; use another OS account`,
        );
      }
      if (pinned === undefined && principal !== null) principals[key] = principal;
    }
    const blocked = blockers(policyRules, env.capabilities ?? detectCapabilities(target), target);
    if (blocked.length > 0) {
      const names = blocked.map((entry) => `${entry.id} (${entry.status}: ${entry.why})`);
      return fail(
        'refused',
        31,
        `policy not activated, a required rule is not enforced here: ${names.join('; ')}`,
      );
    }
    // a lease is a bounded lift (ADR-0087): once it ended, the restrictions come back from this
    // verified policy, with no server, whatever the bundle's native settings still say
    const active = (bundle.policy.derogations ?? []).filter(
      (derogation) => Date.parse(derogation.expires_at) > nowMs,
    );
    tightened = active.length !== (bundle.policy.derogations ?? []).length;
    policy = { ...bundle.policy, derogations: active } as unknown as CompiledPolicy;
  }
  let operations: ContractOperation[] = [...bundle.operations];
  if (tightened && policy !== undefined && target === 'claude_code') {
    operations = operations.filter(
      (operation) =>
        !(
          operation.op === 'merge_json' &&
          operation.owner === '_runonroad' &&
          operation.path === SETTINGS_PATH
        ),
    );
    operations.push(...(settingsOperations(policy) as ContractOperation[]));
  }
  if (bundle.policy !== undefined) {
    operations.push(
      ...policyOperations(target, source.body, source.signature, read.content.length > 0),
    );
    if (target === 'claude_code') operations = withProtections(operations, rorHome());
  }

  const roots = { project: env.projectDir, home: defaultHome() };
  const meta = {
    target: bundle.target,
    effective_hash: bundle.effective_hash,
    organization_id: bundle.organization_id,
    issued_at: bundle.issued_at,
    applied_at: env.now().toISOString(),
  };
  let report: ApplyResult;
  try {
    const planned = plan(operations, {
      layer: 'project',
      roots,
      gitDir: gitDirOf(env.projectDir),
      target,
    });
    report = applyManaged(
      planned.operations,
      { ...planned.layer, lockPath: lockFileOf(env.projectDir, target) },
      { extended: true, retire: 'unchanged-only', meta },
    );
    const userWritten =
      target === 'claude_code' ? [] : await applyUserLayer(env, target, bundle, policy);
    if (source.fresh && source.etag !== null) {
      saveCache(
        env.projectDir,
        {
          etag: source.etag,
          body: source.body,
          signature: source.signature,
          saved_at: env.now().toISOString(),
        },
        target,
      );
    }
    saveState({
      last_seen_ms: nowMs,
      projects: [...new Set([...state.projects, env.projectDir])],
      principals,
      targets: {
        ...state.targets,
        [env.projectDir]: [...new Set([...(state.targets[env.projectDir] ?? []), target])],
      },
    });
    const written = [...report.written, ...userWritten];
    const changedContent = planned.operations.flatMap((operation) =>
      operation.op === 'write_file' &&
      isRuleFile(operation.path) &&
      // Windows reports `C:\\x\\.claude\\y`, the plan says `${project}/.claude/y`: one separator for the comparison
      report.written.some((path) =>
        path.replaceAll('\\', '/').endsWith(operation.path.slice('${project}'.length)),
      )
        ? [operation.content]
        : [],
    );
    const status: SyncStatus = offline
      ? 'offline'
      : written.length + report.removed.length === 0
        ? 'unchanged'
        : 'applied';
    const note = offline ? ' (offline: the last verified bundle)' : '';
    const lease = tightened ? ' (a derogation ended: the restrictions are back)' : '';
    return {
      status,
      code: report.kept.length > 0 ? 30 : 0,
      message: `${status}${note}${lease}: ${String(written.length)} written, ${String(report.unchanged)} unchanged, ${String(report.removed.length)} removed`,
      written,
      changedContent,
      ...(target === 'codex' ? { instructions: readInstructions(env.projectDir) } : {}),
    };
  } catch (error) {
    if (
      error instanceof RefusedError ||
      error instanceof RefusedOperationError ||
      error instanceof UnsupportedOperationError
    ) {
      return fail('refused', 31, error.message);
    }
    throw error;
  }
}

function readInstructions(projectDir: string): string {
  try {
    return readFileSync(
      join(projectDir, '.runonroad', 'instructions', 'ror-governance.md'),
      'utf8',
    );
  } catch {
    return '';
  }
}

/**
 * Codex and Cursor keep their rules in the user's home, which a project bundle never
 * reaches (ADR-0086): they are derived here from the verified policy and written under
 * the `user` layer. Per project: its rules and profile entries. Per device: the base of
 * the profile, the hooks, and (Codex) the trust that makes the hooks run.
 */
async function applyUserLayer(
  env: SyncEnv,
  target: 'codex' | 'cursor',
  bundle: HarnessBundle,
  policy: CompiledPolicy | undefined,
): Promise<string[]> {
  const directory = join(rorHome(), 'user');
  const key = projectKey(env.projectDir);
  const roots = { project: env.projectDir, home: defaultHome() };
  const written: string[] = [];
  const run = (name: string, operations: ContractOperation[]): void => {
    const lockPath = join(directory, `${name}.${target}.json`);
    const planned = plan(operations, { layer: 'user', roots, gitDir: undefined });
    const report = applyManaged(
      planned.operations,
      { ...planned.layer, lockPath },
      {
        extended: true,
        retire: 'unchanged-only',
        meta: {
          target: bundle.target,
          effective_hash: bundle.effective_hash,
          organization_id: bundle.organization_id,
          issued_at: bundle.issued_at,
          applied_at: env.now().toISOString(),
        },
      },
    );
    written.push(...report.written);
  };

  if (target === 'cursor') {
    run(key, policy === undefined ? [] : cursorOperations(policy));
    run('_device', cursorDeviceOperations());
    return written;
  }
  // this project's share of the profile first, then the device block that merges every project's;
  // a refusal puts back what was there, so an earlier successful sync keeps its restrictions
  const previousEntries = loadEntries(env.projectDir);
  saveEntries(
    env.projectDir,
    policy === undefined ? undefined : projectEntries(policy, env.projectDir),
  );
  const device = deviceOperations(
    rorHome(),
    targetCommand('codex', 'hook'),
    targetCommand('codex', 'sync'),
  );
  // the device part first: it is the one that can be refused (a profile the user already chose)
  try {
    run('_device', device);
  } catch (error) {
    saveEntries(env.projectDir, previousEntries);
    throw error;
  }
  run(key, policy === undefined ? [] : projectOperations(policy, env.projectDir));
  // Codex runs a hook only once its current hash is trusted, and a changed hook is untrusted again
  const hooks = await (env.listHooks ?? listHooks)(env.projectDir);
  if (hooks === undefined) {
    throw new RefusedError(
      'Codex did not answer, so its hooks cannot be trusted: is `codex` installed?',
    );
  }
  run('_trust', [trustOperation(hooks)]);
  return written;
}

/** Cursor, experimental: its CLI permissions (best effort) from the policy. */
function cursorOperations(policy: CompiledPolicy): ContractOperation[] {
  const deny = cliDeny(policy);
  return [
    {
      op: 'merge_json',
      path: '${home}/.cursor/cli-config.json',
      pointer: '/permissions/deny',
      value: deny,
      strategy: 'append_unique',
      owner: '_runonroad',
    },
  ];
}

function cursorDeviceOperations(): ContractOperation[] {
  return [
    {
      op: 'merge_json',
      path: '${home}/.cursor/hooks.json',
      pointer: '/version',
      value: 1,
      strategy: 'set',
      owner: '_runonroad',
    },
    ...[...GUARDED_EVENTS, 'beforeSubmitPrompt', 'stop'].map((event): ContractOperation => ({
      op: 'merge_json',
      path: '${home}/.cursor/hooks.json',
      pointer: `/hooks/${event}`,
      value: [{ command: targetCommand('cursor', 'hook', event), failClosed: true }],
      strategy: 'append_unique',
      owner: '_runonroad',
    })),
  ];
}

/** Only instruction files are worth injecting into a session; the policy file is not. */
const isRuleFile = (path: string): boolean => path.includes('/.claude/rules/');

/**
 * What the client adds to the server's operations when the bundle carries a
 * policy: the signed policy where `ror hook` reads it, and the hook's own
 * registration (ADR-0085). Both are owned and locked like any other write.
 */
function policyOperations(
  target: HookTarget,
  body: string,
  signature: string,
  conversation: boolean,
): ContractOperation[] {
  const policyFile: ContractOperation = {
    op: 'write_file',
    path: `\${project}/.runonroad/lock/${target}.policy.json`,
    content: JSON.stringify({ body, signature }),
  };
  // Codex and Cursor register their hooks in the user's home (applyUserLayer), not here
  if (target !== 'claude_code') return [policyFile];
  return [
    policyFile,
    // the local scope wins over the project's and the user's: a `disableAllHooks: true` there
    // (checked by hand against Claude Code 2.1.301) no longer silences the hook
    {
      op: 'merge_json',
      path: SETTINGS_FILE,
      pointer: '/disableAllHooks',
      value: false,
      strategy: 'set',
      owner: '_runonroad',
    },
    {
      op: 'merge_json',
      path: SETTINGS_FILE,
      pointer: '/hooks/PreToolUse',
      value: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: hookCommand('hook'), onFailure: 'block', timeout: 30 },
          ],
        },
      ],
      strategy: 'append_unique',
      owner: '_runonroad',
    },
    // the person's message and the end of an answer, only when a content rule asks for them
    ...(conversation
      ? (['UserPromptSubmit', 'Stop'] as const).map((event): ContractOperation => ({
          op: 'merge_json',
          path: SETTINGS_FILE,
          pointer: `/hooks/${event}`,
          value: [{ hooks: [{ type: 'command', command: hookCommand('hook'), timeout: 30 }] }],
          strategy: 'append_unique',
          owner: '_runonroad',
        }))
      : []),
  ];
}

/**
 * The native barriers around RunOnRoad's own files: an agent that could change
 * the policy, the settings or the device state could lift every rule, and a
 * program it starts is not seen by the hook. So the permission rules and the OS
 * sandbox refuse those writes too, and the device state is not even readable
 * (the device token is in it).
 */
function protectionOperations(rorDir: string): ContractOperation[] {
  const append = (pointer: string, value: string[]): ContractOperation => ({
    op: 'merge_json',
    path: SETTINGS_FILE,
    pointer,
    value,
    strategy: 'append_unique',
    owner: '_runonroad',
  });
  const files = [
    '${project}/.runonroad',
    '${project}/.claude/settings.local.json',
    '${project}/.claude/settings.json',
    '${home}/.claude/settings.json',
  ];
  return [
    append('/permissions/deny', [
      ...files.map((file) => `Edit(/${file}${file.endsWith('.runonroad') ? '/**' : ''})`),
      `Edit(/${rorDir}/**)`,
      `Read(/${rorDir}/**)`,
    ]),
    append('/sandbox/filesystem/denyWrite', [...files, rorDir]),
    append('/sandbox/filesystem/denyRead', [rorDir]),
  ];
}

/** The server's operations plus ours, one operation per setting: a list is merged, not written twice. */
function withProtections(operations: ContractOperation[], rorDir: string): ContractOperation[] {
  const merged = [...operations];
  for (const extra of protectionOperations(rorDir)) {
    if (extra.op !== 'merge_json') continue;
    const at = merged.findIndex(
      (operation) =>
        operation.op === 'merge_json' &&
        operation.path === extra.path &&
        operation.pointer === extra.pointer &&
        operation.strategy === 'append_unique' &&
        Array.isArray(operation.value),
    );
    const existing = merged[at];
    if (existing?.op === 'merge_json' && Array.isArray(existing.value)) {
      const values = [...new Set([...(existing.value as string[]), ...(extra.value as string[])])];
      merged[at] = { ...existing, value: values };
    } else merged.push(extra);
  }
  return merged;
}

/** True once a previous apply was interrupted: its first lock, with entries still pending, is all that is left. */
export const interrupted = (projectDir: string, target: HookTarget = TARGET): boolean =>
  existsSync(lockFileOf(projectDir, target)) &&
  readLock(lockFileOf(projectDir, target)).entries.some(
    (entry) => entry.pending === true || entry.next !== undefined,
  );

/**
 * Takes back what `ror` wrote for one tool in one project: the project's files, its rules in the
 * user's home, its share of the profile, and, when no other project still needs them, the
 * device-wide hooks, profile and trust. Leaves the device registry in step.
 */
export function removeTarget(
  projectDir: string,
  target: HookTarget,
  now: Date = new Date(),
): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  const home = defaultHome();
  const take = (lockPath: string, layer: 'user' | 'project'): void => {
    if (!existsSync(lockPath)) return;
    const result = uninstallManaged(layerOf(layer, lockPath, projectDir));
    removed += result.removed.length;
    kept += result.kept.length;
  };
  take(lockFileOf(projectDir, target), 'project');
  const directory = join(rorHome(), 'user');
  take(join(directory, `${projectKey(projectDir)}.${target}.json`), 'user');
  if (target === 'codex') saveEntries(projectDir, undefined);
  const others = listLocks(directory, target);
  if (others.length === 0) {
    take(join(directory, `_device.${target}.json`), 'user');
    take(join(directory, `_trust.${target}.json`), 'user');
  } else if (target === 'codex') {
    // the profile is one block built from every project: without this one's share, it is rebuilt
    const lockPath = join(directory, '_device.codex.json');
    if (existsSync(lockPath)) {
      const previous = readLock(lockPath);
      const planned = plan(
        deviceOperations(rorHome(), targetCommand('codex', 'hook'), targetCommand('codex', 'sync')),
        { layer: 'user', roots: { project: undefined, home }, gitDir: undefined },
      );
      applyManaged(
        planned.operations,
        { ...planned.layer, lockPath },
        {
          extended: true,
          retire: 'unchanged-only',
          meta: {
            ...(previous.target === undefined ? {} : { target: previous.target }),
            ...(previous.effective_hash === undefined
              ? {}
              : { effective_hash: previous.effective_hash }),
            ...(previous.organization_id === undefined
              ? {}
              : { organization_id: previous.organization_id }),
            ...(previous.issued_at === undefined ? {} : { issued_at: previous.issued_at }),
            applied_at: now.toISOString(),
          },
        },
      );
    }
  }
  const state = loadState();
  const remaining = (state.targets[projectDir] ?? []).filter((each) => each !== target);
  const targets: Record<string, string[]> = {
    ...Object.fromEntries(Object.entries(state.targets).filter(([dir]) => dir !== projectDir)),
    ...(remaining.length > 0 ? { [projectDir]: remaining } : {}),
  };
  saveState({
    ...state,
    projects:
      remaining.length > 0 ? state.projects : state.projects.filter((p) => p !== projectDir),
    targets,
  });
  return { removed, kept };
}

/** The per-project user locks of a tool: the others that still need the device-wide parts. */
function listLocks(directory: string, target: HookTarget): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(
    (name) =>
      name.endsWith(`.${target}.json`) &&
      !name.startsWith('_device.') &&
      !name.startsWith('_trust.'),
  );
}

/** True while some project is still governed for some tool: the refresh timer and session hook are still needed. */
export const anythingGoverned = (): boolean => {
  const state = loadState();
  return (
    state.projects.length > 0 || Object.values(state.targets).some((tools) => tools.length > 0)
  );
};
