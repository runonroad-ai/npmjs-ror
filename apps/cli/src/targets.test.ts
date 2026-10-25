/**
 * Codex and Cursor on a device (ADR-0086) and derogations (ADR-0087): what `ror
 * sync` writes for each tool, what the hook decides, and how a lease lifts and
 * puts back a rule. The real tools are driven by the manual suites in
 * apps/api/src/testing/e2e; this file holds the cases that need no model.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBlock } from './testing/enrol.js';
import { loadEntries, type CodexHook } from './codex.js';
import { coverageOf, type Capabilities } from './coverage.js';
import {
  evaluate,
  patchPaths,
  type PolicyRule,
  type PolicyView,
  type ToolCall,
} from './evaluate.js';
import { runHook } from './hook.js';
import { installTimer, removeTimer } from './install.js';
import type { LoginContext } from './login.js';
import type { Enrolment } from './session.js';
import { saveEnrolment } from './testing/enrol.js';
import { fakeServer, KEY, type Fake } from './testing/fake-server.js';
import { status } from './status.js';
import { removeTarget, sync } from './sync.js';
import { installVerb } from './sync-command.js';
import { BusyError, withMachineLock } from './state.js';

// a TOML basic string writes `\` as `\\`: a Windows path is quoted before it is looked for
const quoted = (path: string): string => path.replaceAll('\\', '\\\\');

const rules = () => [
  {
    id: 'g@1.0.0:no-vault',
    source: 'g@1.0.0',
    kind: 'path',
    decision: 'forbid',
    reason: 'Credentials stay in the vault.',
    required: true,
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
  {
    id: 'g@1.0.0:ask-rm',
    source: 'g@1.0.0',
    kind: 'command',
    decision: 'ask',
    reason: 'Deleting recursively needs a derogation.',
    required: false,
    executable: 'rm',
    argv_prefix: [],
    flags_any: ['-rf'],
  },
];
const policy = (derogations: { rule_id: string; expires_at: string }[] = []) => ({
  schema_version: 1,
  principal: 'mem_lea',
  mcp_allow: [],
  rules: rules(),
  derogations,
});

const CODEX_OK: Capabilities = {
  sandbox: true,
  claudeVersion: undefined,
  codexVersion: '0.162.1',
  platform: 'linux',
};
const instruction = {
  op: 'write_file',
  path: '${project}/.runonroad/instructions/ror-governance.md',
  content: '# RunOnRoad governance\n<!-- Managed by RunOnRoad — do not edit -->\nNo vault.\n',
};

let fake: Fake;
let project: string;
let home: string;
let codexHome: string;
let enrolment: Enrolment;
const NOW = '2026-10-17T12:00:00.000Z';

const listed: CodexHook[] = [
  {
    key: 'k1',
    command: 'node hook --target codex --ror-managed',
    currentHash: 'sha256:aa',
    trustStatus: 'untrusted',
    enabled: true,
  },
  {
    key: 'k2',
    command: 'node main sync --target codex --ror-managed',
    currentHash: 'sha256:bb',
    trustStatus: 'untrusted',
    enabled: true,
  },
];
const env = (capabilities: Capabilities = CODEX_OK, now = NOW) => ({
  fetch,
  now: () => new Date(now),
  projectDir: project,
  capabilities,
  target: 'codex' as const,
  listHooks: () => Promise.resolve(listed),
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ror-tgt-home-'));
  project = mkdtempSync(join(tmpdir(), 'ror-tgt-project-'));
  codexHome = join(home, '.codex');
  process.env['RUNONROAD_HOME'] = join(home, '.runonroad');
  process.env['HOME'] = home;
  process.env['CODEX_HOME'] = codexHome;
  execFileSync('git', ['init', '-q'], { cwd: project });
  fake = await fakeServer();
  fake.next = {
    target: 'codex',
    operations: [instruction, { op: 'git_exclude', pattern: '.runonroad/' }],
    policy: policy(),
  };
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
  delete process.env['CODEX_HOME'];
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const config = (): string => readFileSync(join(codexHome, 'config.toml'), 'utf8');
const ruleFiles = (): string[] =>
  existsSync(join(codexHome, 'rules')) ? readdirSync(join(codexHome, 'rules')) : [];

describe('ror sync --target codex', () => {
  it('writes the instructions, the rules file, the profile, the hooks and the trust', async () => {
    const outcome = await sync(env(), enrolment);
    expect(outcome).toMatchObject({ status: 'applied', code: 0 });
    expect(outcome.instructions).toContain('No vault.');
    expect(ruleFiles()).toHaveLength(1);
    const text = readFileSync(join(codexHome, 'rules', ruleFiles()[0] ?? ''), 'utf8');
    expect(text).toContain('prefix_rule(pattern=["git", "push", "--force"], decision="forbidden"');
    expect(text).toContain('pattern=["rm", "-rf"], decision="forbidden"');
    const toml = config();
    expect(toml).toContain('default_permissions = "ror"');
    expect(toml).toContain(`permissions.ror.filesystem."${quoted(project)}/vault" = "none"`);
    expect(toml).toContain('[hooks.state."k1"]');
    expect(toml).toContain('trusted_hash = "sha256:aa"');
    const hooks = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { matcher: string; hooks: { command: string }[] }[]>;
    };
    expect(hooks.hooks['PreToolUse']?.[0]?.matcher).toBe('^(Bash|apply_patch|mcp__.*)$');
    expect(hooks.hooks['PreToolUse']?.[0]?.hooks[0]?.command).toContain('--ror-managed');
    expect(existsSync(join(project, '.runonroad', 'lock', 'codex.policy.json'))).toBe(true);
  });

  it('keeps the user’s own configuration and puts the profile keys before the first table', async () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), 'model = "x"\n\n[tui]\ntheme = "dark"\n');
    await sync(env(), enrolment);
    const toml = config();
    expect(toml.indexOf('default_permissions')).toBeLessThan(toml.indexOf('[tui]'));
    expect(toml).toContain('model = "x"');
    expect(toml).toContain('theme = "dark"');
    expect(toml.indexOf('[hooks.state')).toBeGreaterThan(toml.indexOf('[tui]'));
  });

  it('refuses to override a default_permissions the user already chose', async () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), 'default_permissions = "mine"\n');
    const outcome = await sync(env(), enrolment);
    expect(outcome.status).toBe('refused');
    expect(outcome.message).toContain('already sets default_permissions');
    expect(config()).toBe('default_permissions = "mine"\n');
  });

  it('refuses a policy whose required path rule Codex would not enforce', async () => {
    const outcome = await sync(env({ ...CODEX_OK, sandbox: false }), enrolment);
    expect(outcome.status).toBe('refused');
    expect(outcome.message).toContain('no-vault');
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(false);
  });

  it('refuses when Codex does not answer, since its hooks could not be trusted', async () => {
    const outcome = await sync(
      { ...env(), listHooks: () => Promise.resolve(undefined) },
      enrolment,
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.message).toContain('Codex did not answer');
  });

  it('pins one person per device for the tools that write to the home', async () => {
    await sync(env(), enrolment);
    const other = mkdtempSync(join(tmpdir(), 'ror-tgt-other-'));
    execFileSync('git', ['init', '-q'], { cwd: other });
    fake.next = { ...fake.next, policy: { ...policy(), principal: 'mem_max' } };
    const outcome = await sync({ ...env(), projectDir: other }, enrolment);
    expect(outcome.status).toBe('refused');
    expect(outcome.message).toContain('another person');
    rmSync(other, { recursive: true, force: true });
  });

  it('takes everything back when the last project goes', async () => {
    await sync(env(), enrolment);
    expect(removeTarget(project, 'codex').kept).toBe(0);
    expect(ruleFiles()).toHaveLength(0);
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false);
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(false);
    expect(existsSync(join(project, '.runonroad', 'lock', 'codex.json'))).toBe(false);
  });

  it('a lease lifts an Ask-first rule from the native files, and its end puts it back with no server', async () => {
    fake.next = {
      ...fake.next,
      policy: policy([{ rule_id: 'g@1.0.0:ask-rm', expires_at: '2026-10-17T13:00:00.000Z' }]),
    };
    await sync(env(), enrolment);
    const rulesFile = join(codexHome, 'rules', ruleFiles()[0] ?? '');
    expect(readFileSync(rulesFile, 'utf8')).not.toContain('"rm"');
    fake.server.close();
    const later = await sync(env(CODEX_OK, '2026-10-17T14:00:00.000Z'), enrolment);
    expect(later.message).toContain('a derogation ended');
    expect(readFileSync(rulesFile, 'utf8')).toContain('pattern=["rm", "-rf"]');
  });

  it('ror status lists a hand edit of the Codex home as drift', async () => {
    await sync(env(), enrolment);
    const trusted = ['k1', 'k2', 'k3', 'k4'].map((key) => ({
      ...listed[1],
      key,
      trustStatus: 'trusted' as const,
    })) as CodexHook[];
    expect(status(project, CODEX_OK, 'codex', trusted).drifted).toEqual([]);
    writeFileSync(
      join(codexHome, 'config.toml'),
      config().replace('default_permissions = "ror"', 'default_permissions = "hand"'),
    );
    const report = status(project, CODEX_OK, 'codex', trusted);
    expect(report.drifted.some((path) => path.includes('config.toml'))).toBe(true);
    expect(report.enforcement?.active).toBe(false);
  });
});

describe('ror sync --target cursor (experimental)', () => {
  it('writes the rule file, the hooks and the deny list, and never calls a rule enforced', async () => {
    fake.next = {
      target: 'cursor',
      operations: [
        {
          op: 'write_file',
          path: '${project}/.cursor/rules/ror-governance.mdc',
          content: '---\nalwaysApply: true\n---\n<!-- Managed by RunOnRoad -->\nNo vault.\n',
        },
      ],
      policy: policy(),
    };
    // the vault rule is required: Cursor cannot enforce it, so the policy is refused
    const refused = await sync({ ...env(), target: 'cursor' }, enrolment);
    expect(refused.status).toBe('refused');
    expect(refused.message).toContain('experimental');
    fake.next = {
      ...fake.next,
      policy: { ...policy(), rules: rules().map((rule) => ({ ...rule, required: false })) },
    };
    const outcome = await sync({ ...env(), target: 'cursor' }, enrolment);
    expect(outcome.status).toBe('applied');
    const hooks = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8')) as {
      version: number;
      hooks: Record<string, { command: string; failClosed: boolean }[]>;
    };
    expect(hooks.version).toBe(1);
    expect(hooks.hooks['beforeShellExecution']?.[0]).toMatchObject({ failClosed: true });
    expect(hooks.hooks['beforeShellExecution']?.[0]?.command).toContain(
      '--event beforeShellExecution',
    );
    const cli = JSON.parse(readFileSync(join(home, '.cursor', 'cli-config.json'), 'utf8')) as {
      permissions: { deny: string[] };
    };
    expect(cli.permissions.deny).toContain('Shell(git push)');
  });
});

describe('coverage by tool and system', () => {
  const vault = rules()[0] as unknown as PolicyRule;
  const deep = { ...vault, glob: '**/*.vlt' } as PolicyRule;
  it('Codex path rules are enforced by its profile, unless `**` goes deeper than Codex expands', () => {
    expect(coverageOf(vault, CODEX_OK, 'codex').status).toBe('enforced');
    expect(coverageOf(deep, CODEX_OK, 'codex').status).toBe('partial');
    expect(coverageOf(deep, { ...CODEX_OK, platform: 'darwin' }, 'codex').status).toBe('enforced');
    expect(coverageOf(vault, { ...CODEX_OK, sandbox: false }, 'codex').status).toBe('partial');
    expect(coverageOf(vault, { ...CODEX_OK, codexVersion: '0.1.0' }, 'codex').status).toBe(
      'uncertified',
    );
  });
  it('a command rule is partial everywhere and Cursor is never enforced', () => {
    const command = rules()[1] as unknown as PolicyRule;
    expect(coverageOf(command, CODEX_OK, 'codex').status).toBe('partial');
    expect(coverageOf(vault, CODEX_OK, 'cursor').status).toBe('experimental');
  });
});

describe('the hook for Codex', () => {
  const call = (tool_name: string, tool_input: Record<string, unknown>): string =>
    JSON.stringify({ tool_name, tool_input, cwd: project });

  it('lets every call through in a project RunOnRoad does not govern', () => {
    expect(runHook(call('Bash', { command: 'cat vault/x' }), new Date(NOW), 'codex')).toEqual({
      stdout: '',
      exitCode: 0,
    });
  });

  it('judges a governed project: shell, patch, and what it cannot read', async () => {
    await sync(env(), enrolment);
    const at = new Date(NOW);
    const verdict = (tool: string, input: Record<string, unknown>) =>
      JSON.parse(runHook(call(tool, input), at, 'codex').stdout || '{}') as {
        hookSpecificOutput?: { permissionDecision?: string };
      };
    const denied = (tool: string, input: Record<string, unknown>): boolean =>
      verdict(tool, input).hookSpecificOutput?.permissionDecision === 'deny';
    expect(denied('Bash', { command: 'cat vault/item.txt' })).toBe(true);
    expect(denied('Bash', { command: 'git push --force origin main' })).toBe(true);
    expect(denied('Bash', { command: 'ls' })).toBe(false);
    const patch = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch`;
    expect(denied('apply_patch', { command: patch('vault/new.txt') })).toBe(true);
    expect(denied('apply_patch', { command: patch('src/new.txt') })).toBe(false);
    expect(denied('apply_patch', { command: 'not a patch' })).toBe(true);
  });
});

describe('apply_patch', () => {
  it('reads every file a patch touches, moves included, and refuses what it does not know', () => {
    expect(
      patchPaths(
        '*** Begin Patch\n*** Add File: a\n+x\n*** Update File: b\n*** Move to: c\n@@\n-1\n+2\n*** Delete File: d\n*** End Patch\n',
      ),
    ).toEqual(['a', 'b', 'c', 'd']);
    expect(patchPaths('*** Begin Patch\n*** Frobnicate: x\n*** End Patch')).toBeUndefined();
    expect(patchPaths('*** Begin Patch\n*** Add File: a\n+x\n')).toBeUndefined();
    expect(patchPaths('no header')).toBeUndefined();
  });
});

describe('derogations in the hook', () => {
  const askRm = rules()[2] as unknown as PolicyRule;
  const forbid = rules()[1] as unknown as PolicyRule;
  const view = (lifted: string[], at: number): PolicyView => ({
    rules: [askRm, forbid],
    mcp_allow: [],
    derogations: lifted.map((rule_id) => ({ rule_id, expires_at_ms: at })),
  });
  const bash = (command: string): ToolCall => ({
    tool_name: 'Bash',
    tool_input: { command },
    cwd: '/p',
  });
  const roots = { project: '/p', home: '/h', ror: '/h/.runonroad' };
  const t = Date.parse(NOW);

  it('lifts an Ask-first rule only while the lease runs, by the hook’s own clock', () => {
    expect(evaluate(view([], t), bash('rm -rf build'), roots, t).allow).toBe(false);
    expect(evaluate(view([askRm.id], t + 1000), bash('rm -rf build'), roots, t).allow).toBe(true);
    expect(evaluate(view([askRm.id], t + 1000), bash('rm -rf build'), roots, t + 1000).allow).toBe(
      false,
    );
  });

  it('never lifts a forbid, even when a lease names it', () => {
    expect(evaluate(view([forbid.id], t + 1000), bash('git push --force'), roots, t).allow).toBe(
      false,
    );
  });
});

describe('TOML blocks', () => {
  it('puts top-level keys before the first table and leaves the user’s text alone', () => {
    const next = setBlock('a = 1\n[t]\nb = 2\n', 'hash', 'x', 'k.v = "1"', '/c.toml');
    expect(next.indexOf('k.v')).toBeLessThan(next.indexOf('[t]'));
    expect(next).toContain('a = 1');
  });
  it('appends a table block at the end', () => {
    const next = setBlock('a = 1\n[t]\nb = 2\n', 'hash', 'x', '[u]\nc = 3', '/c.toml');
    expect(next.indexOf('[u]')).toBeGreaterThan(next.indexOf('[t]'));
  });
  it('refuses a key the user already set', () => {
    expect(() => setBlock('k.v = 2\n', 'hash', 'x', 'k.v = "1"', '/c.toml')).toThrow(
      /already sets k\.v/u,
    );
  });
});

describe('a refused resync', () => {
  it('keeps the restrictions of the sync that succeeded before', async () => {
    await sync(env(), enrolment);
    const before = loadEntries(project);
    expect(before?.length).toBeGreaterThan(0);
    // the user takes the profile for themselves: our block goes, theirs arrives
    writeFileSync(join(codexHome, 'config.toml'), 'default_permissions = "mine"\n');
    const outcome = await sync(env(), enrolment);
    expect(outcome.status).toBe('refused');
    expect(loadEntries(project)).toEqual(before);
  });
});

describe('two projects on one device', () => {
  const another = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ror-tgt-two-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  };
  const shared = {
    id: 'g@1.0.0:no-ssh',
    source: 'g@1.0.0',
    kind: 'path',
    decision: 'forbid',
    reason: 'Keys stay home.',
    required: false,
    access: 'any',
    glob: '~/.ssh/**',
  };
  const withShared = () => ({ ...policy(), rules: [...rules(), shared] });

  it('writes a path both projects forbid once, so the profile stays valid TOML', async () => {
    fake.next = { ...fake.next, policy: withShared() };
    const second = another();
    await sync(env(), enrolment);
    await sync({ ...env(), projectDir: second }, enrolment);
    const keys = config()
      .split('\n')
      .filter((line) => line.includes(`"${quoted(home)}/.ssh"`));
    expect(keys).toHaveLength(1);
    expect(config()).toContain(`"${quoted(second)}/vault"`);
    expect(config()).toContain(`"${quoted(project)}/vault"`);
    rmSync(second, { recursive: true, force: true });
  });

  it('removing one project leaves the other’s rules, profile share, hooks and trust', async () => {
    const second = another();
    await sync(env(), enrolment);
    await sync({ ...env(), projectDir: second }, enrolment);
    removeTarget(project, 'codex');
    expect(config()).not.toContain(`"${quoted(project)}/vault"`);
    expect(config()).toContain(`"${quoted(second)}/vault"`);
    expect(config()).toContain('[hooks.state."k1"]');
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true);
    expect(ruleFiles()).toHaveLength(1);
    removeTarget(second, 'codex');
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(false);
    expect(ruleFiles()).toHaveLength(0);
    rmSync(second, { recursive: true, force: true });
  });
});

describe('a marker folder proves nothing to the hook', () => {
  it('a nested .runonroad does not make a governed project look ungoverned, and a stranger is left alone', async () => {
    await sync(env(), enrolment);
    mkdirSync(join(project, 'sub', '.runonroad'), { recursive: true });
    const at = (cwd: string) =>
      runHook(
        JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'cat ../vault/item.txt' },
          cwd,
        }),
        new Date(NOW),
        'codex',
      ).stdout;
    expect(at(join(project, 'sub'))).toContain('deny');
    expect(at(tmpdir())).toBe('');
  });
});

describe('the machine lock', () => {
  const lockDirectory = (): string => join(home, '.runonroad', 'sync.lock');
  const holder = (owner: Record<string, unknown>): void => {
    mkdirSync(lockDirectory(), { recursive: true });
    writeFileSync(join(lockDirectory(), 'pid'), JSON.stringify(owner));
  };

  it('is held by one writer at a time', () => {
    withMachineLock(() => {
      expect(() => withMachineLock(() => 1)).toThrow(BusyError);
    });
    expect(withMachineLock(() => 'ok')).toBe('ok');
  });

  it('replaces a holder whose process is gone, a legacy one included, and never a live one', () => {
    holder({ pid: 2 ** 31 - 2, at: Date.now(), token: 'old' });
    expect(withMachineLock(() => 'reclaimed')).toBe('reclaimed');
    holder({ pid: 2 ** 31 - 2, at: Date.now() });
    expect(withMachineLock(() => 'reclaimed legacy')).toBe('reclaimed legacy');
    holder({ pid: process.pid, at: Date.now(), token: 'alive' });
    expect(() => withMachineLock(() => 1)).toThrow(BusyError);
    rmSync(lockDirectory(), { recursive: true, force: true });
  });

  it('never removes a successor’s lock when it releases its own', () => {
    withMachineLock(() => {
      // the lock was taken over (judged stale by another process) while this one was still working
      rmSync(lockDirectory(), { recursive: true, force: true });
      holder({ pid: process.pid, at: Date.now(), token: 'successor' });
    });
    expect(existsSync(lockDirectory())).toBe(true);
    rmSync(lockDirectory(), { recursive: true, force: true });
  });
});

describe('the refresh timer of `ror install --timer`', () => {
  const timerLock = (): string => join(home, '.runonroad', 'user', '_install.timer.json');
  const locked = (): string[] =>
    existsSync(timerLock())
      ? (JSON.parse(readFileSync(timerLock(), 'utf8')) as { entries: { path: string }[] }).entries
          .map((entry) => entry.path)
          .sort()
      : [];
  const FILES = {
    linux: [
      '${home}/.config/systemd/user/ror-sync.service',
      '${home}/.config/systemd/user/ror-sync.timer',
    ],
    darwin: ['${home}/Library/LaunchAgents/ror-sync.plist'],
  } as const;

  beforeEach(() => {
    // no systemctl or launchctl to find: the files are written, never enabled on the machine running the tests
    vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'ror-no-bin-')));
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['linux', 'darwin'] as const)(
    '%s: the timer files are in the lock, and removing the timer takes them out',
    (os) => {
      installTimer(os);
      expect(locked()).toEqual([...FILES[os]].sort());
      expect(removeTimer(os)).toBe(true);
      expect(locked()).toEqual([]);
      for (const file of FILES[os]) expect(existsSync(file.replace('${home}', home))).toBe(false);
    },
  );

  it.each(['linux', 'darwin'] as const)('%s: a timer whose lock was lost installs again', (os) => {
    installTimer(os);
    rmSync(timerLock());
    expect(() => installTimer(os)).not.toThrow();
    expect(locked()).toEqual([...FILES[os]].sort());
  });

  it.skipIf(process.platform === 'win32')(
    'a timer file of the user is refused with an error line, not a stack trace',
    () => {
      const os = process.platform === 'darwin' ? 'darwin' : 'linux';
      const own = FILES[os][0].replace('${home}', home);
      mkdirSync(dirname(own), { recursive: true });
      writeFileSync(own, '[Unit]\n');
      const err: string[] = [];
      const context = { out: () => undefined, err: (line: string) => err.push(line) };
      expect(installVerb(['--timer'], context as unknown as LoginContext)).toBe(31);
      expect(err.join('\n')).toContain('is not managed by RunOnRoad');
      expect(readFileSync(own, 'utf8')).toBe('[Unit]\n');
    },
  );
});
