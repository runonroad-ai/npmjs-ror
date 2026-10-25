/**
 * The signed policy end to end on the client (ADR-0085): `ror sync` activates
 * it (or refuses), writes the native settings and registers the hook, and
 * `ror hook` verifies it again on every call and fails closed.
 */
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { driftOf, readLock, uninstallManaged } from './managed.js';
import { layerOf, lockFileOf } from './sync-plan.js';
import { status } from './status.js';
import type { Capabilities } from './coverage.js';
import { runHook } from './hook.js';
import type { Enrolment } from './session.js';
import { loadState, saveState } from './state.js';
import { saveEnrolment } from './testing/enrol.js';
import {
  bundleBody,
  fakeServer,
  KEY,
  KID,
  pair,
  signature,
  type Fake,
} from './testing/fake-server.js';
import { sync, TARGET } from './sync.js';

const CAPABLE: Capabilities = { sandbox: true, claudeVersion: '2.1.301' };
const policy = (principal = 'mem_lea', required = true) => ({
  schema_version: 1,
  principal,
  mcp_allow: [],
  rules: [
    {
      id: 'g@1.0.0:no-vault',
      source: 'g@1.0.0',
      kind: 'path',
      decision: 'forbid',
      reason: 'Credentials stay in the vault.',
      required,
      access: 'any',
      glob: 'vault/**',
    },
    {
      id: 'g@1.0.0:no-force-push',
      source: 'g@1.0.0',
      kind: 'command',
      decision: 'forbid',
      reason: 'A force-push rewrites shared history.',
      required: false,
      executable: 'git',
      argv_prefix: ['push'],
      flags_any: ['--force', '-f'],
    },
  ],
});

const operations = [
  {
    op: 'write_file',
    path: '${project}/.claude/rules/ror-governance.md',
    content: '# RunOnRoad governance\n<!-- Managed by RunOnRoad — do not edit -->\nNo vault.\n',
  },
  { op: 'git_exclude', pattern: '.claude/rules/ror-*' },
  { op: 'git_exclude', pattern: '.runonroad/lock/' },
  {
    op: 'merge_json',
    path: '${project}/.claude/settings.local.json',
    pointer: '/permissions/deny',
    value: ['Read(/${project}/vault/**)', 'Edit(/${project}/vault/**)'],
    strategy: 'append_unique',
    owner: '_runonroad',
  },
  {
    op: 'merge_json',
    path: '${project}/.claude/settings.local.json',
    pointer: '/sandbox/enabled',
    value: true,
    strategy: 'set',
    owner: '_runonroad',
  },
  {
    op: 'merge_json',
    path: '${project}/.claude/settings.local.json',
    pointer: '/sandbox/filesystem/denyRead',
    value: ['${project}/vault/**'],
    strategy: 'append_unique',
    owner: '_runonroad',
  },
];

let fake: Fake;
let project: string;
let home: string;
let enrolment: Enrolment;
const projectLayer = () => layerOf('project', lockFileOf(project, TARGET), project);
const settingsFile = (): string => join(project, '.claude', 'settings.local.json');
const policyFile = (): string => join(project, '.runonroad', 'lock', 'claude_code.policy.json');
interface Settings {
  permissions: { deny: string[] };
  sandbox: { enabled: boolean; filesystem?: { denyRead: string[] } };
  hooks: {
    PreToolUse: {
      matcher: string;
      hooks: { type: string; command: string; onFailure: string }[];
    }[];
  };
  theme?: string;
  disableAllHooks?: boolean;
}
const settings = (): Settings => JSON.parse(readFileSync(settingsFile(), 'utf8')) as Settings;
const env = (capabilities: Capabilities = CAPABLE, now = '2026-10-17T12:00:00.000Z') => ({
  fetch,
  now: () => new Date(now),
  projectDir: project,
  capabilities,
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ror-pol-home-'));
  project = mkdtempSync(join(tmpdir(), 'ror-pol-project-'));
  process.env['RUNONROAD_HOME'] = join(home, '.runonroad');
  process.env['HOME'] = home;
  process.env['CLAUDE_CONFIG_DIR'] = join(home, '.claude');
  process.env['CLAUDE_PROJECT_DIR'] = project;
  execFileSync('git', ['init', '-q'], { cwd: project });
  fake = await fakeServer();
  fake.next = { operations, policy: policy() };
  enrolment = {
    api: fake.url,
    device_token: `rord_${'a'.repeat(43)}`,
    organization_id: 'org_test',
    keys: [KEY],
  };
  saveEnrolment(enrolment);
});

afterEach(() => {
  fake.server.close();
  delete process.env['CLAUDE_PROJECT_DIR'];
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('activating a policy', () => {
  it('writes the native settings, the signed policy and the hook, and locks them all', async () => {
    const outcome = await sync(env(), enrolment);
    expect(outcome).toMatchObject({ status: 'applied', code: 0 });
    expect(settings().permissions.deny).toEqual(
      expect.arrayContaining([`Read(/${project}/vault/**)`, `Edit(/${project}/vault/**)`]),
    );
    expect(settings().sandbox.enabled).toBe(true);
    expect(settings().sandbox.filesystem?.denyRead).toContain(`${project}/vault/**`);
    const [entry] = settings().hooks.PreToolUse;
    expect(entry?.matcher).toBe('*');
    expect(entry?.hooks[0]).toMatchObject({ type: 'command', onFailure: 'block' });
    expect(entry?.hooks[0]?.command).toContain('hook-main.js');
    expect(existsSync(policyFile())).toBe(true);
    const lock = readLock(lockFileOf(project, TARGET));
    expect(lock.entries.filter((item) => item.kind === 'json')).toHaveLength(6);
    expect(driftOf(projectLayer())).toEqual([]);
  });

  it('does not hand the signed policy to the model as session context', async () => {
    const outcome = await sync(env(), enrolment);
    expect(outcome.changedContent.join('')).toContain('No vault.');
    expect(outcome.changedContent.join('')).not.toContain('signature');
  });

  it('is idempotent: a second run changes nothing and keeps one hook', async () => {
    await sync(env(), enrolment);
    const first = readFileSync(settingsFile(), 'utf8');
    expect(await sync(env(), enrolment)).toMatchObject({ status: 'unchanged' });
    expect(readFileSync(settingsFile(), 'utf8')).toBe(first);
    expect(settings().hooks.PreToolUse).toHaveLength(1);
  });

  it('keeps what the user already had in their settings, and gives it back on uninstall', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    const mine = {
      permissions: { deny: ['Bash(rm -rf /)'], allow: ['Bash(ls)'] },
      sandbox: { enabled: false },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
      theme: 'dark',
    };
    writeFileSync(settingsFile(), `${JSON.stringify(mine, null, 2)}\n`);
    await sync(env(), enrolment);
    expect(settings().permissions.deny).toContain('Bash(rm -rf /)');
    expect(settings().permissions.deny).toContain(`Read(/${project}/vault/**)`);
    expect(settings().sandbox.enabled).toBe(true);
    expect(settings().hooks.PreToolUse).toHaveLength(2);
    expect(settings().theme).toBe('dark');

    expect(uninstallManaged(projectLayer()).kept).toEqual([]);
    expect(settings()).toEqual(mine);
    expect(existsSync(policyFile())).toBe(false);
  });

  it('removes the policy, the hook and the settings when the bundle stops carrying them', async () => {
    await sync(env(), enrolment);
    fake.next = { issuedAt: '2026-10-17T11:00:00.000Z', operations: operations.slice(0, 3) };
    await sync(env(), enrolment);
    expect(existsSync(settingsFile())).toBe(false);
    expect(existsSync(policyFile())).toBe(false);
  });

  it('restores a setting the user turned off (drift)', async () => {
    await sync(env(), enrolment);
    const tampered = settings();
    tampered.sandbox.enabled = false;
    writeFileSync(settingsFile(), JSON.stringify(tampered));
    expect(driftOf(projectLayer())).toContain('${project}/.claude/settings.local.json');
    await sync(env(), enrolment);
    expect(settings().sandbox.enabled).toBe(true);
  });
});

describe('refusing to activate (ADR-0083: a required rule must be enforced here)', () => {
  it('refuses when the OS sandbox is missing and a required path rule needs it', async () => {
    const outcome = await sync(env({ sandbox: false, claudeVersion: '2.1.301' }), enrolment);
    expect(outcome).toMatchObject({ status: 'refused', code: 31 });
    expect(outcome.message).toContain('g@1.0.0:no-vault');
    expect(outcome.message).toContain('sandbox');
    expect(existsSync(settingsFile())).toBe(false);
    expect(existsSync(policyFile())).toBe(false);
  });

  it('refuses a Claude Code version that was not tested', async () => {
    const outcome = await sync(env({ sandbox: true, claudeVersion: '9.9.9' }), enrolment);
    expect(outcome).toMatchObject({ status: 'refused' });
    expect(outcome.message).toContain('uncertified');
    const none = await sync(env({ sandbox: true, claudeVersion: undefined }), enrolment);
    expect(none.message).toContain('not installed');
  });

  it('activates when only optional rules are partial', async () => {
    fake.next = { operations, policy: policy('mem_lea', false) };
    const outcome = await sync(env({ sandbox: false, claudeVersion: '2.1.301' }), enrolment);
    expect(outcome).toMatchObject({ status: 'applied' });
  });

  it('keeps the previous policy in place when a new one is refused', async () => {
    await sync(env(), enrolment);
    fake.next = {
      issuedAt: '2026-10-17T11:00:00.000Z',
      operations,
      policy: policy('mem_lea', true),
    };
    const refused = await sync(env({ sandbox: false, claudeVersion: '2.1.301' }), enrolment);
    expect(refused.status).toBe('refused');
    expect(existsSync(policyFile())).toBe(true);
  });

  it('pins the policy to the person it was first activated for', async () => {
    await sync(env(), enrolment);
    expect(Object.values(loadState().principals)).toEqual(['mem_lea']);
    fake.next = {
      issuedAt: '2026-10-17T11:00:00.000Z',
      operations,
      policy: policy('mem_max'),
    };
    const outcome = await sync(env(), enrolment);
    expect(outcome).toMatchObject({ status: 'refused' });
    expect(outcome.message).toContain('another person');
  });
});

// ------------------------------------------------------------------ hook

const call = (tool_name: string, tool_input: Record<string, unknown>) =>
  JSON.stringify({ tool_name, tool_input, cwd: project, hook_event_name: 'PreToolUse' });
const decision = (stdin: string, now = new Date('2026-10-17T12:00:00.000Z')) => {
  const { stdout } = runHook(stdin, now);
  if (stdout === '') return 'allow';
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  return `${parsed.hookSpecificOutput.permissionDecision}: ${parsed.hookSpecificOutput.permissionDecisionReason}`;
};

describe('ror hook', () => {
  beforeEach(async () => {
    await sync(env(), enrolment);
  });

  it('allows what the policy does not forbid, silently', () => {
    expect(decision(call('Bash', { command: 'ls -la' }))).toBe('allow');
    expect(decision(call('Read', { file_path: 'README.md' }))).toBe('allow');
  });

  it('denies a forbidden path and a forbidden command, naming the rule', () => {
    expect(decision(call('Read', { file_path: 'vault/item.txt' }))).toMatch(
      /^deny: Blocked by RunOnRoad rule g@1.0.0:no-vault: Credentials stay in the vault\.$/u,
    );
    expect(decision(call('Bash', { command: 'git push --force' }))).toContain('no-force-push');
  });

  it('records a content-free audit line for every call', () => {
    decision(call('Bash', { command: 'git push --force origin SECRET-BRANCH' }));
    const lines = readFileSync(join(home, '.runonroad', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n');
    const last = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
    expect(Object.keys(last).sort()).toEqual(['at', 'decision', 'rule', 'tool']);
    expect(JSON.stringify(last)).not.toContain('SECRET-BRANCH');
  });

  it('answers a deny on input it cannot read', () => {
    expect(decision('not json')).toMatch(/^deny/u);
    expect(decision(JSON.stringify({ nothing: true }))).toMatch(/^deny/u);
  });

  describe('fails closed: reading only, when the policy cannot be trusted', () => {
    const effectful = call('Bash', { command: 'ls' });
    const reading = call('Read', { file_path: 'README.md' });
    const expectClosed = (why?: RegExp): void => {
      expect(decision(effectful)).toMatch(why ?? /^deny/u);
      expect(decision(call('Write', { file_path: 'x', content: 'y' }))).toMatch(/^deny/u);
      expect(decision(reading)).toBe('allow');
    };

    it('when the policy file is gone', () => {
      rmSync(policyFile());
      expectClosed(/no policy file/u);
    });

    it('when it was altered, even by one character', () => {
      const file = JSON.parse(readFileSync(policyFile(), 'utf8')) as { body: string };
      file.body = file.body.replace('"forbid"', '"allow "');
      writeFileSync(policyFile(), JSON.stringify(file));
      expectClosed(/signature/u);
    });

    it('when it is signed by a key this device does not trust', () => {
      const other = generateKeyPairSync('ed25519');
      const file = JSON.parse(readFileSync(policyFile(), 'utf8')) as { body: string };
      writeFileSync(
        policyFile(),
        JSON.stringify({ body: file.body, signature: signature(file.body, other.privateKey) }),
      );
      expectClosed(/signature/u);
    });

    it('when it is for another organization or another person', () => {
      const other = bundleBody({ operations, policy: policy(), organization: 'org_other' });
      writeFileSync(policyFile(), JSON.stringify({ body: other, signature: signature(other) }));
      expectClosed(/organization/u);
      const someone = bundleBody({ operations, policy: policy('mem_max') });
      writeFileSync(policyFile(), JSON.stringify({ body: someone, signature: signature(someone) }));
      expectClosed(/another person/u);
    });

    it('when an older valid policy is put back (replay)', () => {
      const older = bundleBody({
        operations,
        policy: policy(),
        issuedAt: '2026-10-16T10:00:00.000Z',
      });
      writeFileSync(policyFile(), JSON.stringify({ body: older, signature: signature(older) }));
      expectClosed(/older/u);
    });

    it('when it has expired, and the clock was set back to hide it', () => {
      const expiring = bundleBody({
        operations,
        policy: policy(),
        issuedAt: '2026-10-17T10:00:00.000Z',
        expiresAt: '2026-10-17T13:00:00.000Z',
      });
      writeFileSync(
        policyFile(),
        JSON.stringify({ body: expiring, signature: signature(expiring) }),
      );
      expect(decision(effectful, new Date('2026-10-17T12:00:00.000Z'))).toBe('allow');
      expect(decision(effectful, new Date('2026-10-17T14:00:00.000Z'))).toMatch(/expired/u);
      // the clock goes back, but the latest time ever seen does not
      const state = loadState();
      saveState({ ...state, last_seen_ms: Date.parse('2026-10-17T14:00:00.000Z') });
      expect(decision(effectful, new Date('2026-10-17T12:00:00.000Z'))).toMatch(/expired/u);
    });

    it('when a rule is one this ror does not understand', () => {
      const odd = bundleBody({
        operations,
        policy: { ...policy(), rules: [{ id: 'x', kind: 'teleport' }] },
      });
      writeFileSync(policyFile(), JSON.stringify({ body: odd, signature: signature(odd) }));
      expectClosed(/does not understand/u);
    });

    it('when the device is no longer enrolled', () => {
      rmSync(join(home, '.runonroad', 'signing-keys.json'));
      expectClosed(/not enrolled/u);
    });
  });

  it('knows the key that signs the fixtures', () => {
    expect(KID).toBe(KEY.kid);
    expect(pair.publicKey.export({ format: 'jwk' }).x).toBe(KEY.x);
  });
});

describe('what the review found in the hook and the settings', () => {
  const signedBundle = (overrides: Record<string, unknown>): void => {
    const body = JSON.stringify({
      ...(JSON.parse(bundleBody({ operations, policy: policy() })) as Record<string, unknown>),
      ...overrides,
    });
    writeFileSync(policyFile(), JSON.stringify({ body, signature: signature(body) }));
  };

  beforeEach(async () => {
    await sync(env(), enrolment);
  });

  it('treats an expiry or an issue date it cannot read as a policy that cannot be trusted', () => {
    signedBundle({ expires_at: 'next tuesday' });
    expect(decision(call('Bash', { command: 'ls' }))).toMatch(/expired/u);
    signedBundle({ issued_at: 'garbage' });
    expect(decision(call('Bash', { command: 'ls' }))).toMatch(/issue date/u);
  });

  it('finds the project from the nearest ancestor when Claude Code does not name it', () => {
    delete process.env['CLAUDE_PROJECT_DIR'];
    const inner = join(project, 'src', 'deep');
    mkdirSync(inner, { recursive: true });
    const stdin = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: join(project, 'vault', 'item.txt') },
      cwd: inner,
    });
    expect(decision(stdin)).toMatch(/^deny.*no-vault/u);
  });

  it('refuses the agent writing the files the rules rest on, with the policy valid', () => {
    for (const file of [
      join(project, '.claude', 'settings.local.json'),
      join(project, '.runonroad', 'lock', 'claude_code.policy.json'),
    ]) {
      expect(decision(call('Write', { file_path: file, content: '{}' }))).toMatch(
        /^deny.*protects its own files/u,
      );
    }
    expect(decision(call('Bash', { command: 'rm .claude/settings.local.json' }))).toMatch(/^deny/u);
  });

  it('takes back a setting it no longer asks for when the list changes', async () => {
    const changed = operations.map((operation) =>
      operation.pointer === '/permissions/deny'
        ? { ...operation, value: ['Read(/${project}/other/**)'] }
        : operation,
    );
    fake.next = { issuedAt: '2026-10-17T11:00:00.000Z', operations: changed, policy: policy() };
    await sync(env(), enrolment);
    const deny = settings().permissions.deny;
    expect(deny).toContain(`Read(/${project}/other/**)`);
    expect(deny).not.toContain(`Read(/${project}/vault/**)`);
    expect(uninstallManaged(projectLayer()).kept).toEqual([]);
    expect(existsSync(settingsFile())).toBe(false);
  });
});

describe('the rules cannot be lifted by a program the agent starts', () => {
  it('asks the permission rules and the sandbox to guard RunOnRoad’s own files', async () => {
    await sync(env(), enrolment);
    const ror = join(home, '.runonroad');
    const deny = settings().permissions.deny;
    for (const expected of [
      `Edit(/${project}/.runonroad/**)`,
      `Edit(/${project}/.claude/settings.local.json)`,
      `Edit(/${project}/.claude/settings.json)`,
      `Edit(/${home}/.claude/settings.json)`,
      `Edit(/${ror}/**)`,
      `Read(/${ror}/**)`,
    ]) {
      expect(deny, expected).toContain(expected);
    }
    const filesystem = settings().sandbox.filesystem as unknown as {
      denyWrite: string[];
      denyRead: string[];
    };
    expect(filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        `${project}/.runonroad`,
        `${project}/.claude/settings.local.json`,
        ror,
      ]),
    );
    expect(filesystem.denyRead).toContain(ror);
    // the server's own deny list and ours are one list, written once
    expect(new Set(deny).size).toBe(deny.length);
  });

  it('still gives the user their settings back, protections included', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    const mine = { theme: 'dark', permissions: { deny: ['Bash(rm -rf /)'] } };
    writeFileSync(settingsFile(), `${JSON.stringify(mine, null, 2)}\n`);
    await sync(env(), enrolment);
    expect(uninstallManaged(projectLayer()).kept).toEqual([]);
    expect(settings()).toEqual(mine);
  });
});

describe('ror status says what is installed and sound, not only what the device could do', () => {
  const blocking = (report: ReturnType<typeof status>) =>
    report.coverage.find((row) => row.capability === 'blocking a forbidden action');

  it('reports the enforcement active when everything is in place', async () => {
    await sync(env(), enrolment);
    const report = status(project, CAPABLE);
    expect(report.enforcement?.active).toBe(true);
    // one rule is only `partial` (a command rule), so the whole is not claimed `enforced`
    expect(blocking(report)?.guarantee).toBe('advisory');
    expect(report.rules.find((rule) => rule.id.endsWith('no-vault'))?.status).toBe('enforced');
  });

  it('says NOT ACTIVE once the policy is gone, though the device could enforce it', async () => {
    await sync(env(), enrolment);
    rmSync(policyFile());
    const report = status(project, CAPABLE);
    expect(report.enforcement?.active).toBe(false);
    expect(blocking(report)?.guarantee).toBe('none');
    expect(blocking(report)?.note).toContain('NOT ACTIVE');
  });

  it('says NOT ACTIVE once the hook is no longer registered', async () => {
    await sync(env(), enrolment);
    const tampered = settings() as unknown as Record<string, unknown>;
    delete tampered['hooks'];
    writeFileSync(settingsFile(), JSON.stringify(tampered));
    expect(status(project, CAPABLE).enforcement?.active).toBe(false);
  });

  it('says NOT ACTIVE when the policy was altered', async () => {
    await sync(env(), enrolment);
    const file = JSON.parse(readFileSync(policyFile(), 'utf8')) as { body: string };
    writeFileSync(
      policyFile(),
      JSON.stringify({ ...file, body: file.body.replace('forbid', 'xforbid') }),
    );
    expect(status(project, CAPABLE).enforcement?.active).toBe(false);
  });
});

describe('ror status does not call the enforcement active when Claude Code would not run the hook', () => {
  const setLocal = (change: (settings: Record<string, unknown>) => void): void => {
    const settings = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;
    change(settings);
    writeFileSync(settingsFile(), JSON.stringify(settings));
  };

  beforeEach(async () => {
    await sync(env(), enrolment);
  });

  it('writes disableAllHooks: false in the local scope, which beats the project and the user', () => {
    expect(settings().disableAllHooks).toBe(false);
  });

  it('is not active with disableAllHooks: true in the local settings (and sync puts it back)', async () => {
    setLocal((value) => {
      value['disableAllHooks'] = true;
    });
    expect(status(project, CAPABLE).enforcement?.active).toBe(false);
    await sync(env(), enrolment);
    expect(status(project, CAPABLE).enforcement?.active).toBe(true);
  });

  it('is not active when the project’s, the user’s or the machine’s settings disable hooks', () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ disableAllHooks: true }),
    );
    expect(status(project, CAPABLE).enforcement).toMatchObject({ active: false });
    expect(status(project, CAPABLE).enforcement?.why).toContain('disableAllHooks');
    rmSync(join(project, '.claude', 'settings.json'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ allowManagedHooksOnly: true }),
    );
    expect(status(project, CAPABLE).enforcement?.active).toBe(false);
    rmSync(join(home, '.claude', 'settings.json'));
    expect(status(project, CAPABLE).enforcement?.active).toBe(true);
  });

  it('checks the registration, not just the marker: a hook that cannot block, or on another event, does not count', () => {
    setLocal((value) => {
      const hooks = value['hooks'] as { PreToolUse: { hooks: { onFailure?: string }[] }[] };
      delete hooks.PreToolUse[0]?.hooks[0]?.onFailure;
    });
    expect(status(project, CAPABLE).enforcement?.active).toBe(false);
    setLocal((value) => {
      const hooks = value['hooks'] as Record<string, unknown>;
      hooks['SessionStart'] = hooks['PreToolUse'];
      delete hooks['PreToolUse'];
    });
    expect(status(project, CAPABLE).enforcement?.active).toBe(false);
  });

  it('says it is an installation check, not proof about a running session', () => {
    expect(status(project, CAPABLE).enforcement?.why).toContain('installation check');
  });
});
