/**
 * Codex on a device (ADR-0086). What the signed policy becomes in Codex's own
 * configuration, derived here from the verified policy because a project bundle
 * never writes to the user's home; plus Codex's hook trust, without which its
 * hooks silently do not run.
 *
 * Everything a bundle cannot reach is written under the `user` layer, locked
 * per project (the policy's rules and profile entries) or per device (the
 * profile's base, the hook registration and the trust of the hook).
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ContractOperation } from '@runonroad/api-contract';
import {
  mergeEntries,
  profileBlock,
  profileEntries,
  rulesFile,
  type ProfileEntry,
} from '@runonroad/codex';
import type { CompiledPolicy } from '@runonroad/claude-code';
import { clientEnvironment } from '@runonroad/config/client';

import { defaultHome } from './paths.js';
import { projectKey, readJson, removeState, rorHome, writeStateFile } from './state.js';

export const MANAGED_ARGUMENT = '--ror-managed';

export const codexHomeOf = (): string =>
  clientEnvironment().codexHome ?? join(defaultHome(), '.codex');

const block = (id: string, content: string, path: string): ContractOperation => ({
  op: 'managed_block',
  path,
  block_id: id,
  content,
  comment_style: 'hash',
});

const userDirectory = (): string => join(rorHome(), 'user');
const entriesFile = (projectDir: string): string =>
  join(userDirectory(), `${projectKey(projectDir)}.codex.entries.json`);

/** This project's profile entries, with the device's roots resolved: the tokens are the client's to fill. */
export function projectEntries(policy: CompiledPolicy, projectDir: string): ProfileEntry[] {
  const resolve = (path: string): string =>
    path.replaceAll('${project}', projectDir).replaceAll('${home}', defaultHome());
  return mergeEntries(
    profileEntries(policy).map(([path, level]): ProfileEntry => [resolve(path), level]),
    // the agent may read the project's RunOnRoad state, never change it
    [[join(projectDir, '.runonroad'), 'read']],
  );
}

/** What each project asked of the profile, kept so the one device-wide block can be rebuilt from all of them. */
export function loadEntries(projectDir: string): ProfileEntry[] | undefined {
  const value = readJson(entriesFile(projectDir));
  return Array.isArray(value) ? (value as ProfileEntry[]) : undefined;
}

export function saveEntries(
  projectDir: string,
  entries: readonly ProfileEntry[] | undefined,
): void {
  const relative = `user/${projectKey(projectDir)}.codex.entries.json`;
  if (entries === undefined) removeState(rorHome(), relative);
  else writeStateFile(rorHome(), relative, JSON.stringify(entries), 0o600);
}

function allEntries(): ProfileEntry[] {
  if (!existsSync(userDirectory())) return [];
  return readdirSync(userDirectory())
    .filter((name) => name.endsWith('.codex.entries.json'))
    .flatMap((name) => {
      const value = readJson(join(userDirectory(), name));
      return Array.isArray(value) ? (value as ProfileEntry[]) : [];
    });
}

/** Per project: its command rules. The profile is one device-wide block (deviceOperations). */
export function projectOperations(policy: CompiledPolicy, projectDir: string): ContractOperation[] {
  return [
    {
      op: 'write_file',
      path: `\${codex_home}/rules/ror-${projectKey(projectDir)}.rules`,
      content: rulesFile(policy),
    },
  ];
}

/** Once per device: the profile (every project's entries merged), and the hooks registered where Codex reads them. */
export function deviceOperations(
  rorDir: string,
  hookCommand: string,
  syncCommand: string,
): ContractOperation[] {
  const codexHome = codexHomeOf();
  const entries = mergeEntries(allEntries(), [
    // the agent may read Codex's own configuration, never change it; ror's device state not even read
    [join(codexHome, 'config.toml'), 'read'],
    [join(codexHome, 'hooks.json'), 'read'],
    [join(codexHome, 'rules'), 'read'],
    [rorDir, 'none'],
  ]);
  return [
    block('ror-base', profileBlock(entries).join('\n'), '${codex_home}/config.toml'),
    {
      op: 'merge_json',
      path: '${codex_home}/hooks.json',
      pointer: '/hooks/PreToolUse',
      value: [
        {
          // Bash, file patches and MCP tools; the hosted tools Codex does not route through hooks are out of reach
          matcher: '^(Bash|apply_patch|mcp__.*)$',
          hooks: [{ type: 'command', command: hookCommand, timeout: 10 }],
        },
      ],
      strategy: 'append_unique',
      owner: '_runonroad',
    },
    // the person's message and the end of an answer (ADR-0088): the hook answers nothing in a project
    // with no content rule, so these are cheap to keep registered
    ...(['UserPromptSubmit', 'Stop'] as const).map((event): ContractOperation => ({
      op: 'merge_json',
      path: '${codex_home}/hooks.json',
      pointer: `/hooks/${event}`,
      value: [{ hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] }],
      strategy: 'append_unique',
      owner: '_runonroad',
    })),
    {
      op: 'merge_json',
      path: '${codex_home}/hooks.json',
      pointer: '/hooks/SessionStart',
      value: [
        {
          matcher: 'startup|resume|clear',
          hooks: [{ type: 'command', command: syncCommand, timeout: 60 }],
        },
      ],
      strategy: 'append_unique',
      owner: '_runonroad',
    },
  ];
}

export interface CodexHook {
  readonly key: string;
  readonly command: string;
  readonly currentHash: string;
  readonly trustStatus: string;
  readonly enabled: boolean;
}

/**
 * Codex's own view of its hooks (`hooks/list` of its app server): the key and
 * hash that trust is recorded against, and whether each one would run. Undefined
 * when Codex is not installed or does not answer.
 */
export function listHooks(cwd: string, timeoutMs = 20_000): Promise<CodexHook[] | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        // `codex` is a .cmd shim on Windows
        shell: process.platform === 'win32',
      });
    } catch {
      resolve(undefined);
      return;
    }
    let output = '';
    let done = false;
    const finish = (value: CodexHook[] | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(undefined);
    }, timeoutMs);
    // the server may be gone by the time a write lands; that is an answer of "none", not a crash
    child.stdin.on('error', () => {
      finish(undefined);
    });
    child.on('error', () => {
      finish(undefined);
    });
    child.on('exit', () => {
      finish(undefined);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      for (const line of output.split('\n')) {
        let message: { id?: number; result?: { data?: { hooks?: unknown[] }[] } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (done) return;
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(
            `${JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } })}\n`,
          );
        } else if (message.id === 2) {
          const hooks = (message.result?.data?.[0]?.hooks ?? []).flatMap((entry): CodexHook[] => {
            const hook = entry as Partial<CodexHook> | null;
            return typeof hook?.key === 'string' &&
              typeof hook.command === 'string' &&
              typeof hook.currentHash === 'string' &&
              typeof hook.trustStatus === 'string'
              ? [
                  {
                    key: hook.key,
                    command: hook.command,
                    currentHash: hook.currentHash,
                    trustStatus: hook.trustStatus,
                    enabled: hook.enabled !== false,
                  },
                ]
              : [];
          });
          finish(hooks);
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ror', version: '0' } } })}\n`,
    );
  });
}

export const isOurs = (hook: CodexHook): boolean => hook.command.includes(MANAGED_ARGUMENT);

const tomlString = (text: string): string =>
  `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** The trust entries for every RunOnRoad hook Codex lists: what a person would approve in `/hooks`, done by `ror sync`. */
export function trustOperation(hooks: readonly CodexHook[]): ContractOperation {
  const lines = hooks
    .filter(isOurs)
    .sort((a, b) => a.key.localeCompare(b.key, 'en'))
    .flatMap((hook) => [
      `[hooks.state.${tomlString(hook.key)}]`,
      `trusted_hash = ${tomlString(hook.currentHash)}`,
    ]);
  return block(
    'ror-trust',
    lines.length === 0 ? '# no RunOnRoad hook to trust' : lines.join('\n'),
    '${codex_home}/config.toml',
  );
}

/** True when every RunOnRoad hook Codex lists would run. */
export const hooksTrusted = (hooks: readonly CodexHook[]): boolean => {
  const ours = hooks.filter(isOurs);
  return ours.length >= 4 && ours.every((hook) => hook.trustStatus === 'trusted' && hook.enabled);
};
